// src/mcp/easyapply.js — LinkedIn Easy Apply driver (2026 UI: native <dialog>, obfuscated classes).
// Self-evolving:
//   • HARVESTS every prefilled answer LinkedIn shows (= your past answers) into evolution memory
//   • unknown required questions → "questions for you" (asked once, reused forever)
//   • anything unexpected → an encounter with a DOM snapshot for the coding agent to fix
//   • success is VERIFIED by reloading the job and reading "Application submitted"
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { textAnswer, choiceAnswer, salaryFor } from './answers.js';
import { learn, askLater, encounter } from '../evolve.js';
import fs from 'fs';
import { cvAttachmentForJob, selectCvVariant } from '../cv.js';
import { setFields } from '../tracker.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const APPLIED_RE = /Application submitted|Applied \d+ (second|minute|hour|day)s? ago|You applied|application was sent/i;
const LINKEDIN_THROTTLE_RE = /security check|security verification|unusual activity|doing that too (much|often|fast)|try again later|rate limit|temporarily (restricted|blocked)|verify you.?re a human|captcha|\/checkpoint\//i;

// The Easy Apply control can remain visible while a LinkedIn checkpoint/overlay intercepts
// clicks. Retry briefly, then classify the state as a throttle instead of burning the job's
// attempts on the same 15-second locator timeout.
async function clickEasyApplyControl(page, control) {
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await control.isVisible().catch(() => false))) break;
    try {
      await control.click({ timeout: 5000 });
      return { ok: true };
    } catch (e) {
      lastError = e?.message || String(e);
      const state = `${await page.locator('body').innerText().catch(() => '')} ${page.url()}`;
      if (LINKEDIN_THROTTLE_RE.test(state)) return { ok: false, throttled: true, detail: 'LinkedIn security check / rate limit intercepted Easy Apply' };
      await SLEEP(500);
    }
  }
  return { ok: false, throttled: false, detail: lastError || 'Easy Apply control was not clickable' };
}

// LinkedIn can open the native dialog before its form is hydrated. During that interval the
// dialog contains only a loader (and its Dismiss button), so filtering dialogs by Next/Review/
// Submit incorrectly reports a real Easy Apply dialog as "not open". Keep the dialog handle
// broad, then wait for the form controls to hydrate before handing it to the scanner.
async function waitForEasyApplyDialog(page, timeout = 18000) {
  const dlg = page.locator('dialog[open], [role="dialog"]:visible').first();
  await dlg.waitFor({ state: 'visible', timeout }).catch(() => {});
  if (!(await dlg.isVisible().catch(() => false))) return null;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const text = await dlg.innerText().catch(() => '');
    if (/safety reminder|safety tips|continue applying|apply to /i.test(text)) {
      const action = dlg.getByRole('button', { name: /next|review|submit|continue/i }).first();
      const link = dlg.getByRole('link', { name: /continue applying/i }).first();
      if (await action.isVisible().catch(() => false) || await link.isVisible().catch(() => false)) return dlg;
    }
    const loader = dlg.locator('[data-testid="loader"], [role="progressbar"]').first();
    if (!(await loader.isVisible().catch(() => false))) {
      const action = dlg.getByRole('button', { name: /next|review|submit|continue/i }).first();
      if (await action.isVisible().catch(() => false)) return dlg;
    }
    await SLEEP(500);
  }
  return dlg;
}

// In-page: tag every field in the dialog and describe it.
const SCAN = (dlg) => {
  const qOf = (el) => {
    const root = el.getRootNode();
    if (el.type !== 'radio' && el.type !== 'checkbox' && el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.innerText.trim()) return l.innerText;
    }
    const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg?.innerText.trim()) return lg.innerText;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.type === 'radio' || el.type === 'checkbox') {
      // walk up past the options block to the first line that is real question text
      let p = el.parentElement;
      for (let i = 0; i < 10 && p && p !== dlg; i++, p = p.parentElement) {
        const line = (p.innerText || '').split('\n').map(s => s.trim()).find(s => s.length > 8 && !/^(yes|no)$/i.test(s));
        if (line && p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length < 12) return line;
      }
    }
    let p = el.parentElement;
    for (let i = 0; i < 8 && p && p !== dlg; i++, p = p.parentElement) {
      const t = (p.innerText || '').trim();
      if (t.length > 3 && t.length < 600 && (/[?*]/.test(t) || p.querySelectorAll('input,select,textarea').length > 1)) return t.split('\n').find(s => s.trim().length > 3) || t;
    }
    return el.placeholder || el.name || '';
  };
  const out = []; let i = 0; const nonce = Math.random().toString(36).slice(2, 7);
  for (const el of dlg.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || el.disabled) continue;
    const id = 'ja' + nonce + (i++); el.setAttribute('data-ja', id);
    const root = el.getRootNode();
    const lbl = el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const q = (qOf(el) || '').replace(/\s+/g, ' ').trim();
    out.push({
      id, tag: el.tagName, type: el.type, name: el.name, role: el.getAttribute('role') || '',
      q: q.replace(/\s*\*\s*$/, '').slice(0, 300),
      elId: el.id,
      optLabel: ((el.closest('[role="radio"]')?.innerText || '').trim() || lbl?.innerText.trim() || el.closest('label')?.innerText.trim() || (el.value && el.value !== 'on' ? el.value : '') || el.closest('[role="radio"]')?.getAttribute('aria-label') || '').trim().split('\n')[0],
      val: el.tagName === 'SELECT' ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '') : (el.value || ''),
      checked: !!el.checked,
      opts: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(q),
      numeric: el.type === 'number' || /numeric/i.test(el.id) || el.getAttribute('inputmode') === 'numeric',
      maxlength: (() => { const m = parseInt(el.getAttribute('maxlength')); return Number.isFinite(m) && m > 0 ? m : 0; })(),
      grpIdx: (() => {
        if (el.type !== 'radio' && el.type !== 'checkbox') return -1;
        const fsAnc = el.closest('fieldset, [role="group"], [role="radiogroup"]');
        if (!fsAnc) return -1;
        return [...dlg.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')].indexOf(fsAnc);
      })(),
    });
  }
  // Per-fieldset metadata for BARE radio/checkbox groups (no name/aria-label/label), e.g. the
  // timezone multi-select: derive the question from the nearest heading before the fieldset and
  // the options from the fieldset's text lines.
  const groupByIdx = {};
  try {
    [...dlg.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')].forEach((fsEl, gi) => {
      const inputs = fsEl.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      if (inputs.length < 2) return;
      let question = (inputs[0].getAttribute('aria-label') || fsEl.querySelector('legend')?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!question) {
        let host = fsEl, hops = 0;
        while (host && hops < 5 && !question) {
          const prev = host.previousElementSibling;
          const t = (prev?.innerText || '').trim();
          if (t && t.length < 240 && /\?|time ?zone|which|select|country|language|able to work|hands-on|experience/i.test(t)) question = t.split('\n').pop().trim();
          host = host.parentElement; hops++;
        }
      }
      const qn = question.toLowerCase().replace(/\*+$/, '').trim();
      const lines = (fsEl.innerText || '').split('\n').map(s => s.trim()).filter(s => s && s.length < 40 && s.toLowerCase().replace(/\*+$/, '').trim() !== qn);
      const containerText = fsEl.parentElement?.innerText || '';
      groupByIdx[gi] = {
        question: question.slice(0, 120),
        options: [...new Set(lines)].slice(0, inputs.length),
        isCheckbox: inputs[0].type === 'checkbox',
        // LinkedIn puts the required marker/error on the fieldset wrapper, not on the
        // hidden checkbox inputs. Preserve that group-level requirement for validation.
        required: fsEl.getAttribute('aria-required') === 'true' || /this field is required/i.test(containerText),
      };
    });
  } catch {}
  // For radio groups whose option labels are not on the inputs (2026 LinkedIn), capture the
  // ordered list of visible option texts that follow each question heading, so multi-option
  // radios (e.g. English: Native/Fluent, Advanced, …) can be matched by position.
  const radioGroupOptions = {};
  try {
    for (const fsEl of dlg.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')) {
      const inputs = fsEl.querySelectorAll('input[type="radio"]');
      if (inputs.length < 2) continue;
      const q = (inputs[0].getAttribute('aria-label') || fsEl.querySelector('legend')?.innerText || '').replace(/\s+/g, ' ').trim();
      if (!q) continue;
      // Option texts: 2026 LinkedIn renders them as bare text nodes/lines inside the fieldset
      // (not in <label>/<span> with innerText). Parse the fieldset's innerText into lines,
      // drop the question line and empties, and keep the first N lines = the ordered options.
      const qNorm = q.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\*+$/, '').trim();
      const lines = (fsEl.innerText || '').split('\n').map(s => s.trim())
        .filter(s => s && s.length < 40 && s.replace(/\*+$/, '').trim().toLowerCase() !== qNorm);
      // also try explicit label/span texts as a fallback source
      const nodeTexts = [...fsEl.querySelectorAll('label, span')].map(e => (e.innerText || '').trim()).filter(t => t && t.length < 40 && t.toLowerCase() !== qNorm);
      const uniq = [...new Set([...lines, ...nodeTexts])];
      if (uniq.length >= inputs.length) radioGroupOptions[q.slice(0, 120)] = uniq.slice(0, inputs.length);
    }
  } catch {}
  const errors = [...dlg.querySelectorAll('[role="alert"], [aria-live], .artdeco-inline-feedback--error')]
    .map(e => e.innerText.trim()).filter(t => t && /required|valid|enter|select|must|between|larger|smaller|whole number|decimal/i.test(t));
  const text = dlg.innerText.replace(/\s+/g, ' ');
  // LinkedIn alternates between "1/6 pages", "16%", and
  // "16 percent complete". Keep all forms so a validation-blocked page is
  // recognized as unchanged and its missing required fields can be surfaced.
  return { fields: out, errors, radioGroupOptions, groupByIdx, progress: (text.match(/(\d+)\/(\d+) pages|(\d+)%|(\d+)\s+percent\s+complete/i) || [''])[0], heading: (dlg.querySelector('h3, h2')?.innerText || '').trim(), text: text.slice(0, 300) };
};

const IDENTITY = /^(email|phone|mobile|first name|last name|city|location|country code|phone country code)/i;

// OPTIONAL consent / marketing / follow checkboxes. These are never truly required to submit a
// LinkedIn Easy Apply, so they must NEVER be parked as "needs your answer" (that was the main
// cause of "opens Easy Apply but never submits" — one optional marketing opt-in blocked the whole
// application). We simply leave them unchecked and move on.
const OPTIONAL_CONSENT = /allow(ing)?\b.*\bcontact|contact me about|marketing|promotional|newsletter|future (job )?opportunities|future roles|future positions|keep me (informed|updated)|stay in touch|follow (the )?company|receive (updates|communications|emails)|opt[- ]?in|subscribe|share my (profile|data|information)|talent (community|network|pool)|join .* talent/i;
const isOptionalConsent = q => OPTIONAL_CONSENT.test(String(q || ''));

// Robustly check a radio/checkbox whose <input> is a 0×0 element with a React-EPHEMERAL id that
// gets DESTROYED and re-created on interaction (so any data-ja/id handle goes stale the instant
// you click). Key insight: never verify via the old handle. We capture the input's group name +
// current label id, click the label (trusted → mouse coords), then VERIFY FRESH by asking the
// group whether an input is now checked. groupName/optText let us re-find the group after the
// re-render. Returns true once the group shows a checked input.
async function checkOption(page, dataJa, optText, groupName, grpIdx = -1) {
  const loc = page.locator(`[data-ja="${dataJa}"]`);
  // Snapshot the handle details BEFORE any click (the node may vanish after).
  const snap = await loc.evaluate(el => ({ id: el.id, name: el.name, type: el.type })).catch(() => null);
  if (!snap) return false;
  const nm = groupName || snap.name || '';
  const gi = Number.isInteger(grpIdx) ? grpIdx : -1;
  // Verify FRESH whether an input in this group is now checked — by name, else by the enclosing
  // fieldset index (2026 nameless groups), never via the stale/destroyed node.
  const groupChecked = async () => {
    if (nm) return page.evaluate(n => [...document.querySelectorAll(`input[name="${CSS.escape(n)}"]`)].some(i => i.checked), nm).catch(() => false);
    if (gi >= 0) return page.evaluate(idx => {
      const fs = [...document.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')][idx];
      return !!fs && [...fs.querySelectorAll('input[type="radio"], input[type="checkbox"]')].some(i => i.checked);
    }, gi).catch(() => false);
    return loc.evaluate(el => !!el.checked).catch(() => false);
  };
  if (await groupChecked()) return true;

  const clickById = async () => {
    const lbl = page.locator(`label[for="${snap.id}"]`).first();
    if (await lbl.count().catch(() => 0)) {
      await lbl.scrollIntoViewIfNeeded().catch(() => {});
      const box = await lbl.boundingBox().catch(() => null);
      await lbl.click({ force: true, timeout: 2000 }).catch(() => {});
      // after re-render the label still clicks; also try a raw mouse click at its coords
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).catch(() => {});
    }
  };
  // NATIVE CDP click at the label's center — a REAL OS-level mouse event that React cannot
  // distinguish from a human click. This is what finally lands on 0×0 inputs whose synthetic
  // (JS/Playwright trusted) clicks get swallowed by LinkedIn's custom checkbox widget.
  const cdpClickLabel = async () => {
    // Resolve the label element for the option, re-reading live (ids/handles may be stale).
    let lbl = page.locator(`label[for="${snap.id}"]`).first();
    if (!(await lbl.count().catch(() => 0)) && optText) {
      lbl = page.locator('label').filter({ hasText: new RegExp(`^\\s*${optText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
    }
    const box = await lbl.boundingBox().catch(() => null);
    if (!box) return false;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await cdp.detach().catch(() => {});
    } catch { return false; }
    return true;
  };

  // 1) native CDP click at the label — most reliable for 2026 custom checkboxes.
  if (await cdpClickLabel()) { await new Promise(r => setTimeout(r, 450)); if (await groupChecked()) return true; }
  // 2) Playwright trusted click on the label for the captured id, verify fresh.
  await clickById(); await new Promise(r => setTimeout(r, 400));
  if (await groupChecked()) return true;
  // 3) click a label/option carrying the visible option text, verify fresh.
  if (optText) {
    const byText = page.locator(`label, [role="radio"], [role="checkbox"]`).filter({ hasText: new RegExp(`^\\s*${optText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
    if (await byText.count().catch(() => 0)) { await byText.click({ force: true, timeout: 2000 }).catch(() => {}); await new Promise(r => setTimeout(r, 400)); if (await groupChecked()) return true; }
  }
  // 3) JS fallback: locate the input by name (or by fieldset+label text), click its label and
  //    dispatch the full event chain so React registers it.
  await page.evaluate(({ n, id, gi, txt }) => {
    let el = null;
    if (n) { const inputs = [...document.querySelectorAll(`input[name="${CSS.escape(n)}"]`)]; el = inputs.find(i => i.id === id) || inputs[0]; }
    if (!el && gi >= 0) {
      const fs = [...document.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')][gi];
      if (fs) {
        const inputs = [...fs.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
        // choose the input whose label text matches the option, else by id
        el = inputs.find(i => { const l = i.id ? document.querySelector(`label[for="${CSS.escape(i.id)}"]`) : null; return l && new RegExp(`^\\s*${(txt||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\s*$`, 'i').test(l.textContent || ''); }) || inputs.find(i => i.id === id) || inputs[0];
      }
    }
    if (!el) return;
    const lbl = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    el.checked = true;
    if (lbl) { try { lbl.click(); } catch {} }
    for (const t of ['pointerdown', 'mousedown', 'mouseup', 'click', 'input', 'change']) el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  }, { n: nm, id: snap.id, gi, txt: optText || '' }).catch(() => {});
  await new Promise(r => setTimeout(r, 300));
  return groupChecked();
}

// Look up the AGENT's reasoned answer for a question (fuzzy, case-insensitive). Returns the
// answer if the agent provided one for this field, else undefined so the caller falls back to
// the built-in engine. This is what lets the agent reason over ANY form, not just known shapes.
function agentAnswerFor(ctx, question) {
  const map = ctx && ctx.agentAnswers;
  if (!map || !question) return undefined;
  const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/\*+$/, '').trim();
  const q = norm(question);
  if (map[question] != null) return map[question];
  for (const [k, v] of Object.entries(map)) if (norm(k) === q) return v;
  for (const [k, v] of Object.entries(map)) { const kk = norm(k); if (kk.length > 10 && (q.includes(kk) || kk.includes(q))) return v; }
  return undefined;
}

async function fillPage(page, dlg, ctx, job = {}) {
  const { fields, radioGroupOptions = {}, groupByIdx = {} } = await dlg.evaluate(SCAN);
  const p = getProfile();
  const selection = selectCvVariant(job, p);
  if (job.url) setFields(job.url, { selected_cv_id: selection.id, selected_cv_path: selection.path, selected_cv_reason: selection.reason });
  const cvPath = cvAttachmentForJob(job, p);
  const groups = {};
  for (const f of fields) if (f.type === 'radio') (groups[f.name || f.q] ||= []).push(f);
  // Checkbox GROUPS: LinkedIn renders "select all that apply" / single-select questions as a set
  // of role="checkbox" wrappers around hidden inputs. The `required` flag lives on the group, not
  // each input, so handling them one-by-one leaves the group empty and the page can't advance.
  const cbGroups = {};
  for (const f of fields) if (f.type === 'checkbox') { const key = f.name || (f.grpIdx >= 0 ? `grp${f.grpIdx}` : f.q); (cbGroups[key] ||= []).push(f); }
  // A real multi-option question = 2+ checkboxes sharing one question. Standalone checkboxes
  // (single consent/privacy/terms boxes) are still handled inline in the per-field loop.
  const groupedCbIds = new Set();
  for (const [q, g] of Object.entries(cbGroups)) if (g.length >= 2 && q && q.length > 8) g.forEach(f => groupedCbIds.add(f.id));

  for (const f of fields) {
    const loc = page.locator(`[data-ja="${f.id}"]`);
    try {
      if (f.type === 'file') {
        if (cvPath && fs.existsSync(cvPath) && /resume|cv/i.test(f.q) && !fields.some(x => x.type === 'radio' && x.checked && /resume/i.test(x.q))) await loc.setInputFiles(cvPath).catch(() => {});
        continue;
      }
      if (f.type === 'radio') continue;
      if (f.type === 'checkbox') {
        if (groupedCbIds.has(f.id)) continue; // part of a multi-option question → handled below
        // Optional consent/marketing/follow boxes: never auto-check, uncheck if preselected,
        // and never treat as blocking. These are the ones that used to stall the whole apply.
        if (isOptionalConsent(f.q) || isOptionalConsent(f.optLabel)) { if (f.checked) await loc.uncheck({ force: true }).catch(() => {}); continue; }
        if (!f.checked && f.required) await loc.check({ force: true }).catch(() => {});
        if (f.checked && /follow/i.test(f.q + f.optLabel)) await loc.uncheck({ force: true }).catch(() => {});
        continue;
      }
      if (f.tag === 'SELECT') {
        if (f.val && !/select an option/i.test(f.val)) { if (!IDENTITY.test(f.q)) learn(f.q, f.val, 'harvested'); continue; }
        const selOpts = f.opts.slice(1);
        let pick = null;
        // Identity selects (email / phone country code): pick the option matching the profile.
        if (/e-?mail/i.test(f.q)) pick = selOpts.find(o => o.toLowerCase() === (p.email || '').toLowerCase()) || selOpts.find(o => /@/.test(o));
        else if (/country code|phone/i.test(f.q)) pick = selOpts.find(o => /\(\+?92\)|pakistan/i.test(o));
        const agentSel = pick ? undefined : agentAnswerFor(ctx, f.q);
        if (agentSel !== undefined) { const a = String(Array.isArray(agentSel) ? agentSel[0] : agentSel).toLowerCase(); pick = selOpts.find(o => o.toLowerCase() === a) || selOpts.find(o => o.toLowerCase().includes(a) || a.includes(o.toLowerCase())) || null; }
        if (!pick) pick = choiceAnswer(f.q, selOpts);
        // "How did you hear about this opportunity" (often an EMPTY-label select) → prefer a
        // sensible option by its text when the question couldn't be matched.
        if (!pick) {
          const opts = selOpts.map(o => o.toLowerCase());
          const byText = (re) => selOpts[opts.findIndex(o => re.test(o))];
          if (opts.some(o => /job posting|linkedin|job board|online|search engine|other/.test(o)))
            pick = byText(/linkedin/) || byText(/job posting/) || byText(/job board|online/) || byText(/search engine/) || byText(/^other$/);
        }
        // Last resort for ANY required select: never leave it empty — pick a neutral/first option.
        if (!pick && f.required && !isOptionalConsent(f.q)) {
          pick = selOpts.find(o => /^(other|prefer not|n\/?a)/i.test(o)) || selOpts[0];
        }
        if (pick) {
          await loc.selectOption({ label: pick }).catch(async () => { await loc.selectOption(pick).catch(() => {}); });
          await loc.evaluate(s => { s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); }).catch(() => {});
          ctx.used.push(f.q || 'select');
        } else if (f.required && !isOptionalConsent(f.q)) { ctx.unanswered.add(f.q); askLater(f.q, selOpts); }
        continue;
      }
      if (f.val && f.val.trim()) { if (!IDENTITY.test(f.q) && f.q.length > 8) learn(f.q, f.val.trim(), 'harvested'); continue; }
      // Salary/compensation fields: LinkedIn renders them type=text but silently rejects
      // non-numeric input (e.g. "Negotiable"), which blocks "Review" with no visible error.
      // Force a numeric answer for anything salary-shaped so the page can advance.
      const isSalary = /salary|compensation|\bctc\b|expected pay|pay expectation|financial expectations?|monthly gross|gross monthly|remuneration|\brate\b|were you making/i.test(f.q);
      const numeric = f.numeric || isSalary || /how many|years|number of/i.test(f.q);
      const agentV = agentAnswerFor(ctx, f.q);
      let v = agentV !== undefined ? (Array.isArray(agentV) ? agentV.join(', ') : String(agentV)) : textAnswer(f.q, { numeric });
      // Country-of-residence questions: answer with the profile's country.
      if ((v == null || v === '') && /which country.*(reside|live|based)|country.*(you.*(reside|live)|of residence)|where.*(do you )?(reside|live)/i.test(f.q)) {
        v = p.country || (p.location || '').split(',').pop()?.trim() || '';
      }
      // Salary fields: LinkedIn renders them type=text but silently rejects non-numeric input
      // (e.g. "Negotiable"), blocking Review with no error. Force clean numeric digits, and
      // convert to USD when the field explicitly asks for USD.
      if (isSalary && numeric) {
        const wantUsd = /\busd\b|us ?dollar|\$/i.test(f.q);
        const sal = salaryFor(wantUsd ? f.q + ' usd' : f.q, getProfile(), true);
        if (sal != null) v = String(sal).replace(/[^\d]/g, '');
      }
      if (v == null || v === '') { if (f.required && !isOptionalConsent(f.q)) { ctx.unanswered.add(f.q); askLater(f.q); } continue; }
      // Respect the field's maxlength so a long cover-style answer isn't silently rejected
      // (e.g. a 20-char "experience" field). Truncate cleanly to fit.
      let fillVal = String(v);
      if (f.maxlength && fillVal.length > f.maxlength) {
        // For tiny limits a yes/short token is better than a truncated sentence.
        fillVal = f.maxlength <= 10 ? (/\byes\b/i.test(fillVal) ? 'Yes' : fillVal.slice(0, f.maxlength)) : fillVal.slice(0, f.maxlength);
      }
      await loc.fill(fillVal);
      ctx.used.push(f.q);
      if (f.role === 'combobox' || /city|location/i.test(f.q)) {
        await SLEEP(1200);
        const opt = page.locator('[role="listbox"] [role="option"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        else await loc.press('ArrowDown').then(() => loc.press('Enter')).catch(() => {});
      }
    } catch {}
  }
  for (const g of Object.values(groups)) {
    // resume picker (radio-group of CV files) — LinkedIn preselects the latest; leave it
    if (/^radio-group|resume|cv/i.test(g[0].q) || g.every(r => /\.(pdf|docx?)$/i.test(r.optLabel))) continue;
    const learnable = g[0].q.length > 8 && !/^radio-group/.test(g[0].q);
    const checked = g.find(r => r.checked);
    if (checked) { if (learnable && checked.optLabel) learn(g[0].q, checked.optLabel, 'harvested'); continue; }
    // 2026 LinkedIn renders screening radios as raw <input type=radio> with EMPTY labels and
    // no role=radio wrapper — every input shares the QUESTION as aria-label and the visible
    // option text lives in sibling spans/labels. Resolve option labels by ORDER:
    //   • prefer the ordered option-text list captured from the group (radioGroupOptions),
    //   • else for a 2-option group assume LinkedIn's Yes/No convention,
    //   • else fall back to whatever optLabels we have.
    const rawLabels = g.map(r => (r.optLabel || '').trim());
    const allEmpty = rawLabels.every(l => !l);
    const captured = radioGroupOptions[(g[0].q || '').slice(0, 120)];
    let effLabels;
    if (allEmpty && Array.isArray(captured) && captured.length === g.length) effLabels = captured;
    else if (allEmpty && g.length === 2) effLabels = ['Yes', 'No'];
    else effLabels = rawLabels;

    let pick = null;
    const agentR = agentAnswerFor(ctx, g[0].q);
    if (agentR !== undefined) {
      const a = String(Array.isArray(agentR) ? agentR[0] : agentR).toLowerCase().trim();
      pick = effLabels.find(l => l.toLowerCase() === a) || effLabels.find(l => l.toLowerCase().includes(a) || a.includes(l.toLowerCase())) || null;
      if (!pick && /^y/.test(a)) pick = effLabels.find(l => /^yes/i.test(l));
      if (!pick && /^n/.test(a)) pick = effLabels.find(l => /^no/i.test(l));
    }
    if (!pick) pick = choiceAnswer(g[0].q, effLabels);
    if (process.env.DEBUG_EA) console.log('RADIO', JSON.stringify({ q: g[0].q, raw: rawLabels, eff: effLabels, agent: agentR, pick }));
    if (!pick) {
      if (isOptionalConsent(g[0].q)) continue; // optional consent radio → don't block
      ctx.unanswered.add(g[0].q); if (learnable) askLater(g[0].q, effLabels); continue;
    }
    // Map the picked label to the specific input in the group, then check it robustly.
    const pickIdx = effLabels.findIndex(l => l.toLowerCase() === pick.toLowerCase());
    const targetField = pickIdx >= 0 ? g[pickIdx] : g.find(x => (x.optLabel || '').toLowerCase() === pick.toLowerCase()) || g[0];
    const okRadio = await checkOption(page, targetField.id, pick, targetField.name || g[0].name, targetField.grpIdx != null ? targetField.grpIdx : g[0].grpIdx);
    if (process.env.DEBUG_EA) console.log('  radio checked:', okRadio, 'pickIdx', pickIdx);
    if (okRadio) ctx.used.push(g[0].q);
    else if (!isOptionalConsent(g[0].q)) { ctx.unanswered.add(g[0].q); if (learnable) askLater(g[0].q, effLabels); }
  }

  // Checkbox GROUPS (multi-option "select all that apply"). Grouped by shared name OR enclosing
  // fieldset (grpIdx) so bare 2026 checkboxes (no name/label) are handled too.
  for (const [, g] of Object.entries(cbGroups)) {
    if (g.length < 2) continue;                              // standalone consent handled inline
    if (g.some(c => c.checked)) continue;                    // user already selected something
    // Real question + ordered options come from per-fieldset metadata for bare checkboxes.
    const gm = g[0].grpIdx >= 0 ? groupByIdx[g[0].grpIdx] : null;
    const question = ((gm && gm.question) || g[0].q || '').trim();
    const rawLabels = g.map(c => (c.optLabel || '').trim());
    const captured = (gm && gm.options && gm.options.length === g.length ? gm.options : null) || radioGroupOptions[question.slice(0, 120)];
    const labels = rawLabels.every(l => !l) ? (Array.isArray(captured) && captured.length === g.length ? captured : rawLabels) : rawLabels;

    let picks = [];
    const agentC = agentAnswerFor(ctx, question);
    if (agentC !== undefined) {
      const wanted = (Array.isArray(agentC) ? agentC : String(agentC).split(/[,/]/)).map(s => s.toLowerCase().trim()).filter(Boolean);
      picks = labels.filter(l => wanted.some(w => l.toLowerCase() === w || l.toLowerCase().includes(w) || w.includes(l.toLowerCase())));
    }
    if (!picks.length) { const choice = choiceAnswer(question, labels.filter(Boolean)); if (choice) picks = [choice]; }
    // Timezone / region "which are you able to work in" → user can work ANY, so pick US or the first.
    if (!picks.length && /time ?zone|able to work in|which of the following|regions?|markets?/i.test(question)) {
      picks = [labels.find(l => /\bus\b|united states|u\.s\.|est|et\b|pst/i.test(l)) || labels.find(Boolean)].filter(Boolean);
    }
    const groupRequired = !!g[0].required || !!gm?.required;
    if (!picks.length && groupRequired) picks = [labels.find(l => !/^(none of the above|none|n\/?a|prefer not)/i.test(l)) || labels.find(Boolean)].filter(Boolean);
    if (process.env.DEBUG_EA) console.log('CBGROUP', JSON.stringify({ q: question, opts: labels, agent: agentC, picks }));
    if (!picks.length) { if (groupRequired && !isOptionalConsent(question)) { ctx.unanswered.add(question); askLater(question, labels.filter(Boolean)); } continue; }

    let anyChecked = false;
    for (const pick of picks) {
      const idx = labels.findIndex(l => l.toLowerCase() === String(pick).toLowerCase());
      const target = idx >= 0 ? g[idx] : (g.find(x => (x.optLabel || '').toLowerCase() === String(pick).toLowerCase()) || g[0]);
      const ok = await checkOption(page, target.id, String(pick), target.name || g[0].name, target.grpIdx != null ? target.grpIdx : g[0].grpIdx);
      anyChecked = anyChecked || ok;
    }
    if (anyChecked) ctx.used.push(question);
    else if (groupRequired && !isOptionalConsent(question)) { ctx.unanswered.add(question); askLater(question, labels.filter(Boolean)); }
    await new Promise(r => setTimeout(r, 250)); // let the re-render settle before the next group
  }

  // FINAL TEXT RE-FILL PASS. Checking radios/checkboxes triggers React re-renders that can WIPE
  // text/textarea/select values entered earlier in this same page. Re-scan now (after all the
  // choice widgets are set) and re-fill any required text field that came back empty.
  try {
    const after = await dlg.evaluate(SCAN);
    for (const f of after.fields) {
      if (f.type === 'radio' || f.type === 'checkbox' || f.type === 'file' || f.type === 'hidden') continue;
      if (f.val && String(f.val).trim() && !/select an option/i.test(f.val)) continue; // still filled
      if (!f.required) continue;
      const loc = page.locator(`[data-ja="${f.id}"]`);
      const isSalary = /salary|compensation|\bctc\b|financial expectations?|monthly gross|gross monthly|were you making|desired (pay|salary)|current (pay|salary)/i.test(f.q);
      const numeric = f.numeric || isSalary || /how many|years|number of/i.test(f.q);
      const agentV = agentAnswerFor(ctx, f.q);
      let v = agentV !== undefined ? (Array.isArray(agentV) ? agentV.join(', ') : String(agentV)) : textAnswer(f.q, { numeric });
      if ((v == null || v === '') && /which country.*(reside|live|based)|country of residence/i.test(f.q)) v = p.country || 'Pakistan';
      if (isSalary && numeric) { const s = salaryFor(/\busd\b|\$/i.test(f.q) ? f.q + ' usd' : f.q, p, true); if (s != null) v = String(s).replace(/[^\d]/g, ''); }
      if (v == null || v === '') continue;
      if (f.tag === 'SELECT') {
        const opts = (f.opts || []).slice(1); const a = String(v).toLowerCase();
        let pick = opts.find(o => o.toLowerCase() === a) || opts.find(o => o.toLowerCase().includes(a) || a.includes(o.toLowerCase()));
        if (!pick) { const lo = opts.map(o => o.toLowerCase()); if (lo.some(o => /job posting|linkedin|search engine|other/.test(o))) pick = opts[lo.findIndex(o => /linkedin/.test(o))] || opts[lo.findIndex(o => /job posting/.test(o))] || opts[lo.findIndex(o => /^other$/.test(o))]; }
        if (!pick) pick = opts.find(o => /^(other|prefer not|n\/?a)/i.test(o)) || opts[0];
        if (pick) { await loc.selectOption({ label: pick }).catch(async () => { await loc.selectOption(pick).catch(() => {}); }); await loc.evaluate(s => { s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); }).catch(() => {}); }
        continue;
      }
      let fillVal = String(v); if (f.maxlength && fillVal.length > f.maxlength) fillVal = f.maxlength <= 10 ? (/\byes\b/i.test(fillVal) ? 'Yes' : fillVal.slice(0, f.maxlength)) : fillVal.slice(0, f.maxlength);
      await loc.fill(fillVal).catch(() => {});
    }
  } catch {}
}

// ── REASONING / ANALYSIS STEP ─────────────────────────────────────────────────
// Every LinkedIn Easy Apply form is different, so before (and after) filling we ANALYZE the
// whole page: classify each field, decide the intended answer + why, and flag which required
// fields are still unresolved. This produces a transparent plan the fill step and the
// evolution memory can both use, instead of blind field-by-field pattern matching.
async function analyzePage(dlg, ctx = {}) {
  const { fields, radioGroupOptions = {}, groupByIdx = {}, heading, errors = [] } = await dlg.evaluate(SCAN);
  const p = getProfile();
  const plan = [];
  // group radios/checkboxes the SAME way fillPage does (name → fieldset grpIdx → question)
  const groupKey = f => f.name || (f.grpIdx >= 0 ? `grp${f.grpIdx}` : f.q);
  const radioByGroup = {}; for (const f of fields) if (f.type === 'radio') (radioByGroup[groupKey(f)] ||= []).push(f);
  const cbByGroup = {}; for (const f of fields) if (f.type === 'checkbox') (cbByGroup[groupKey(f)] ||= []).push(f);
  const seen = new Set();

  for (const f of fields) {
    if (f.type === 'hidden') continue;
    let decision = null, reason = '', kind = f.type;
    let q = f.q || f.optLabel || f.name;

    if (f.type === 'file') { decision = 'attach CV'; reason = 'resume upload'; }
    else if (f.type === 'radio' || f.type === 'checkbox') {
      const key = groupKey(f); if (seen.has(key)) continue; seen.add(key);
      const g = (f.type === 'radio' ? radioByGroup : cbByGroup)[key] || [f];
      if (f.type === 'checkbox' && g.length < 2) { // standalone consent checkbox
        decision = isOptionalConsent(f.q) ? 'leave unchecked' : (f.required ? 'check' : 'skip'); reason = 'single checkbox'; q = f.q;
      } else {
        const gm = f.grpIdx >= 0 ? groupByIdx[f.grpIdx] : null;
        q = ((gm && gm.question) || g[0].q || '').trim();
        kind = `${f.type === 'radio' ? 'radio' : 'checkbox'}(${g.length})`;
        const raw = g.map(r => (r.optLabel || '').trim());
        const captured = (gm && gm.options?.length === g.length ? gm.options : null) || radioGroupOptions[(q || '').slice(0, 120)];
        const opts = raw.every(l => !l) ? (Array.isArray(captured) && captured.length === g.length ? captured : (g.length === 2 ? ['Yes', 'No'] : raw)) : raw;
        const already = g.some(c => c.checked);
        const groupRequired = !!g.some(c => c.required) || !!gm?.required;
        const agent = agentAnswerFor(ctx, q);
        const pick = agent !== undefined ? (Array.isArray(agent) ? agent.join(', ') : String(agent)) : choiceAnswer(q, opts.filter(Boolean));
        const tzDefault = !pick && /time ?zone|able to work in|which of the following|regions?/i.test(q) ? (opts.find(o => /\bus\b|united states/i.test(o)) || opts.find(Boolean)) : null;
        decision = already ? 'already selected' : (pick || tzDefault);
        reason = already ? 'already selected' : (decision ? `pick "${decision}" of [${opts.join(', ')}]` : (isOptionalConsent(q) ? 'optional — skip' : `NO MATCH in [${opts.join(', ')}]`));
      }
    }
    else if (f.tag === 'SELECT') { q = f.q; const agent = agentAnswerFor(ctx, f.q); const pick = agent !== undefined ? agent : choiceAnswer(f.q, (f.opts || []).slice(1)); decision = pick; reason = pick ? `select "${pick}"` : 'no select match'; }
    else { // text / textarea / tel
      const isSalary = /salary|compensation|\bctc\b|financial expectations?|monthly gross|gross monthly|were you making|desired (pay|salary)|current (pay|salary)/i.test(q);
      const numeric = f.numeric || isSalary || /how many|years|number of/i.test(q);
      const agent = agentAnswerFor(ctx, q);
      let v = agent !== undefined ? (Array.isArray(agent) ? agent.join(', ') : String(agent)) : textAnswer(q, { numeric });
      if ((v == null || v === '') && /which country.*(reside|live|based)|country of residence/i.test(q)) v = p.country || 'Pakistan';
      decision = v; reason = v != null ? 'answered from profile/rules' + (f.maxlength ? ` (max ${f.maxlength})` : '') : (isOptionalConsent(q) ? 'optional — skip' : 'UNRESOLVED');
    }
    const resolved = decision != null && decision !== '' || /skip|optional/i.test(reason);
    const required = !!f.required || (f.type === 'checkbox' && g.length >= 2 && !!groupByIdx[f.grpIdx]?.required);
    plan.push({ q: String(q).slice(0, 70), kind, required, decision: decision == null ? null : String(decision).slice(0, 50), reason, resolved });
  }

  const blocking = plan.filter(x => x.required && !x.resolved);
  if (process.env.DEBUG_EA) {
    console.log(`\n[ANALYZE] "${heading}" — ${plan.length} fields, ${blocking.length} blocking${errors.length ? ', errors: ' + errors.join(' | ') : ''}`);
    for (const x of plan) console.log(`  ${x.resolved ? '✓' : '✗'} [${x.kind}${x.required ? '*' : ''}] ${x.q} => ${x.decision ?? '—'} (${x.reason})`);
  }
  return { heading, plan, blocking, errors };
}

async function discard(page) {
  await page.locator('dialog').getByRole('button', { name: /dismiss|close/i }).first().click({ timeout: 3000 }).catch(() => {});
  await SLEEP(800);
  await page.getByRole('button', { name: /discard/i }).first().click({ timeout: 3000 }).catch(() => {});
}

async function verifyApplied(page, url) {
  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (APPLIED_RE.test(body)) return true;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await SLEEP(3000);
  const main = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 2500)).catch(() => '');
  return APPLIED_RE.test(main);
}

/**
 * Apply via Easy Apply. Returns {ok, result, detail, questions?, meta, externalUrl?}
 * result: applied | already_applied | no_easy_apply | needs_answers | stuck | closed | error | dry_run_ready
 */
export async function easyApply({ url, timeoutMs = 120000, dryRun = false, job = {} }) {
  const bctx = await getContext();
  const page = await bctx.newPage();
  page.setDefaultTimeout(15000);
  const t0 = Date.now();
  const ctx = { unanswered: new Set(), used: [] };
  let meta = {};
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(3000);
    meta = await page.evaluate(() => {
      const main = (document.querySelector('main') || document.body).innerText;
      return { posted: (main.match(/(\d+\s+(minute|hour|day|week|month)s?\s+ago)/) || [])[1] || '', head: main.slice(0, 1500) };
    });
    // LinkedIn daily submission cap: "We limit daily submissions ... Save this job and apply tomorrow."
    if (/limit daily submissions|apply tomorrow|reached your daily|daily (submission|application) limit|limit.{0,30}submissions/i.test(meta.head)) {
      await encounter('easy_apply', 'linkedin daily submission limit reached', { url, page });
      await page.close(); return { ok: false, result: 'daily_limit', detail: 'LinkedIn daily Easy Apply limit reached — pausing Easy Apply until tomorrow', meta };
    }
    // LinkedIn anti-bot throttle: a security checkpoint / "unusual activity" / rate-limit page.
    if (LINKEDIN_THROTTLE_RE.test(meta.head + ' ' + page.url())) {
      await encounter('easy_apply', 'linkedin anti-bot throttle / checkpoint', { url, page });
      await page.close(); return { ok: false, result: 'throttled', detail: 'LinkedIn security check / rate limit — backing off', meta };
    }
    if (APPLIED_RE.test(meta.head)) { await page.close(); return { ok: true, result: 'already_applied', detail: 'LinkedIn shows already applied', meta }; }
    if (/no longer accepting applications/i.test(meta.head)) { await page.close(); return { ok: true, result: 'closed', detail: 'no longer accepting applications', meta }; }

    const ea = page.getByRole('button', { name: /easy apply/i }).first();
    if (!(await ea.isVisible().catch(() => false))) {
      const ext = page.getByRole('button', { name: /^apply/i }).or(page.getByRole('link', { name: /^apply/i })).first();
      let extUrl = '';
      if (await ext.isVisible().catch(() => false)) {
        const [popup] = await Promise.all([bctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), ext.click().catch(() => {})]);
        if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); extUrl = popup.url(); await popup.close().catch(() => {}); }
      }
      await page.close();
      return { ok: true, result: 'no_easy_apply', detail: extUrl ? 'external: ' + extUrl : 'no Easy Apply button', externalUrl: extUrl, meta };
    }
    const clickResult = await clickEasyApplyControl(page, ea);
    if (!clickResult.ok) {
      if (clickResult.throttled) {
        await encounter('easy_apply', 'LinkedIn anti-bot throttle intercepted Easy Apply', { url, page });
        await page.close(); return { ok: false, result: 'throttled', detail: clickResult.detail, meta };
      }
      await encounter('easy_apply', `Easy Apply control not clickable: ${clickResult.detail}`.slice(0, 580), { url, page });
      await page.close(); return { ok: false, result: 'error', detail: clickResult.detail, meta };
    }
    let dlg = await waitForEasyApplyDialog(page);
    if (!dlg) {
      // safety/"job search safety reminder" interstitial → continue
      const cont = page.getByRole('button', { name: /continue applying|^continue$/i }).first();
      if (await cont.isVisible().catch(() => false)) { await cont.click(); dlg = await waitForEasyApplyDialog(page, 12000); }
    }
    // If we matched a "Job search safety reminder" dialog (no real form fields), dismiss it and re-find the real apply dialog.
    if (dlg && await dlg.isVisible().catch(() => false)) {
      const dlgText = await dlg.innerText().catch(() => '');
      if (/safety reminder|safety tips|research the company|report suspicious/i.test(dlgText)) {
        const contBtn = dlg.getByRole('link', { name: /continue applying/i }).or(dlg.getByRole('button', { name: /continue applying/i })).first();
        if (await contBtn.isVisible().catch(() => false)) {
          await contBtn.click().catch(() => {});
          await SLEEP(1500);
          // re-select the actual apply dialog (not the safety one)
          dlg = await waitForEasyApplyDialog(page, 12000);
        }
      }
    }
    if (!dlg || !(await dlg.isVisible().catch(() => false))) {
      await encounter('easy_apply', 'dialog did not open', { url, page });
      await page.close(); return { ok: false, result: 'error', detail: 'Easy Apply dialog did not open', meta };
    }

    let lastProgress = '', same = 0;
    for (let step = 0; step < 15 && Date.now() - t0 < timeoutMs; step++) {
      // PER-STEP REASONING: analyze this page (what each field needs + why), fill, then
      // re-analyze and re-fill once if required fields remain. The engine reasons at EVERY
      // step of the Easy Apply, not only once or only when stuck.
      await analyzePage(dlg, ctx).catch(() => null);
      await fillPage(page, dlg, ctx, job);
      await SLEEP(400);
      const recheck = await analyzePage(dlg, ctx).catch(() => null);
      if (recheck && recheck.blocking.length) { await fillPage(page, dlg, ctx, job); await SLEEP(400); }
      const submit = dlg.getByRole('button', { name: /submit application/i }).first();
      if (await submit.isVisible().catch(() => false)) {
        if (dryRun) { await discard(page); await page.close(); return { ok: true, result: 'dry_run_ready', detail: `reached submit at step ${step}`, meta }; }
        await submit.click();
        await SLEEP(3500);
        await page.getByRole('button', { name: /^done$|dismiss/i }).first().click({ timeout: 3000 }).catch(() => {});
        const ok = await verifyApplied(page, url);
        if (!ok) await encounter('easy_apply', 'submit clicked but not confirmed', { url, page });
        await page.close().catch(() => {});
        return { ok, result: ok ? 'applied' : 'stuck', detail: ok ? `submitted + verified (${step + 1} pages)` : 'submit not confirmed', meta, used: ctx.used };
      }
      const next = dlg.getByRole('button', { name: /continue to next step|review your application|^next$|^review$/i }).first();
      if (!(await next.isVisible().catch(() => false))) { await encounter('easy_apply', 'no next/submit button', { url, page, scope: dlg }); break; }
      await next.click().catch(() => {});
      await SLEEP(1600);
      let st = await dlg.evaluate(SCAN).catch(() => ({ progress: '', errors: [] }));
      if (st.progress === lastProgress && st.progress) {
        // STALL RECOVERY: the progress bar didn't move. Before treating this as "stuck",
        // give the dialog extra time to re-render, then re-analyze + re-fill and retry the
        // advance once. Most "all fields resolved but page would not advance" encounters are a
        // render/timing race on the review step, not a missing answer — this clears them without
        // a human round-trip (root cause of evolution encounters #20/#21/#22).
        await SLEEP(1800);
        const reanalysis = await analyzePage(dlg, ctx).catch(() => null);
        if (!reanalysis || !reanalysis.blocking.length) {
          await fillPage(page, dlg, ctx, job).catch(() => {});
          await SLEEP(600);
          const retryNext = dlg.getByRole('button', { name: /continue to next step|review your application|^next$|^review$/i }).first();
          if (await retryNext.isVisible().catch(() => false)) { await retryNext.click().catch(() => {}); await SLEEP(1800); }
          st = await dlg.evaluate(SCAN).catch(() => st);
        }
      }
      if (st.progress === lastProgress && st.progress) {
        same++;
        // a validation error usually means a numeric field got text, or a choice we didn't pick
        for (const f of st.fields.filter(f => f.required && !f.val && !f.checked && f.type !== 'radio' && f.type !== 'checkbox')) { ctx.unanswered.add(f.q); askLater(f.q, f.opts?.slice(1) || []); }
        if (same >= 2) {
          // REASONING STEP: analyze the stuck page so we know exactly which required fields are
          // unresolved and why, and bake that into the encounter so the fix is obvious.
          const analysis = await analyzePage(dlg, ctx).catch(() => null);
          if (analysis) {
            for (const b of analysis.blocking) { ctx.unanswered.add(b.q); }
            const summary = analysis.blocking.length
              ? 'blocking: ' + analysis.blocking.map(b => `${b.q} [${b.kind}] (${b.reason})`).join(' | ')
              : (analysis.errors.join(' | ') || 'all fields resolved but page would not advance');
            if (!ctx.unanswered.size || !analysis.blocking.length) {
              await encounter('easy_apply', `stuck on "${analysis.heading}": ${summary}`.slice(0, 580), { url, page, scope: dlg });
            }
          } else if (!ctx.unanswered.size) {
            await encounter('easy_apply', `stuck on page "${st.heading}": ${st.errors.join(' | ')}`, { url, page, scope: dlg });
          }
          break;
        }
      } else same = 0;
      lastProgress = st.progress;
    }
    await discard(page);
    await page.close().catch(() => {});
    const qs = [...ctx.unanswered];
    return qs.length
      ? { ok: false, result: 'needs_answers', detail: 'needs your answer: ' + qs.slice(0, 4).join(' | ').slice(0, 300), questions: qs, meta }
      : { ok: false, result: 'stuck', detail: 'could not advance (see Evolution tab)', meta };
  } catch (e) {
    await encounter('easy_apply', 'exception: ' + e.message.split('\n')[0], { url, page }).catch(() => {});
    await discard(page).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200), questions: [...ctx.unanswered], meta };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AGENT-DRIVEN REASONING PATH — the agent reasons over any form using CV + profile.
//   inspectEasyApply(url)                → full ordered field list across all pages (no submit)
//   applyEasyApplyWithAnswers(url, map)  → fills using the agent's answers (keyed by question),
//                                          engine fallback for omissions, then submit + verify.
// ──────────────────────────────────────────────────────────────────────────────
async function openEasyApplyDialog(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
  await SLEEP(3000);
  const meta = await page.evaluate(() => {
    const main = (document.querySelector('main') || document.body).innerText;
    return { posted: (main.match(/(\d+\s+(minute|hour|day|week|month)s?\s+ago)/) || [])[1] || '', head: main.slice(0, 1500) };
  });
  if (APPLIED_RE.test(meta.head)) return { done: { ok: true, result: 'already_applied', detail: 'already applied', meta } };
  if (/no longer accepting applications/i.test(meta.head)) return { done: { ok: true, result: 'closed', detail: 'closed', meta } };
  if (/limit daily submissions|apply tomorrow|reached your daily|daily (submission|application) limit/i.test(meta.head)) return { done: { ok: false, result: 'daily_limit', detail: 'daily limit', meta } };
  const ea = page.getByRole('button', { name: /easy apply/i }).first();
  if (!(await ea.isVisible().catch(() => false))) return { done: { ok: true, result: 'no_easy_apply', detail: 'no Easy Apply button', meta } };
  const clickResult = await clickEasyApplyControl(page, ea);
  if (!clickResult.ok) {
    await page.close().catch(() => {});
    return { done: { ok: false, result: clickResult.throttled ? 'throttled' : 'error', detail: clickResult.detail, meta } };
  }
  let dlg = await waitForEasyApplyDialog(page);
  if (dlg && await dlg.isVisible().catch(() => false)) {
    const dlgText = await dlg.innerText().catch(() => '');
    if (/safety reminder|safety tips|research the company/i.test(dlgText)) {
      await dlg.getByRole('link', { name: /continue applying/i }).or(dlg.getByRole('button', { name: /continue applying/i })).first().click().catch(() => {});
      await SLEEP(1500);
      dlg = await waitForEasyApplyDialog(page, 12000);
    }
  }
  if (!dlg || !(await dlg.isVisible().catch(() => false))) return { done: { ok: false, result: 'error', detail: 'dialog did not open', meta } };
  return { dlg, meta };
}

export async function inspectEasyApply({ url, timeoutMs = 120000 }) {
  const bctx = await getContext();
  const page = await bctx.newPage();
  page.setDefaultTimeout(15000);
  const t0 = Date.now();
  try {
    const opened = await openEasyApplyDialog(page, url);
    if (opened.done) { await page.close().catch(() => {}); return { ok: opened.done.ok, result: opened.done.result, detail: opened.done.detail, pages: [], fields: [], meta: opened.done.meta }; }
    const dlg = opened.dlg;
    const pages = [];
    for (let step = 0; step < 15 && Date.now() - t0 < timeoutMs; step++) {
      const scan = await dlg.evaluate(SCAN).catch(() => ({ fields: [], radioGroupOptions: {}, groupByIdx: {}, heading: '' }));
      const logical = [];
      const grpSeen = new Set();
      for (const f of scan.fields) {
        if (f.type === 'hidden') continue;
        if (f.type === 'radio' || f.type === 'checkbox') {
          const key = f.name || (f.grpIdx >= 0 ? `grp${f.grpIdx}` : f.q); if (grpSeen.has(key)) continue; grpSeen.add(key);
          const group = scan.fields.filter(x => (x.name || (x.grpIdx >= 0 ? `grp${x.grpIdx}` : x.q)) === key && x.type === f.type);
          const gm = f.grpIdx >= 0 ? scan.groupByIdx?.[f.grpIdx] : null;
          const raw = group.map(r => (r.optLabel || '').trim());
          const captured = (gm && gm.options?.length === group.length ? gm.options : null) || scan.radioGroupOptions?.[(f.q || '').slice(0, 120)];
          const opts = raw.every(l => !l) ? (Array.isArray(captured) && captured.length === group.length ? captured : (group.length === 2 ? ['Yes', 'No'] : raw)) : raw;
          logical.push({ question: (gm && gm.question) || f.q, type: f.type === 'radio' ? 'single-choice' : 'multi-choice', options: opts, required: !!f.required });
        } else if (f.tag === 'SELECT') {
          logical.push({ question: f.q, type: 'select', options: (f.opts || []).filter(o => o && !/^select/i.test(o)), required: !!f.required });
        } else if (f.type === 'file') {
          logical.push({ question: f.q || 'Resume', type: 'file', required: !!f.required });
        } else {
          logical.push({ question: f.q, type: f.tag === 'TEXTAREA' ? 'long-text' : 'text', maxlength: f.maxlength || 0, required: !!f.required });
        }
      }
      pages.push({ step, heading: scan.heading, fields: logical });
      const submit = dlg.getByRole('button', { name: /submit application/i }).first();
      if (await submit.isVisible().catch(() => false)) break;
      const next = dlg.getByRole('button', { name: /continue to next step|review your application|^next$|^review$/i }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click().catch(() => {});
      await SLEEP(1500);
    }
    await discard(page);
    await page.close().catch(() => {});
    const fields = pages.flatMap(p => p.fields.map(f => ({ ...f, page: p.step })));
    return { ok: true, result: 'inspected', pages, fields, meta: opened.meta };
  } catch (e) {
    await discard(page).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200), pages: [], fields: [] };
  }
}

export async function applyEasyApplyWithAnswers({ url, answers = {}, timeoutMs = 180000, dryRun = false, job = {} }) {
  const bctx = await getContext();
  const page = await bctx.newPage();
  page.setDefaultTimeout(15000);
  const t0 = Date.now();
  const ctx = { unanswered: new Set(), used: [], agentAnswers: answers };
  try {
    const opened = await openEasyApplyDialog(page, url);
    if (opened.done) { await page.close().catch(() => {}); return { ...opened.done }; }
    const dlg = opened.dlg;
    let lastProgress = '', same = 0;
    for (let step = 0; step < 15 && Date.now() - t0 < timeoutMs; step++) {
      await fillPage(page, dlg, ctx, job);
      await SLEEP(500);
      const submit = dlg.getByRole('button', { name: /submit application/i }).first();
      if (await submit.isVisible().catch(() => false)) {
        if (dryRun) { await discard(page); await page.close(); return { ok: true, result: 'dry_run_ready', detail: `reached submit at step ${step}` }; }
        await submit.click(); await SLEEP(3500);
        await page.getByRole('button', { name: /^done$|dismiss/i }).first().click({ timeout: 3000 }).catch(() => {});
        const okv = await verifyApplied(page, url);
        await page.close().catch(() => {});
        return { ok: okv, result: okv ? 'applied' : 'stuck', detail: okv ? `submitted + verified (${step + 1} pages)` : 'submit not confirmed', used: ctx.used };
      }
      const next = dlg.getByRole('button', { name: /continue to next step|review your application|^next$|^review$/i }).first();
      if (!(await next.isVisible().catch(() => false))) break;
      await next.click().catch(() => {});
      await SLEEP(1600);
      const st = await dlg.evaluate(SCAN).catch(() => ({ progress: '' }));
      if (st.progress && st.progress === lastProgress) { if (++same >= 2) { const a = await analyzePage(dlg, ctx).catch(() => null); const blk = a ? a.blocking.map(b => `${b.q} (${b.reason})`).join(' | ') : ''; await discard(page); await page.close(); return { ok: false, result: 'stuck', detail: 'could not advance — ' + (blk || 'validation'), blocking: a?.blocking || [] }; } } else same = 0;
      lastProgress = st.progress;
    }
    await discard(page); await page.close().catch(() => {});
    return { ok: false, result: 'stuck', detail: 'did not reach submit', unanswered: [...ctx.unanswered] };
  } catch (e) {
    await discard(page).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200) };
  }
}
