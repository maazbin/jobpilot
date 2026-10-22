// src/mcp/human-assisted-apply.js — Human-in-the-loop apply for flows gated by a CAPTCHA /
// Cloudflare / "verify you are human" challenge (Indeed SmartApply, Glassdoor Easy Apply which is
// SmartApply under the hood, and any ATS that throws an interstitial human-check).
//
// POLICY: we NEVER solve or bypass a CAPTCHA. When a VISIBLE human-check appears we stop, leave
// the tab open in the user's Chrome, and hand control to the user to click it. On a follow-up
// `resume` call we re-attach to that same tab (found by URL) and continue the application. All the
// non-human steps (resume selection, questions, review, submit) are driven automatically.
//
// Returns: { ok, result, detail, url }
//   result = 'submitted'            → application confirmed
//          | 'waiting_for_human'    → a human-check is on screen; user must click it, then call
//                                     this tool again with { resume: true } (same jobUrl)
//          | 'needs_answers'        → a question the engine can't answer (ask the user, learn, retry)
//          | 'no_apply' | 'error'   → nothing to drive / failed
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { textAnswer, choiceAnswer, coverText } from './answers.js';
import { encounter, askLater } from '../evolve.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const SMARTAPPLY_RE = /smartapply\.indeed\.com|indeedapply\/form/i;
// The SmartApply interstitial (.../beta/indeedapply/applybyapplyablejobid?...) matches
// SMARTAPPLY_RE but is NOT a form module yet — it redirects to .../beta/indeedapply/form/<module>.
// FORM_RE matches only the real module page.
const FORM_RE = /indeedapply\/form\//i;

// After the Apply click (or on resume) the SmartApply tab first lands on the interstitial, then
// redirects to a .../indeedapply/form/<module> URL. Poll the SmartApply tab's URL until it reaches
// a form module (or a terminal state the loop can handle) so we never fill/advance the interstitial
// or site-chrome. The tab object itself can change across the redirect, so re-find it each tick.
async function waitForFormModule(ctx, { timeoutMs = 15000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = await findSmartApplyTab(ctx);
  while (Date.now() < deadline) {
    const page = await findSmartApplyTab(ctx);
    if (page) {
      last = page;
      let url = '';
      try { url = page.url(); } catch {}
      if (FORM_RE.test(url)) return page;
      // If we've already reached a terminal state (confirmation or a visible human-check), stop
      // polling and let the step loop handle it.
      try { if (await confirmed(page)) return page; } catch {}
      try { if (await visibleHumanCheck(page)) return page; } catch {}
    }
    await SLEEP(500);
  }
  // Timed out — return the last page we saw (loop degrades gracefully: confirm/human-check/advance).
  return last;
}

// A VISIBLE human-check (not an invisible/enterprise reCAPTCHA badge that never challenges).
// Scans the top document AND every child frame, since the challenge iframe is usually nested.
async function visibleHumanCheck(page) {
  for (const fr of page.frames()) {
    try {
      const hit = await fr.evaluate(() => {
        const frames = [...document.querySelectorAll('iframe')];
        const challenge = frames.find(f => {
          const src = f.src || '';
          if (!/recaptcha.*bframe|hcaptcha.*challenge|turnstile|cloudflare|challenges\.cloudflare/i.test(src)) return false;
          const r = f.getBoundingClientRect();
          return r.width > 60 && r.height > 60;   // actually rendered, not the 0×0 invisible badge
        });
        if (challenge) return true;
        const txt = (document.body?.innerText || '').toLowerCase();
        return /verify you are human|confirm you are human|are you a robot|complete the (security )?check|i'm not a robot|checking your browser|just a moment/i.test(txt);
      }).catch(() => false);
      if (hit) return true;
    } catch {}
  }
  return false;
}

async function findSmartApplyTab(ctx) {
  for (const p of ctx.pages()) {
    try { if (SMARTAPPLY_RE.test(p.url())) return p; } catch {}
  }
  return null;
}

// SmartApply renders its form (resume selection, questions, review + "Submit your application")
// inside a child frame, not the top document. Find the frame that actually holds the apply
// controls so fill/advance/confirm operate where the form really lives. Falls back to the main
// frame. Returns a Playwright Frame.
async function contentFrame(page) {
  // Depth of a frame in the frame tree (mainFrame = 0). Used to prefer the deepest/most-specific
  // module frame over an outer wrapper when scores tie.
  const depthOf = fr => { let d = 0, f = fr; try { while (f && f.parentFrame && f.parentFrame()) { d++; f = f.parentFrame(); } } catch {} return d; };

  const candidates = [];
  for (const fr of page.frames()) {
    let url = '';
    try { url = fr.url() || ''; } catch {}
    // Never treat a captcha iframe as the form frame.
    if (/recaptcha|hcaptcha|turnstile/i.test(url)) continue;
    // Prefer real form-module frames; fall back to other smartapply frames that are not the
    // top/site-chrome frame (the mainFrame is the Indeed site chrome on the interstitial).
    const isForm = FORM_RE.test(url);
    const isSmart = /smartapply/i.test(url) && fr !== page.mainFrame();
    if (!isForm && !isSmart) continue;

    // Score = number of real form controls + whether a primary action exists. The primary-action
    // matcher mirrors clickAdvance() (data-testid OR text on the element or a nested span), and
    // explicitly excludes any reCAPTCHA control.
    const score = await fr.evaluate(() => {
      const controls = document.querySelectorAll('input:not([type=hidden]):not([name="g-recaptcha-response"]),select,textarea').length;
      const TID = /continue-button|form-action-continue|^continue$|submit|review|next/i;
      const TXT = /submit your application|submit application|^submit$|continue|review your application|^review$|^next$/i;
      const els = [...document.querySelectorAll('button, [role="button"], [data-testid]')];
      const hasAction = els.some(el => {
        if (el.disabled) return false;
        if (el.closest('.g-recaptcha, [data-testid*="recaptcha" i], iframe[src*="recaptcha" i]')) return false;
        if (el.id === 'g-recaptcha-response') return false;
        const tid = el.getAttribute('data-testid') || '';
        if (tid && TID.test(tid)) return true;
        const own = (el.innerText || '').trim();
        if (own && TXT.test(own)) return true;
        for (const sp of el.querySelectorAll('span')) { if (TXT.test((sp.textContent || '').trim())) return true; }
        return false;
      });
      return controls + (hasAction ? 1 : 0);
    }).catch(() => 0);

    if (score > 0) candidates.push({ fr, score, isForm, depth: depthOf(fr) });
  }

  if (candidates.length) {
    candidates.sort((a, b) => {
      if (a.isForm !== b.isForm) return a.isForm ? -1 : 1;   // form-module frames first
      if (b.score !== a.score) return b.score - a.score;      // most controls/action next
      return b.depth - a.depth;                               // deepest/most-specific on ties
    });
    return candidates[0].fr;
  }
  return page.mainFrame();
}

// Fill the fields on the current SmartApply step from profile + answer engine. Never touches the
// g-recaptcha-response field. Operates on a Frame (the SmartApply content frame). Returns the
// list of required questions it could NOT answer.
async function fillStep(frame) {
  const p = getProfile();
  const scan = await frame.evaluate(() => {
    // Read the nearest human-readable question text for an input whose <label for> is missing
    // (SmartApply's questions/review modules render the label in a SEPARATE element, not a
    // standard <label for>, and provide no aria-label/placeholder — so el.labels is empty).
    // Walk up to the question container and read its label/legend/heading/own text.
    const labelFromContainer = el => {
      let node = el.closest('[data-testid*="question" i], fieldset, [class*="question" i], [class*="Question" i]');
      if (!node) { node = el; for (let i = 0; i < 4 && node.parentElement; i++) node = node.parentElement; }
      if (!node) return '';
      const pick = sel => {
        for (const c of node.querySelectorAll(sel)) {
          const t = (c.innerText || c.textContent || '').trim();
          if (t && c !== el && !c.contains(el)) return t;
          if (t) return t;
        }
        return '';
      };
      let t = pick('label') || pick('legend') || pick('[data-testid*="label" i]') || pick('h1,h2,h3,h4');
      if (!t) {
        // Fall back to the container's own visible text, minus any control text.
        t = (node.innerText || node.textContent || '').trim();
      }
      return t;
    };
    const out = [];
    for (const el of document.querySelectorAll('input,select,textarea')) {
      if (el.type === 'hidden' || el.name === 'g-recaptcha-response') continue;
      const name = el.name || el.id || '';
      const testid = el.getAttribute('data-testid') || '';
      let label = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim();
      // q_<hash> SmartApply inputs: derive the question label from the surrounding container.
      if (!label && (/^q_[0-9a-f]+$/i.test(name) || /^input-q_[0-9a-f]+-input$/i.test(testid))) {
        label = labelFromContainer(el);
      }
      // Strip a trailing required-asterisk and collapse whitespace.
      label = label.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
      out.push({ tag: el.tagName, type: el.type || '', name, testid, label, required: el.required, value: el.value || '', checked: el.checked });
    }
    return out;
  }).catch(() => []);

  const unanswered = [];
  for (const f of scan) {
    const q = f.label || f.name;
    if (!q) continue;
    try {
      if (f.tag === 'SELECT') {
        if (f.value) continue;
        const a = choiceAnswer(q, []);
        if (a) await frame.selectOption(`[name="${f.name}"]`, { label: String(a) }).catch(() => {});
        else if (f.required) { unanswered.push(q); askLater(q); }
      } else if (f.type === 'radio' || f.type === 'checkbox') {
        // Radio/checkbox groups: let the engine pick an option label, click the matching control.
        const a = choiceAnswer(q, []);
        if (a) {
          const opt = frame.getByLabel(new RegExp(String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).first();
          await opt.check({ timeout: 2000 }).catch(() => {});
        }
      } else {
        if (f.value) continue;
        const ql = String(q).toLowerCase();
        const numeric = f.type === 'number' || /salary|years|experience|notice|how many|number/i.test(q);
        let a = textAnswer(q, { numeric });
        // Identity fallback from the profile when the answer engine comes up empty for a
        // SmartApply identity field whose label only lives in the container text.
        if (a == null || a === '') {
          if (/full name|your name|legal name|^name\b/.test(ql)) a = p.name || '';
          else if (/e-?mail/.test(ql)) a = p.email || '';
          else if (/phone|mobile|contact number|whatsapp/.test(ql)) a = numeric ? (p.phone || '').replace(/\D/g, '') : (p.phone || '');
        }
        // Required cover-letter free-text: never leave it blank. Prefer learned/engine text,
        // then a short profile-based cover line.
        if ((a == null || a === '') && /cover letter/.test(ql)) {
          a = textAnswer('cover letter', {}) || coverText(p) || '';
        }
        if (a != null && a !== '') {
          // SmartApply's question inputs are React-controlled: a bare locator.fill() sets the DOM
          // value but can skip React's onChange, so the component's state stays empty and the
          // Continue button treats the required field as blank (the form never advances). Type the
          // value as real keystrokes and blur so React registers it, then verify the value took —
          // the module is still hydrating when it first renders, so the first attempt can no-op.
          // Retry a few times (settling briefly) and fall back to fill() before giving up.
          // Target the SmartApply testid first (input-<name>-input), then the name attribute.
          const sel = f.name
            ? `[data-testid="input-${f.name}-input"], [name="${f.name}"]`
            : (f.testid ? `[data-testid="${f.testid}"]` : null);
          const loc = frame.locator(sel || `textbox`).first();
          let ok = false;
          for (let attempt = 0; attempt < 4 && !ok; attempt++) {
            try {
              await loc.click({ timeout: 2500 });
              await loc.fill('', { timeout: 2000 });
              await loc.pressSequentially(String(a), { delay: 30, timeout: 6000 });
              await loc.blur().catch(() => {});
            } catch {
              await loc.fill(String(a), { timeout: 2500 }).catch(() => {});
            }
            // Confirm React actually holds the value (read it back); retry if it didn't stick.
            try { ok = String(await loc.inputValue({ timeout: 1500 })).trim() !== ''; } catch { ok = false; }
            if (!ok) await SLEEP(800);
          }
          if (!ok && f.required) { unanswered.push(q); askLater(q); }
        } else if (f.required) { unanswered.push(q); askLater(q); }
      }
    } catch {}
  }
  return unanswered;
}

// Wait for a SmartApply module's real content to mount AND settle before we fill/advance it.
// SmartApply first paints a bare site-chrome shell (just the leftover Continue button and the
// hidden g-recaptcha textarea), then mounts the module's real fields a beat later. If we return
// the instant any action/control exists we scan the empty shell and never fill the questions, so
// the form never advances. Instead poll the signature {meaningful controls, has primary action}
// and only return once it has been STABLE across two consecutive reads (fields finished mounting)
// — or on a terminal state / timeout. Degrades gracefully.
async function waitForModuleContent(page, frame, { timeoutMs = 12000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  const read = () => frame.evaluate(() => {
    // Count only MEANINGFUL fillable controls — exclude the hidden-ish g-recaptcha-response
    // textarea and file inputs that render on the bare shell before the real inputs mount.
    const controls = [...document.querySelectorAll('input:not([type=hidden]),select,textarea')]
      .filter(el => el.name !== 'g-recaptcha-response' && el.type !== 'file'
        && (el.tagName !== 'INPUT' || !['radio', 'checkbox'].includes(el.type) || el.offsetParent !== null)).length;
    const TID = /continue-button|form-action-continue|submit|review|next/i;
    const TXT = /submit your application|submit application|^submit$|continue|review your application|^review$|^next$/i;
    const hasAction = [...document.querySelectorAll('button,[role="button"]')].some(el => {
      if (el.disabled) return false;
      if (el.id === 'g-recaptcha-response' || el.closest('.g-recaptcha, [data-testid*="recaptcha" i]')) return false;
      const tid = el.getAttribute('data-testid') || '';
      if (tid && TID.test(tid)) return true;
      const own = (el.innerText || '').trim();
      if (own && TXT.test(own)) return true;
      for (const sp of el.querySelectorAll('span')) { if (TXT.test((sp.textContent || '').trim())) return true; }
      return false;
    });
    return controls + '|' + (hasAction ? 1 : 0);
  }).catch(() => '');

  let prev = null;
  while (Date.now() < deadline) {
    // Confirmation / human-check can land here too — stop waiting and let the loop handle them.
    try { if (await confirmed(page)) return; } catch {}
    try { if (await visibleHumanCheck(page)) return; } catch {}
    const sig = await read();
    const [controls, action] = sig.split('|');
    // Ready = some meaningful control OR a primary action, AND the signature is stable (same as
    // the previous read) so we don't catch the module mid-mount.
    if (sig && (Number(controls) > 0 || action === '1') && sig === prev) return;
    prev = sig;
    await SLEEP(600);
  }
}

async function clickAdvance(frame, { timeoutMs = 9000 } = {}) {
  // Click Continue / Review / Submit — the SmartApply primary action, inside the content frame.
  // SmartApply addresses the button by data-testid (e.g. continue-button, form-action-continue)
  // and often puts the visible label on a nested <span>, so match by testid OR own/nested-span
  // text. NEVER match or click the reCAPTCHA control.
  //
  // SmartApply mounts each module's content (and its primary button) ASYNCHRONOUSLY after the
  // route transitions (e.g. /questions-module → /questions-module/questions/1): for the first
  // few seconds the page is bare site-chrome with no Continue in the DOM. Poll for the real
  // button up to timeoutMs so we don't give up on a page that simply hasn't finished rendering —
  // this is the fix for the spurious "could not find a Continue/Submit button" on form modules.
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const label = await _clickAdvanceOnce(frame);
    if (label) return label;
    if (Date.now() >= deadline) return null;
    await SLEEP(600);
  }
}

async function _clickAdvanceOnce(frame) {
  const inPage = await frame.evaluate(() => {
    const SUBMIT = /submit your application|submit application|^submit$/i;
    const CONT = /continue|review your application|^review$|^next$/i;
    const TID = /continue-button|form-action-continue|submit|review|next/i;
    const isCaptcha = el =>
      el.id === 'g-recaptcha-response' ||
      !!el.closest('.g-recaptcha, [data-testid*="recaptcha" i], iframe[src*="recaptcha" i]');
    const label = el => {
      const own = (el.innerText || '').trim();
      if (own) return own;
      for (const sp of el.querySelectorAll('span')) { const t = (sp.textContent || '').trim(); if (t) return t; }
      return (el.getAttribute('aria-label') || el.getAttribute('data-testid') || '').trim();
    };
    const textMatch = (el, re) => {
      const own = (el.innerText || '').trim();
      if (own && re.test(own)) return true;
      for (const sp of el.querySelectorAll('span')) { if (re.test((sp.textContent || '').trim())) return true; }
      return false;
    };
    // Only clickable controls (BUTTON / role=button), never the wrapper DIV/FIELDSET/LABEL that
    // SmartApply also tags with data-testid. A bare [data-testid] that is not a button is layout.
    // NB: do not filter on offsetParent — SmartApply's footer Continue is position:fixed, whose
    // offsetParent is null even though it is visible, which would wrongly exclude the real button.
    const clickable = [...document.querySelectorAll('button, [role="button"]')]
      .filter(el => !el.disabled && !isCaptcha(el));
    // SmartApply's canonical primary action — exact testids. Prefer these over the looser regex so
    // we hit the real footer button, not a duplicate/placeholder "hp-continue-button-N".
    const CANON = /^(continue-button|form-action-continue|submit-button|submit-application-button|review-button)$/i;
    // Prefer a final submit, then the canonical testid, then continue/review/next by testid or text.
    const pick = re =>
      clickable.find(el => { const tid = el.getAttribute('data-testid') || ''; return tid && re.test(tid); }) ||
      clickable.find(el => textMatch(el, re));
    const primary =
      pick(SUBMIT) ||
      clickable.find(el => CANON.test(el.getAttribute('data-testid') || '')) ||
      clickable.find(el => { const tid = el.getAttribute('data-testid') || ''; return tid && TID.test(tid); }) ||
      pick(CONT);
    if (primary) { const l = label(primary); primary.click(); return l || 'advance'; }
    return null;
  }).catch(() => null);
  if (inPage) return inPage;

  // Fallback: Playwright locator click works across the real (cross-origin) form frame where an
  // in-page document.click can be unreliable.
  for (const tid of ['form-action-continue', 'continue-button', 'submit-application-button', 'submit-button']) {
    try {
      const byTid = frame.getByTestId(tid).first();
      if (await byTid.count().catch(() => 0)) { await byTid.click({ timeout: 2500 }); return tid; }
    } catch {}
  }
  const NAME = /submit your application|submit application|continue|review your application|review|next/i;
  try {
    const byRole = frame.getByRole('button', { name: NAME }).first();
    if (await byRole.count().catch(() => 0)) {
      const txt = (await byRole.innerText().catch(() => '')).trim();
      await byRole.click({ timeout: 2500 });
      return txt || 'advance';
    }
  } catch {}
  return null;
}

// Confirmation can land in any frame — scan them all.
async function confirmed(page) {
  for (const fr of page.frames()) {
    try {
      const t = (await fr.evaluate(() => document.body?.innerText || '')).toLowerCase();
      if (/application submitted|your application has been submitted|successfully applied|application sent|thanks for applying|we('|’)ve received your application|has been submitted/i.test(t)) return true;
    } catch {}
  }
  return false;
}

/**
 * Drive an Indeed SmartApply (or Glassdoor Easy Apply) flow with human-assist for CAPTCHAs.
 * @param {object} a
 * @param {string} a.jobUrl   Indeed viewjob URL (or a SmartApply URL already open)
 * @param {boolean} a.resume  true → re-attach to the open SmartApply tab and continue after the
 *                            user has solved the on-screen human-check.
 */
export async function humanAssistedApply(args) {
  let pageRef = { page: null };
  const r = await _humanAssistedApply(args, pageRef);
  // Close the SmartApply tab on terminal outcomes to prevent tab leaks (72+ tabs choke Chrome).
  // Keep it open ONLY when we need the user to act and then resume on the same tab.
  if (r.result !== 'waiting_for_human' && r.result !== 'needs_answers') {
    try { await pageRef.page?.close(); } catch {}
  }
  return r;
}

async function _humanAssistedApply({ jobUrl, resume = false }, pageRef) {
  const ctx = await getContext();
  let page;

  if (resume) {
    page = await findSmartApplyTab(ctx);
    pageRef.page = page;
    if (!page) return { ok: false, result: 'error', detail: 'no open SmartApply tab to resume — start the apply again', url: jobUrl };
    await page.bringToFront().catch(() => {});
    // A resumed tab may still be on the interstitial — give it a chance to land on the form module
    // before the confirm/human-check/advance checks below run.
    page = (await waitForFormModule(ctx)) || page;
    pageRef.page = page;
    // If the human-check is still on screen, keep waiting.
    // Confirmation first: a solved reCAPTCHA leaves its (now-inert) challenge iframe in the DOM on
    // the post-apply page, which would otherwise look like a live human-check. If the application
    // is already confirmed, we are done regardless of leftover captcha frames.
    if (await confirmed(page)) {
      return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };
    }
    if (await visibleHumanCheck(page)) {
      return { ok: false, result: 'waiting_for_human', detail: 'Human-check still on screen — please click/solve it in the Chrome window, then resume again.', url: page.url() };
    }
  } else {
    page = await ctx.newPage();
    pageRef.page = page;
    page.setDefaultTimeout(15000);
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
    await SLEEP(3500);
    // Click the Indeed Apply button to enter SmartApply.
    const entered = await page.evaluate(() => {
      const b = document.querySelector('#indeedApplyButton, [class*="IndeedApplyButton"] button, button[aria-label*="Apply" i]')
        || [...document.querySelectorAll('a,button')].find(x => /^apply now$|^apply$/i.test((x.innerText || '').trim()));
      if (b) { b.click(); return true; }
      return false;
    }).catch(() => false);
    if (!entered) return { ok: false, result: 'no_apply', detail: 'no Indeed Apply button on this posting', url: jobUrl };
    await SLEEP(6000);
    const sa = await findSmartApplyTab(ctx);
    if (sa) { page = sa; pageRef.page = sa; }
    // Wait for the interstitial (applybyapplyablejobid) to redirect to a real form module before
    // the step loop tries to fill/advance — the fixed SLEEP above does not guarantee the redirect.
    page = (await waitForFormModule(ctx)) || page;
    pageRef.page = page;
  }

  // Walk the multi-step form. Stop and hand off the moment a VISIBLE human-check appears.
  for (let step = 0; step < 10; step++) {
    await SLEEP(2000);

    // Confirmation BEFORE human-check: a solved captcha leaves its challenge iframe in the DOM on
    // the confirmation page, so checking the captcha first would falsely re-pause a finished apply.
    if (await confirmed(page)) {
      return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };
    }

    if (await visibleHumanCheck(page)) {
      await encounter('human_check', 'visible CAPTCHA/Cloudflare on ' + (page.url().match(/[^/]+\/\/[^/]+/) || [''])[0], { url: page.url(), page }).catch(() => {});
      return {
        ok: false,
        result: 'waiting_for_human',
        detail: '🧑 Human-check on screen (CAPTCHA/Cloudflare). Please click/solve it in the debug Chrome window, then call this tool again with resume:true to continue the application.',
        url: page.url(),
      };
    }

    // SmartApply mounts a module's fields + primary button a few seconds AFTER the route
    // transitions (the bare /questions-module shell renders first with no controls). Wait for the
    // module content to settle so fillStep operates on the real fields, not the empty shell —
    // otherwise required questions go unfilled and the Continue button never enables.
    let frame = await contentFrame(page);
    await waitForModuleContent(page, frame);
    frame = await contentFrame(page);
    const unanswered = await fillStep(frame);
    if (unanswered.length) {
      return { ok: false, result: 'needs_answers', detail: 'needs your answer: ' + unanswered.slice(0, 4).join(' | ').slice(0, 300), questions: unanswered, url: page.url() };
    }

    // On the review/questions module the required fields just got filled — re-check whether the
    // canonical "Submit your application" button is now ENABLED and, if so, click it directly.
    // If it exists but is still disabled, fall through to clickAdvance + confirmed +
    // visibleHumanCheck handling (a genuine captcha gate still returns waiting_for_human).
    try {
      const submit = frame.getByTestId('submit-application-button').first();
      if (await submit.count().catch(() => 0)) {
        const disabled = await submit.evaluate(
          el => el.disabled || el.getAttribute('aria-disabled') === 'true'
        ).catch(() => true);
        if (!disabled) { await submit.click({ timeout: 4000 }).catch(() => {}); continue; }
      }
    } catch {}

    const advanced = await clickAdvance(frame);
    if (!advanced) {
      // No primary button and no confirmation — either done, gated by a human-check, or stuck.
      await SLEEP(1500);
      if (await confirmed(page)) return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };
      // SmartApply's review/submit step gates the "Submit your application" control behind a
      // VISIBLE reCAPTCHA: the submit button is not rendered/enabled until the user solves it, so
      // clickAdvance legitimately finds no button. That is a human-check hand-off, NOT the
      // button-not-found bug — detect the (possibly just-rendered) visible captcha here and wait
      // for the human, per POLICY, instead of erroring out.
      if (await visibleHumanCheck(page)) {
        await encounter('human_check', 'visible CAPTCHA/Cloudflare on ' + (page.url().match(/[^/]+\/\/[^/]+/) || [''])[0], { url: page.url(), page }).catch(() => {});
        return {
          ok: false,
          result: 'waiting_for_human',
          detail: '🧑 Human-check on screen (CAPTCHA/Cloudflare). Please click/solve it in the debug Chrome window, then call this tool again with resume:true to continue the application.',
          url: page.url(),
        };
      }
      return { ok: false, result: 'error', detail: 'could not find a Continue/Submit button to advance', url: page.url() };
    }
    // If we just clicked the final submit, a human-check often fires right here — the loop's next
    // iteration detects it and hands off.
  }

  if (await confirmed(page)) return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };
  return { ok: false, result: 'error', detail: 'flow did not reach a confirmation after 10 steps', url: page.url() };
}
