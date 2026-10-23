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
import { textAnswer, choiceAnswer } from './answers.js';
import { encounter, askLater } from '../evolve.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

/**
 * Given a radio/checkbox group and the label the answer engine picked, return the option `value`
 * that should be checked. Pure (no DOM / Playwright), so it is unit-testable. Matches the picked
 * label to an option by exact label, then case-insensitive label, then value, then substring.
 *
 * @param {{name:string, options:{value:string,label:string,checked?:boolean}[]}} group
 * @param {string} pickedLabel  the label choiceAnswer returned
 * @returns {string|null} the value to check, or null if no option matches
 */
export function chooseRadioValue(group, pickedLabel) {
  if (!group || !Array.isArray(group.options) || !group.options.length) return null;
  const want = String(pickedLabel == null ? '' : pickedLabel).trim();
  if (!want) return null;
  const lc = want.toLowerCase();
  const byExact = group.options.find(o => String(o.label || '').trim() === want);
  if (byExact) return byExact.value;
  const byCi = group.options.find(o => String(o.label || '').trim().toLowerCase() === lc);
  if (byCi) return byCi.value;
  const byVal = group.options.find(o => String(o.value || '').trim().toLowerCase() === lc);
  if (byVal) return byVal.value;
  const bySub = group.options.find(o => String(o.label || '').trim().toLowerCase().includes(lc)
    || lc.includes(String(o.label || '').trim().toLowerCase()));
  return bySub ? bySub.value : null;
}
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
  // Scan the step into (a) a flat list of SELECT/text fields, and (b) a map of radio/checkbox
  // groups keyed by `name`, each carrying the real option labels + the group's question text.
  const scan = await frame.evaluate(() => {
    const textOf = el => {
      // Visible label for a control: its <label>, aria-label, placeholder, or nearest wrapping
      // <label>/preceding text. Used both for option labels and for the group question.
      let t = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || '').trim();
      if (t) return t;
      const wrap = el.closest('label');
      if (wrap) { t = (wrap.innerText || '').trim(); if (t) return t; }
      const prev = el.previousElementSibling;
      if (prev) { t = (prev.innerText || prev.textContent || '').trim(); if (t) return t; }
      return '';
    };
    // The question a group belongs to: nearest <fieldset>'s <legend>, else a preceding heading/
    // question-like element, else the first option's label.
    const groupQuestion = el => {
      const fs = el.closest('fieldset');
      if (fs) { const lg = fs.querySelector('legend'); const t = (lg?.innerText || '').trim(); if (t) return t; }
      let node = el.closest('[role="group"], div, section') || el.parentElement;
      for (let i = 0; node && i < 4; i++, node = node.parentElement) {
        const h = node.querySelector && node.querySelector('legend, h1, h2, h3, h4, label, [class*="question" i], [class*="label" i]');
        if (h) { const t = (h.innerText || h.textContent || '').trim(); if (t && t.length > 2) return t; }
      }
      return '';
    };

    const fields = [];
    const groups = {};
    for (const el of document.querySelectorAll('input,select,textarea')) {
      if (el.type === 'hidden' || el.name === 'g-recaptcha-response') continue;
      if (el.type === 'radio' || el.type === 'checkbox') {
        const name = el.name || el.id || '';
        if (!name) continue;
        const g = groups[name] || (groups[name] = { name, type: el.type, question: '', options: [], required: false });
        g.options.push({ value: el.value || '', label: textOf(el) || el.value || '', checked: !!el.checked });
        if (el.required) g.required = true;
        if (!g.question) g.question = groupQuestion(el);
        continue;
      }
      fields.push({ tag: el.tagName, type: el.type || '', name: el.name || el.id || '', label: textOf(el), required: el.required, value: el.value || '', options: el.tagName === 'SELECT' ? [...el.options].map(o => (o.text || o.value || '').trim()).filter(Boolean) : [] });
    }
    return { fields, groups: Object.values(groups) };
  }).catch(() => ({ fields: [], groups: [] }));

  const unanswered = [];

  // ── Radio / checkbox groups: pick a real option label, select by name+value with verified
  //    click + dispatched React events, fall back to Playwright .check(), then verify .checked.
  for (const g of scan.groups || []) {
    const q = g.question || g.name;
    if (!q) continue;
    if (g.options.some(o => o.checked)) continue; // already answered (e.g. harvested/prefilled)
    try {
      const picked = choiceAnswer(q, g.options.map(o => o.label));
      if (!picked) { if (g.required) { unanswered.push(q); askLater(q); } continue; }
      const value = chooseRadioValue(g, picked);

      // (a)+(b) in-frame: find input by name+value (or by matching label text), set checked and
      // dispatch click/input/change so React's controlled state updates and Continue enables.
      const okInFrame = await frame.evaluate(({ name, value, label }) => {
        const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
        let input = null;
        if (value != null) input = document.querySelector(`input[name="${esc(name)}"][value="${esc(value)}"]`);
        if (!input) {
          const inputs = [...document.querySelectorAll(`input[name="${esc(name)}"]`)];
          const want = String(label || '').trim().toLowerCase();
          input = inputs.find(el => {
            const t = (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.closest('label')?.innerText || el.value || '').trim().toLowerCase();
            return t === want || (want && t.includes(want));
          }) || null;
        }
        if (!input) return false;
        input.checked = true;
        for (const ev of ['input', 'change', 'click']) input.dispatchEvent(new Event(ev, { bubbles: true }));
        return input.checked === true;
      }, { name: g.name, value, label: picked }).catch(() => false);

      if (!okInFrame) {
        // Playwright fallback: locator by name+value, else by label.
        let checked = false;
        if (value != null) {
          try {
            const byVal = frame.locator(`input[name="${g.name}"][value="${String(value).replace(/"/g, '\\"')}"]`).first();
            if (await byVal.count().catch(() => 0)) { await byVal.check({ timeout: 2000 }); checked = true; }
          } catch {}
        }
        if (!checked) {
          try {
            const re = new RegExp(String(picked).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
            await frame.getByLabel(re).first().check({ timeout: 2000 });
          } catch {}
        }
      }

      // Verify a required group ended with a checked option; otherwise park it.
      const nowChecked = await frame.evaluate(name => {
        const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
        return [...document.querySelectorAll(`input[name="${esc(name)}"]`)].some(el => el.checked);
      }, g.name).catch(() => false);
      if (!nowChecked && g.required) { unanswered.push(q); askLater(q); }
    } catch {}
  }

  // ── SELECT + text/number fields.
  for (const f of scan.fields || []) {
    const q = f.label || f.name;
    if (!q) continue;
    try {
      if (f.tag === 'SELECT') {
        if (f.value) continue;
        const a = choiceAnswer(q, f.options || []);
        if (a) await frame.selectOption(`[name="${f.name}"]`, { label: String(a) }).catch(() => {});
        else if (f.required) { unanswered.push(q); askLater(q); }
      } else {
        if (f.value) continue;
        const numeric = f.type === 'number' || /salary|years|experience|notice|how many|number/i.test(q);
        const a = textAnswer(q, { numeric });
        if (a != null && a !== '') {
          const loc = frame.locator(f.name ? `[name="${f.name}"]` : `textbox`).first();
          await loc.fill(String(a), { timeout: 2500 }).catch(() => {});
          // SmartApply is React-controlled: dispatch input+change so the filled value registers
          // and the Continue button enables.
          if (f.name) {
            await frame.evaluate(name => {
              const esc = s => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));
              const el = document.querySelector(`[name="${esc(name)}"]`);
              if (el) for (const ev of ['input', 'change']) el.dispatchEvent(new Event(ev, { bubbles: true }));
            }, f.name).catch(() => {});
          }
        } else if (f.required) { unanswered.push(q); askLater(q); }
      }
    } catch {}
  }
  return unanswered;
}

async function clickAdvance(frame) {
  // Click Continue / Review / Submit — the SmartApply primary action, inside the content frame.
  // SmartApply addresses the button by data-testid (e.g. continue-button, form-action-continue)
  // and often puts the visible label on a nested <span>, so match by testid OR own/nested-span
  // text. NEVER match or click the reCAPTCHA control.
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
    const CANON = /^(continue-button|form-action-continue|submit-button|review-button)$/i;
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
  for (const tid of ['form-action-continue', 'continue-button', 'submit-button']) {
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

// When clickAdvance() finds no ENABLED primary, check whether a DISABLED primary exists (same
// CANON/TID/text matchers, but without the `!el.disabled` filter). This distinguishes "the
// Continue button is there but disabled pending required answers" from "there is no button at
// all", so the step loop can surface a clean, specific message instead of the generic error.
// Scan EVERY frame for a disabled primary. The review-module submit button lives in the top
// SmartApply frame, which contentFrame() can score to 0 (no inputs + a disabled action) and skip,
// so checking only the chosen content frame misses it.
async function anyFrameDisabledPrimary(page) {
  for (const fr of page.frames()) {
    try {
      let u = ''; try { u = fr.url() || ''; } catch {}
      if (/recaptcha|hcaptcha|turnstile/i.test(u)) continue;
      if (await findDisabledPrimary(fr)) return true;
    } catch {}
  }
  return false;
}

async function findDisabledPrimary(frame) {
  return await frame.evaluate(() => {
    const SUBMIT = /submit your application|submit application|^submit$/i;
    const CONT = /continue|review your application|^review$|^next$/i;
    const TID = /continue-button|form-action-continue|submit|review|next/i;
    const CANON = /^(continue-button|form-action-continue|submit-button|review-button)$/i;
    const isCaptcha = el =>
      el.id === 'g-recaptcha-response' ||
      !!el.closest('.g-recaptcha, [data-testid*="recaptcha" i], iframe[src*="recaptcha" i]');
    const textMatch = (el, re) => {
      const own = (el.innerText || '').trim();
      if (own && re.test(own)) return true;
      for (const sp of el.querySelectorAll('span')) { if (re.test((sp.textContent || '').trim())) return true; }
      return false;
    };
    const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(el => !isCaptcha(el));
    const match = el => {
      const tid = el.getAttribute('data-testid') || '';
      if (tid && (CANON.test(tid) || TID.test(tid))) return true;
      return textMatch(el, SUBMIT) || textMatch(el, CONT);
    };
    return buttons.some(el => el.disabled && match(el));
  }).catch(() => false);
}

// A reCAPTCHA/hCaptcha/Turnstile frame is PRESENT on the page (any size), even if not yet showing
// a visible challenge. On the SmartApply review module the "Submit your application" button stays
// DISABLED until an (often invisible/enterprise) reCAPTCHA resolves, and the visible challenge only
// appears after a submit attempt. When we see a disabled submit together with a captcha frame we
// must hand off to the human rather than report a generic error — we never solve the captcha.
async function captchaFramePresent(page) {
  for (const fr of page.frames()) {
    try {
      const u = fr.url() || '';
      if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare/i.test(u)) return true;
    } catch {}
  }
  return false;
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

    const frame = await contentFrame(page);
    const unanswered = await fillStep(frame);
    if (unanswered.length) {
      return { ok: false, result: 'needs_answers', detail: 'needs your answer: ' + unanswered.slice(0, 4).join(' | ').slice(0, 300), questions: unanswered, url: page.url() };
    }

    const advanced = await clickAdvance(frame);
    if (!advanced) {
      // No ENABLED primary and no confirmation — either done, or the Continue button is present
      // but disabled pending answers. Give the page a beat, then disambiguate.
      await SLEEP(1500);
      if (await confirmed(page)) return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };

      const disabledPrimary = await anyFrameDisabledPrimary(page);
      if (disabledPrimary) {
        if (unanswered.length) {
          // A required question we couldn't answer from the profile left Continue disabled →
          // log it to the dashboard Questions tab rather than a generic error.
          return { ok: false, result: 'needs_answers', detail: 'needs your answer: ' + unanswered.slice(0, 4).join(' | ').slice(0, 300), questions: unanswered, url: page.url() };
        }
        // Everything answered, yet the primary stayed disabled. On the SmartApply review module the
        // "Submit your application" button is gated behind a reCAPTCHA that is often invisible until
        // a submit attempt. If a captcha frame is present, this is a human-check hand-off, not an
        // error — the user solves it in the Chrome window, then we resume.
        if (await captchaFramePresent(page)) {
          await encounter('human_check', 'reCAPTCHA-gated submit on ' + (page.url().match(/[^/]+\/\/[^/]+\/[^?]*/) || [''])[0], { url: page.url(), page }).catch(() => {});
          return {
            ok: false,
            result: 'waiting_for_human',
            detail: '🧑 The Submit button is gated by a reCAPTCHA. Please complete the "I\'m not a robot" / verification in the debug Chrome window, then call this tool again with resume:true to finish submitting.',
            url: page.url(),
          };
        }
        // No captcha and still disabled — specific + debuggable.
        return { ok: false, result: 'error', detail: 'Primary (Continue/Submit) stayed disabled after filling required answers', url: page.url() };
      }
      return { ok: false, result: 'error', detail: 'could not find a Continue/Submit button to advance', url: page.url() };
    }
    // If we just clicked the final submit, a human-check often fires right here — the loop's next
    // iteration detects it and hands off.
  }

  if (await confirmed(page)) return { ok: true, result: 'submitted', detail: 'Application submitted + confirmed', url: page.url() };
  return { ok: false, result: 'error', detail: 'flow did not reach a confirmation after 10 steps', url: page.url() };
}
