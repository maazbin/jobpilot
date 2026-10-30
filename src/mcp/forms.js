// src/mcp/forms.js — External application forms (Greenhouse, Lever, Ashby, Workable, generic).
// Resolves short links, hops from job-description pages to the actual form, fills every field
// with the answer engine (incl. react-select comboboxes, radio groups, consent boxes), uploads
// the CV, refuses to submit while REQUIRED fields are still unknown, and verifies a
// confirmation page. result: submitted | needs_manual | no_form | error
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { textAnswer, choiceAnswer, coverText } from './answers.js';
import { encounter, askLater, learn } from '../evolve.js';
import { classifyBoardPage } from './board-pages.js';
import fs from 'fs';
import { cvAttachmentForJob, selectCvVariant } from '../cv.js';
import { setFields } from '../tracker.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

async function boardBail(page, url) {
  const text = await page.evaluate(() => (document.body?.innerText || '').slice(0, 800)).catch(() => '');
  const step = classifyBoardPage({ url, text });
  if (!step || step.drive === 'company_site') return null;
  return { ok: false, result: 'needs_manual', detail: step.detail, boardStep: step.step, finalUrl: url };
}

// intl-tel-input leaves its country list open (role=dialog) after a phone fill, and cookie
// bars sit on the submit button. Either one swallows the click, so the form never confirms.
async function closeBlockingOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => {
    document.querySelectorAll('.iti__country-selector, .iti--container').forEach(el => el.classList.add('iti__hide'));
    const ae = document.activeElement;
    if (ae && ae !== document.body) ae.blur();
  }).catch(() => {});
  const cookie = page.getByRole('button', { name: /^(accept all|decline all|accept cookies|allow all cookies|allow all|reject all|i agree|got it)$/i }).first();
  if (await cookie.isVisible().catch(() => false)) await cookie.click({ timeout: 2000 }).catch(() => {});
  await SLEEP(300);
}
const CONFIRM_RE = /thank(s| you) for (applying|your application)|application (has been |was )?(received|submitted|sent)|we.?ve received your application|successfully (applied|submitted)|your application is (complete|submitted|received)|application submitted|applied successfully|you('ve| have) applied|congrat|we will be in touch|we.?ll be in touch|check your email.*application/i;

const SCAN = () => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 || r.height > 0 || el.type === 'file' || el.type === 'radio' || el.type === 'checkbox') && s.visibility !== 'hidden'; };
  const qOf = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.innerText.trim()) return l.innerText; }
    if (el.type !== 'radio' && el.type !== 'checkbox') { const l = el.closest('label'); if (l?.innerText.trim()) return l.innerText; }
    const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg?.innerText.trim()) return lg.innerText;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(' ').map(i => document.getElementById(i)?.innerText || '').join(' '); if (t.trim()) return t; }
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) { const lab = p.querySelector('label, .application-label, [class*="label"]'); if (lab && lab.innerText.trim() && !lab.contains(el)) return lab.innerText; }
    return el.placeholder || el.name || '';
  };
  const out = []; let i = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || el.type === 'submit' || el.disabled || !vis(el)) continue;
    if (el.closest('[aria-hidden="true"]') && el.type !== 'file') continue;
    const id = 'jf' + (i++); el.setAttribute('data-jf', id);
    const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label');
    const q = (qOf(el) || '').replace(/\s+/g, ' ').trim();
    let val = el.tagName === 'SELECT' ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '') : el.value;
    if (el.getAttribute('role') === 'combobox' && !val) {
      const c = el.closest('[class*="select__control"]') || el.closest('[class*="select-shell"]') || el.parentElement?.parentElement?.parentElement;
      const t = c ? c.innerText.replace(/^(select\.*|start typing.*)$/im, '').trim() : '';
      if (t && !/^select/i.test(t)) val = t;
    }
    out.push({ id, tag: el.tagName, type: el.type, name: el.name, role: el.getAttribute('role') || '', q: q.slice(0, 300), optLabel: (lab?.innerText || el.value || '').trim().slice(0, 120),
      val, checked: !!el.checked,
      opts: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\*\s*\n|required/i.test(q) });
  }
  return out;
};

// Job-board description pages (not real forms). Their apply link redirects to the true ATS.
const BOARD_HOST = /(^|\.)(remoteok\.com|remotive\.com|jobicy\.com|himalayas\.app|weworkremotely\.com|wellfound\.com|arbeitnow\.com|aihackerjobs\.com|lnkd\.in|paperpk\.com|rozee\.pk|mustakbil\.com)$/i;
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const flog = (...a) => console.log('[forms]', ...a);

// Known ATS / Google Forms targets a board/shortener may resolve to. Google Forms
// (docs.google.com/forms, forms.gle) is a valid form target the engine can fill.
const ATS_RE = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|breezy|recruitee|bamboohr|jobvite|teamtailor|rippling|personio|forms\.gle|docs\.google\.com\/forms|google\.com\/forms|typeform|tally\.so/i;

// LinkedIn's "You're leaving LinkedIn" interstitial carries the real destination on an
// artdeco-button <a data-tracking-control-name="external_url_click">. It can be served on the
// lnkd.in host itself (not only linkedin.com), so detect it by content, not by URL host.
async function linkedinInterstitialTarget(page) {
  return page.evaluate(() => {
    const a = document.querySelector('a[data-tracking-control-name="external_url_click"]');
    if (a?.href && !/(^|\.)linkedin\.com$|lnkd\.in/.test(new URL(a.href).hostname)) return a.href;
    // Fallback: first off-domain anchor that is not a linkedin help/learn-more link.
    for (const el of document.querySelectorAll('a[href]')) {
      try { const h = new URL(el.href).hostname; if (/linkedin\.com$|lnkd\.in$/.test(h)) continue; } catch { continue; }
      if (el.href.startsWith('http')) return el.href;
    }
    return null;
  }).catch(() => null);
}

// ── Indeed: extract the real ATS link embedded in the posting, or fall back to
//    connect/email so the lead still gets actioned rather than silently dropped.
async function resolveIndeed(page) {
  // Indeed embeds the employer's apply URL in a data attribute or an <a> tag inside
  // the job posting detail. Try the most common selectors first.
  const found = await page.evaluate(() => {
    // 1. "Apply on company website" button href pointing straight off indeed.com
    const ext = document.querySelector('a[data-indeed-apply-joburl], a[href*="indeedapply"], .jobsearch-IndeedApplyButton-newDesign a');
    if (ext?.href && !ext.href.includes('indeed.com')) return { direct: ext.href };

    // 2. Metadata inside the apply widget
    const meta = document.querySelector('[data-indeed-apply-apitoken], [data-indeed-apply-joburl]');
    if (meta) {
      const u = meta.getAttribute('data-indeed-apply-joburl') || meta.getAttribute('action');
      if (u && !u.includes('indeed.com')) return { direct: u };
    }

    // 3. Any visible "Apply" link pointing off indeed.com
    for (const a of document.querySelectorAll('a[href]')) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('apply') || txt.includes('company site')) && !a.href.includes('indeed.com')) return { direct: a.href };
    }

    // 4. "Apply on company site" that points at Indeed's own redirect endpoint
    //    (/applystart?jk=…). This is NOT Indeed's in-app Easy Apply widget (which has
    //    #indeedApplyButton / [data-indeed-apply-apitoken]); it is a bounce link to the
    //    employer's real ATS that merely passes THROUGH indeed.com first. Following it in
    //    the logged-in session lands on the real Greenhouse/Lever/Ashby/Workable page.
    for (const a of document.querySelectorAll('a[href]')) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('company site') || txt.includes('company website')) && /\/applystart\b|\/rc\/clk\b/.test(a.href)) return { redirect: a.href };
    }
    return null;
  }).catch(() => null);

  if (!found) return null;
  if (found.direct) return found.direct;

  // Follow the Indeed redirect link within the authenticated session and capture where
  // it finally lands. If it leaves indeed.com, that destination is the real ATS; hand it
  // back to applyForm(). If it stays on indeed.com (in-site Indeed Apply), we have no
  // external ATS to drive — signal that so the caller routes to connect/email.
  if (found.redirect) {
    try {
      await page.goto(found.redirect, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      // /applystart hops indeed → tracker → employer ATS. One read often catches the middle hop.
      let dest = page.url();
      let stableOff = '';
      for (let i = 0; i < 8; i++) {
        await SLEEP(1500);
        const now = page.url();
        if (now && !/indeed\.com/i.test(now)) {
          if (now === dest) { stableOff = now; break; }
        }
        dest = now;
      }
      if (stableOff) return stableOff;
      if (dest && !/indeed\.com/i.test(dest)) return dest;
    } catch { /* fall through */ }
  }
  return null;
}

// ── Glassdoor: click the "Apply on employer site" CTA and return the employer-ATS URL.
//    Glassdoor's own "Easy Apply" is Indeed SmartApply behind a reCAPTCHA — not auto-fillable
//    and NOT something we evade — so only the "Apply on employer site" path is driven here.
//    The current UI renders the CTA as <button data-test="applyButton"> (not an <a>), so match
//    the button and use a real (trusted) Playwright click; element.click() in page context does
//    not fire Glassdoor's handler. A visible "Easy Apply" label means SmartApply → bail to null
//    so the lead routes to connect/email.
async function resolveGlassdoor(page) {
  const applyBtn = page.locator('button[data-test="applyButton"], a[data-test="applyButton"]').first();
  const legacy = page.getByRole('link', { name: /apply on (company site|employer site)/i });
  const target = (await applyBtn.isVisible({ timeout: 6000 }).catch(() => false)) ? applyBtn
    : (await legacy.first().isVisible({ timeout: 2000 }).catch(() => false)) ? legacy.first()
    : null;
  if (!target) return null;

  const label = (await target.innerText().catch(() => '')).toLowerCase();
  if (/easy apply/i.test(label)) return null;   // SmartApply / reCAPTCHA — not auto-applyable

  const ctx = page.context();
  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null),
    target.click({ timeout: 8000 }).catch(() => {}),
  ]);

  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await SLEEP(2500);
    const dest = popup.url();
    await popup.close().catch(() => {});
    if (dest && !/glassdoor\.com/.test(dest) && !/smartapply\.indeed\.com/.test(dest)) return dest;
    if (/smartapply\.indeed\.com/.test(dest)) return null;   // Indeed Apply now — not this click
  }

  // Glassdoor navigates in the same tab sometimes.
  await SLEEP(3000);
  const current = page.url();
  if (current && !/glassdoor\.com/.test(current) && !/smartapply\.indeed\.com/.test(current)) return current;
  return null;
}

// ── WeWorkRemotely: the "Apply for this job" button links directly to the employer's URL.
async function resolveWeWorkRemotely(page) {
  // WWR posts an <a class="button"> with href pointing to the real application URL.
  const atsUrl = await page.evaluate(() => {
    // Primary: the green "Apply for this job" button on the detail page
    for (const a of document.querySelectorAll('a.button, a.wwr-button, section.apply a, .listing-header-container a')) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('apply') || txt.includes('job')) && a.href && !a.href.includes('weworkremotely.com')) return a.href;
    }
    // Fallback: any off-domain link in the job body
    for (const a of document.querySelectorAll('.listing-container a[href], .job-listing a[href]')) {
      if (a.href && !a.href.includes('weworkremotely.com') && /apply|careers|job/i.test(a.href + a.innerText)) return a.href;
    }
    return null;
  }).catch(() => null);

  return atsUrl || null;
}

// Cloudflare bot-wall ("Performing security verification" + cf-turnstile-response). It solves
// itself with JS enabled; wait up to ~15s for the challenge markup to disappear so the real
// board page can render its apply link.
async function clearCloudflareChallenge(page) {
  const onChallenge = () => page.evaluate(() =>
    /performing security verification|verify you are (not a bot|human)|checking your browser/i.test(document.body?.innerText || '')
    || !!document.querySelector('input[name="cf-turnstile-response"], #challenge-error-text')
  ).catch(() => false);
  if (!(await onChallenge())) return;
  flog('cloudflare challenge detected on', hostOf(page.url()), '— waiting for it to clear');
  for (let i = 0; i < 15; i++) {
    await SLEEP(1000);
    if (!(await onChallenge())) { flog('cloudflare challenge cleared'); await SLEEP(1500); return; }
  }
  flog('cloudflare challenge did NOT clear on', hostOf(page.url()));
}

async function toForm(page) {
  const u = page.url();
  if (/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}$/.test(u)) { await page.goto(u + '/apply', { waitUntil: 'domcontentloaded' }); return; }
  if (/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}\/?$/.test(u)) { await page.goto(u.replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded' }); return; }

  // lnkd.in shortlinks — follow the redirect to the real URL before processing as a form.
  if (/lnkd\.in\//.test(u)) {
    await SLEEP(3000); // let the initial redirect land
    // Wait up to 8 seconds total for the URL to navigate away from lnkd.in.
    await page.waitForURL(url => !url.includes('lnkd.in'), { timeout: 8000 }).catch(() => {});
    const landed = page.url();
    flog('lnkd.in redirect landed on', landed);

    // LinkedIn "You're leaving LinkedIn" interstitial. Detect it by its content (the
    // external_url_click button or the "not on LinkedIn" heading) rather than the URL host,
    // because the interstitial is sometimes served on the lnkd.in host itself.
    const target = await linkedinInterstitialTarget(page);
    if (target) {
      flog('followed LinkedIn interstitial →', target, ATS_RE.test(target) ? '(ATS/Google Form)' : '');
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await SLEEP(2000);
      return;
    }

    if (/lnkd\.in\//.test(landed)) {
      // Still on lnkd.in — try grabbing the canonical href from the page redirect element.
      const href = await page.evaluate(() => {
        const a = document.querySelector('a[href], meta[http-equiv="refresh"]');
        if (a?.tagName === 'A') return a.href;
        if (a?.tagName === 'META') { const m = a.content.match(/url=([^\s;]+)/i); return m ? m[1] : null; }
        // Look for any anchor that doesn't point back to lnkd.in.
        for (const el of document.querySelectorAll('a[href]')) {
          if (!el.href.includes('lnkd.in') && el.href.startsWith('http')) return el.href;
        }
        return null;
      }).catch(() => null);
      if (href && !href.includes('lnkd.in')) {
        await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      } else {
        // Last resort: click any visible <a> link that isn't a lnkd.in URL.
        const offDomain = page.locator('a[href]:not([href*="lnkd.in"])').first();
        if (await offDomain.isVisible().catch(() => false)) {
          await offDomain.click().catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        }
      }
    }
    await SLEEP(2000);
    if (/lnkd\.in\//.test(page.url())) flog('gave up: still on lnkd.in, no external target found');
  }

  // Cloudflare "Performing security verification" / Turnstile interstitial (seen on himalayas.app
  // and other boards). The challenge auto-solves in a few seconds, then the real page loads — so
  // wait for it to clear before scanning for apply links instead of treating the challenge page
  // (which has no apply link) as "no form found".
  await clearCloudflareChallenge(page);

  const startHost = hostOf(page.url());
  const onBoard = BOARD_HOST.test(startHost);
  // On a real ATS page that already shows a form, stop.
  if (!onBoard) {
    const fileInputs = await page.locator('input[type="file"]').count();
    const textInputs = await page.locator('input[type="text"]:visible, input[type="email"]:visible').count();
    if (fileInputs || textInputs >= 2) return;
  }

  // Himalayas.app — find the "Apply now" external link pointing to real ATS.
  if (/himalayas\.app/.test(startHost)) {
    // First, try clicking an "Apply now" / "Apply" button — it may trigger a modal or navigate.
    const applyBtn = page.locator('a[href*="apply"], button').filter({ hasText: /apply( now)?/i }).first();
    if (await applyBtn.isVisible().catch(() => false)) {
      const [popup] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null),
        applyBtn.click().catch(() => {}),
      ]);
      if (popup) {
        await popup.waitForLoadState('domcontentloaded').catch(() => {});
        const popupUrl = popup.url();
        await popup.close().catch(() => {});
        if (popupUrl && !popupUrl.includes('himalayas.app')) {
          await page.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await SLEEP(2500);
          return;
        }
      }
      await SLEEP(2000);
      // If the click navigated away from himalayas, we're done.
      if (!page.url().includes('himalayas.app')) { await SLEEP(1000); return; }
    }
    // Now scan for ATS links (post-click modal content may have added new links).
    const atsUrl = await page.evaluate(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        if (/(greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|bamboohr|jobvite|teamtailor|rippling|personio|apply)/i.test(a.href)
          && !a.href.includes('himalayas.app')) return a.href;
      }
      // fallback: any off-domain link in an apply/cta button
      for (const a of document.querySelectorAll('a[href]')) {
        const txt = (a.innerText || '').toLowerCase();
        if ((txt.includes('apply') || txt.includes('apply now')) && !a.href.includes('himalayas.app')) return a.href;
      }
      return null;
    }).catch(() => null);
    if (atsUrl) { flog('himalayas.app → outbound apply link', atsUrl, ATS_RE.test(atsUrl) ? '(ATS)' : ''); await page.goto(atsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); await SLEEP(2500); return; }
    flog('himalayas.app: no outbound apply link found (page may still be behind Cloudflare)');
  }

  // Jobicy.com — detect off-site apply pattern early.
  // Jobicy is a job board that links out to the employer's ATS via an auth-gated "Apply Now"
  // button (jv-open-apply-auth). The page itself never contains a fillable application form.
  // Strategy:
  //   1. Check if there's a real embedded form (rare, template-version 1 layouts).
  //   2. Otherwise look for any direct off-domain apply link in the jv-application-body or
  //      in the page <head>/<meta> canonical; if found, navigate there directly.
  //   3. The "Continue on the employer website" widget: current jobicy templates (v6) render the
  //      apply control client-side into `#_w_<jobid>` (data-t="Apply Now", data-native-apply-*),
  //      and the real employer URL is produced only when it is clicked (opens a new tab). So the
  //      resolver must CLICK that rendered button and capture the resulting popup/navigation.
  //   4. Only if nothing resolves do we leave jobicy (applyForm reports no form → route elsewhere).
  if (/jobicy\.com/.test(startHost)) {
    const resolved = await page.evaluate(() => {
      // 1. Real embedded form on the page?
      const form = document.querySelector('#job-application form:not(.jobicy_unified_form):not(.jh-search), .application-form form');
      if (form && form.querySelectorAll('input[type="text"], input[type="email"], textarea').length > 1) return { type: 'form' };
      // 2. Direct external ATS link anywhere in the apply section
      for (const a of document.querySelectorAll('.jv-application-body a[href], .jv-apply-section a[href], .candidates_can_apply a[href]')) {
        if (a.href && !a.href.includes('jobicy.com') && /^https?:\/\//.test(a.href)) return { type: 'ats', url: a.href };
      }
      // 3. Any off-domain apply link on the page
      for (const a of document.querySelectorAll('a[href]')) {
        if (/apply/i.test(a.innerText + a.getAttribute('aria-label') || '') && a.href && !a.href.includes('jobicy.com') && /^https?:\/\//.test(a.href)) return { type: 'ats', url: a.href };
      }
      // 4. "Continue on the employer website" native-apply widget (template v6): #_w_<id> with
      //    data-t="Apply Now". Its URL is only produced on click, so flag it for a click-and-capture.
      if (document.querySelector('[id^="_w_"][data-t], [data-native-apply-initialized], .jv-application-primary [data-m]')) return { type: 'widget' };
      // 5. Older auth-gated off-site apply → signal needs_manual
      if (document.querySelector('#jv-open-apply-auth, .jv-apply-primary, .jobs-offsite-apply-confirmation-banner')) return { type: 'offsite' };
      return null;
    }).catch(() => null);
    flog('jobicy.com resolved as', resolved?.type || 'none');

    if (resolved?.type === 'ats') {
      flog('jobicy.com → direct ATS link', resolved.url);
      await page.goto(resolved.url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      await SLEEP(2000);
      return; // continue to form-fill on the real ATS page
    }
    if (resolved?.type === 'form') {
      // scroll to #job-application if present on same page
      await page.evaluate(() => document.querySelector('#job-application')?.scrollIntoView()).catch(() => {});
      await SLEEP(1000);
      return;
    }
    if (resolved?.type === 'widget') {
      // Click the rendered "Apply Now" control and capture the employer tab/navigation.
      const applyWidget = page.locator('[id^="_w_"][data-t] a, [id^="_w_"][data-t] button, [id^="_w_"][data-t]')
        .first()
        .or(page.locator('.jv-application-primary').getByRole('button', { name: /apply/i }).first())
        .or(page.locator('.jv-application-primary').getByRole('link', { name: /apply/i }).first());
      if (await applyWidget.isVisible().catch(() => false)) {
        const [popup] = await Promise.all([
          page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null),
          applyWidget.click({ timeout: 6000 }).catch(() => {}),
        ]);
        if (popup) {
          await popup.waitForLoadState('domcontentloaded').catch(() => {});
          const dest = popup.url();
          await popup.close().catch(() => {});
          if (dest && !dest.includes('jobicy.com')) {
            flog('jobicy.com → employer site via Apply Now widget', dest, ATS_RE.test(dest) ? '(ATS)' : '');
            await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await SLEEP(2500);
            return;
          }
        }
        // Same-tab navigation fallback.
        await SLEEP(2500);
        if (!page.url().includes('jobicy.com')) { flog('jobicy.com → navigated to', page.url()); return; }
      }
      flog('jobicy.com: Apply Now widget did not resolve to an employer URL — routing elsewhere');
      return;
    }
    // offsite or unresolved — signal via returning without navigating; applyForm will detect no form
    flog('jobicy.com: off-site/auth-gated apply, no fillable form — routing to email/connect');
    return;
  }

  // Collect candidate apply links; on job boards follow them to the external ATS.
  const links = await page.locator('a:visible').evaluateAll(as => as
    .filter(a => /apply/i.test((a.innerText || '') + (a.getAttribute('aria-label') || '')))
    .map(a => a.href).filter(Boolean));
  const ctx = page.context();
  // Prefer links that already point off the board to a known ATS.
  const FORM_HOST = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|breezy|recruitee|bamboohr|jobvite|teamtailor|rippling|personio|forms\.gle|google\.com\/forms|typeform|tally\.so/i;
  const direct = links.find(l => FORM_HOST.test(l));
  if (direct) { await page.goto(direct, { waitUntil: 'domcontentloaded' }).catch(() => {}); await SLEEP(2500); return followRedirect(page, startHost); }

  const btn = page.getByRole('link', { name: /apply (now|for this job|to this)|^apply$|i.?m interested/i }).or(page.getByRole('button', { name: /apply (now|for this job)|^apply$/i })).first();
  if (await btn.isVisible().catch(() => false)) {
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null), btn.click().catch(() => {})]);
    if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); const url = popup.url(); await popup.close().catch(() => {}); await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); }
    await SLEEP(3000);
    return followRedirect(page, startHost);
  }
}

// Boards often use an interstitial /l/<id> that 302s to the ATS. If we're still on the
// board host, click the apply link once more and wait for the host to change.
async function followRedirect(page, startHost) {
  for (let i = 0; i < 2 && hostOf(page.url()) === startHost; i++) {
    const relay = await page.locator('a[href*="/l/"], a[rel~="external"], meta[http-equiv="refresh"]').first();
    const href = await page.locator('a:visible', { hasText: /apply/i }).first().getAttribute('href').catch(() => '');
    if (href && hostOf(href) !== startHost) { await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {}); await SLEEP(2500); }
    else break;
  }
}


async function fillAll(page, unknown, job = {}) {
  const p = getProfile();
  const selection = selectCvVariant(job, p);
  if (job.url) setFields(job.url, { selected_cv_id: selection.id, selected_cv_path: selection.path, selected_cv_reason: selection.reason });
  const cvPath = cvAttachmentForJob(job, p);
  const fields = await page.evaluate(SCAN);
  const radios = {};
  for (const f of fields) {
    const loc = page.locator(`[data-jf="${f.id}"]`);
    try {
      if (f.type === 'file') {
        const isCover = /cover/i.test(f.q + f.name);
        if (!isCover && cvPath && fs.existsSync(cvPath)) { await loc.setInputFiles(cvPath); await SLEEP(1500); }
        continue;
      }
      if (f.type === 'radio') { (radios[f.name || f.q] ||= []).push(f); continue; }
      if (f.type === 'checkbox') {
        if (!f.checked && (/agree|consent|acknowledge|privacy|terms|confirm|certify/i.test(f.q + f.optLabel) || f.required)) await loc.check({ force: true }).catch(() => {});
        continue;
      }
      if (f.tag === 'SELECT') {
        if (f.val) continue;
        const pick = choiceAnswer(f.q, f.opts.slice(1)) ; if (pick) await loc.selectOption({ label: pick }).catch(() => {}); else if (f.required) unknown.add(f.q);
        continue;
      }
      if (f.val && f.val.trim()) continue;
      if (f.role === 'combobox' || /select/i.test(f.q) && f.tag === 'INPUT' && f.type === 'text' && await loc.getAttribute('aria-autocomplete').catch(() => null)) {
        // react-select: open, read options, pick
        await loc.click().catch(() => {}); await SLEEP(600);
        const opts = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
        let pick = opts.length ? choiceAnswer(f.q, opts) : textAnswer(f.q);
        if (!opts.length && pick) { await loc.fill(pick); await SLEEP(1200); }
        const key = pick ? pick.split(/[\s+(]/).filter(Boolean)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        const opt = key ? page.locator('[role="option"]').filter({ hasText: new RegExp('^\\s*' + key, 'i') }).first() : page.locator('[role="option"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        else { await loc.press('Enter').catch(() => {}); if (f.required && !pick) unknown.add(f.q); }
        await page.keyboard.press('Escape').catch(() => {});
        continue;
      }
      const numeric = f.type === 'number';
      let v = textAnswer(f.q, { numeric });
      if ((v == null || v === '') && f.tag === 'TEXTAREA') v = coverText(p);
      if (v == null || v === '') { if (f.required) unknown.add(f.q); continue; }
      await loc.fill(String(v));
      if (/phone|mobile/i.test(f.q)) await page.keyboard.press('Escape').catch(() => {});
      if (/location|city/i.test(f.q)) { await SLEEP(1200); const o = page.locator('[role="option"], .pac-item').first(); if (await o.isVisible().catch(() => false)) await o.click().catch(() => {}); }
    } catch {}
  }
  for (const g of Object.values(radios)) {
    if (g.some(r => r.checked)) continue;
    const pick = choiceAnswer(g[0].q, g.map(r => r.optLabel));
    const r = g.find(x => x.optLabel === pick) || g[0];
    await page.locator(`[data-jf="${r.id}"]`).check({ force: true }).catch(() => {});
  }
  return fields.length;
}

export async function applyForm({ url, timeoutMs = 120000, submit = true, job = {} }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const unknown = new Set();
  const t0 = Date.now();
  // Guard: these are never application-form hosts. Driving a form fill on a Gmail/accounts page or
  // the LinkedIn feed is a mistake (it produced stale encounters like #49). Return no_form so the
  // applier lane marks the lead 'skipped' (not 'failed') without ever navigating the page.
  const NON_APPLY_HOST = /(^|\.)(mail\.google\.com|accounts\.google\.com)$|linkedin\.com\/feed/i;
  if (NON_APPLY_HOST.test(url)) {
    await page.close().catch(() => {});
    return { ok: false, result: 'no_form', detail: 'non-application host (mail/accounts/feed)', finalUrl: url };
  }
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await SLEEP(3500);
    await toForm(page);
    await SLEEP(1500);
    const finalUrl = page.url();
    flog('resolved', url, '→', finalUrl, 'host=' + hostOf(finalUrl));

    // ── Indeed: try to extract the real ATS link before bailing out.
    if (/indeed\.com/.test(finalUrl)) {
      const atsLink = await resolveIndeed(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
        // fall through and let the rest of applyForm handle the real ATS page
      } else {
        const bail = await boardBail(page, finalUrl);
        if (bail) return bail;
        await encounter('form', 'indeed.com — no external ATS link found; routing to connect/email', { url: finalUrl, page });
        return { ok: false, result: 'needs_manual', detail: 'indeed.com — route via connect or email', finalUrl };
      }
    }

    // ── Glassdoor: click through to the employer's ATS.
    if (/glassdoor\.com/.test(page.url())) {
      const atsLink = await resolveGlassdoor(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
      } else {
        const bail = await boardBail(page, page.url());
        if (bail) return bail;
        await encounter('form', 'glassdoor.com — "Apply on company site" not found; routing to connect/email', { url: page.url(), page });
        return { ok: false, result: 'needs_manual', detail: 'glassdoor.com — route via connect or email', finalUrl };
      }
    }

    // ── WeWorkRemotely: resolve the employer's direct apply URL.
    if (/weworkremotely\.com/.test(page.url())) {
      const atsLink = await resolveWeWorkRemotely(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
      } else {
        await encounter('form', 'weworkremotely.com — no external apply link found', { url: page.url(), page });
        return { ok: false, result: 'needs_manual', detail: 'weworkremotely.com — no external apply link', finalUrl };
      }
    }

    if (/linkedin\.com\/(login|authwall)/.test(page.url())) { await encounter('form', 'redirected to linkedin login/authwall', { url: page.url(), page }); return { ok: false, result: 'needs_manual', detail: 'redirected to ' + page.url().slice(0, 80), finalUrl }; }
    if (/workday|myworkdayjobs|icims|taleo|successfactors|oraclecloud|brassring/.test(finalUrl)) return { ok: false, result: 'needs_manual', detail: 'account-gated ATS (Workday/iCIMS/Taleo) — one-click for you', finalUrl };

    let n = await fillAll(page, unknown, job);
    if (n < 2) {
      // still on a job-board description page with no real form → hand off with the direct link
      if (BOARD_HOST.test(hostOf(finalUrl))) { flog('gave up: still on board host', hostOf(finalUrl), '— no external ATS form resolved'); await encounter('form', 'job-board page, no external ATS form found on ' + hostOf(finalUrl), { url: finalUrl, page }); return { ok: false, result: 'needs_manual', detail: 'board page — open the apply link manually', finalUrl }; }
      flog('gave up: no application form on', hostOf(finalUrl), '(fields found:', n + ')');
      await encounter('form', 'no application form found on ' + hostOf(finalUrl), { url: finalUrl, page });
      return { ok: false, result: 'no_form', detail: 'no application form found', finalUrl };
    }
    await SLEEP(800);
    n = await fillAll(page, unknown, job); // second pass: conditional fields that appeared

    // recompute unknown required: only those still empty
    const still = (await page.evaluate(SCAN)).filter(f => f.required && f.type !== 'file' && f.type !== 'checkbox' && (f.type === 'radio' ? false : !String(f.val || '').trim()));
    if (process.env.DEBUG_FORMS) console.log('STILL', JSON.stringify(still, null, 1));
    const missing = still.map(f => f.q).filter(Boolean);
    if (missing.length) { missing.forEach(q => askLater(q)); return { ok: false, result: 'needs_manual', detail: 'unknown required: ' + missing.slice(0, 4).join(' | ').slice(0, 300), questions: missing, finalUrl }; }
    if (!submit) return { ok: true, result: 'dry_run_ready', detail: `filled ${n} fields`, finalUrl };

    await closeBlockingOverlays(page);

    // Prefer an explicit submit control (Workable's `[data-ui="apply-button"]`, Greenhouse/Lever
    // `button[type=submit]`) before falling back to the generic accessible-name match. The
    // submit button usually sits at the very bottom of a long form, so it can be below the fold
    // where a sticky footer/overlay intercepts a plain click — hence the scroll + forced + JS
    // click fallbacks instead of a single click() that hangs until the actionability timeout.
    // For jobicy.com, use a wider selector set with a longer timeout.
    const isJobicy = /jobicy\.com/.test(hostOf(page.url()));
    // Lever's real control is `<button id="btn-submit" type="button" class="template-btn-submit">`.
    // The page also has a hidden `<button id="hcaptchaSubmitBtn" type="submit" class="hidden">`.
    // Matching `button[type=submit]` first clicks that decoy (or treats it as "no submit button"
    // because it is hidden and disabled) and never reaches Submit application.
    const btn = isJobicy
      ? page.locator(
          'button[type="submit"], input[type="submit"], .apply-btn, #apply-button, a.apply-button'
        ).first()
          .or(page.locator('button').filter({ hasText: /submit|apply/i }).first())
        : page.locator(
          '#btn-submit, button.template-btn-submit, button[data-qa="btn-submit"], button[data-ui="apply-button"], [data-ui="submit"]'
        ).first()
          .or(page.locator('button[type="submit"]:not(#hcaptchaSubmitBtn):not(.hidden), input[type="submit"]').first())
          .or(page.getByRole('button', { name: /submit application|submit|send application|apply now|complete application|^apply$/i }).last())
          .or(page.locator('a[role="button"], a.postings-btn').filter({ hasText: /submit application|apply now/i }).first());
    const btnTimeout = isJobicy ? 8000 : 5000;
    // The submit control sits at the bottom of a long form. Scroll before the visibility check
    // so a below-the-fold button is not reported as missing.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await SLEEP(400);
    const btnExists = (await btn.count().catch(() => 0)) > 0;
    const btnVisible = btnExists && await btn.isVisible().catch(() => false);
    if (!btnExists || !btnVisible) {
      await encounter('form', 'form filled but no submit button on ' + hostOf(finalUrl), { url: finalUrl, page });
      return { ok: false, result: 'needs_manual', detail: 'no submit button', finalUrl };
    }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await SLEEP(300);
    let clicked = await btn.click({ timeout: btnTimeout }).then(() => true).catch(() => false);
    if (!clicked) clicked = await btn.click({ force: true, timeout: btnTimeout }).then(() => true).catch(() => false);
    if (!clicked) clicked = await btn.evaluate(el => { el.click(); return true; }).catch(() => false);
    if (!clicked) { await encounter('form', 'submit button not clickable on ' + hostOf(finalUrl), { url: finalUrl, page }); return { ok: false, result: 'needs_manual', detail: 'submit button not clickable', finalUrl }; }
    for (let i = 0; i < 20; i++) {
      await SLEEP(1000);
      const t = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (CONFIRM_RE.test(t) || /\/(thanks|thank-you|confirmation|success)/i.test(page.url())) return { ok: true, result: 'submitted', detail: 'confirmation page shown', finalUrl };
      // Jobicy-specific confirmation: dashboard/my-applications tab visible, URL changed to profile/dashboard,
      // or jobicy appends ?registered=<email> to the job URL after a successful application.
      if (isJobicy && (
        await page.locator('#tab-my-applications').isVisible().catch(() => false) ||
        /\/(my-applications|dashboard|profile)/i.test(page.url()) ||
        /[?&]registered=/i.test(page.url())
      )) return { ok: true, result: 'submitted', detail: 'jobicy — application registered (confirmed via URL params)', finalUrl };
      // Jobicy guest-apply verification gate: after submit, jobicy shows an email-OTP step
      // (#step-verification / #code-inputs — "We sent a 6-digit code to this address") and/or a
      // Cloudflare Turnstile CAPTCHA (#turnstile-wrapper / #jobicy-turnstile-widget). Neither can be
      // completed automatically, so the 20 s wait would always time out and log a misleading
      // "submitted but no confirmation" encounter (the dominant cause of encounter #6, ×8) while the
      // lead gets re-attempted. Bail out early as needs_manual so it's routed via email/connect instead.
      if (isJobicy && await page.evaluate(() => {
        const vis = el => !!el && el.offsetParent !== null && !el.classList.contains('hidden-step');
        return vis(document.querySelector('#step-verification')) ||
               vis(document.querySelector('#code-inputs')) ||
               vis(document.querySelector('#turnstile-wrapper')) ||
               !!document.querySelector('#jobicy-turnstile-widget iframe');
      }).catch(() => false)) {
        await encounter('form', 'jobicy — email OTP / Turnstile verification gate after submit', { url: page.url(), page });
        return { ok: false, result: 'needs_manual', detail: 'jobicy guest-apply needs email verification code + CAPTCHA — route via email/connect', finalUrl };
      }
      if (/captcha|verify you are human/i.test(t) && i > 4) return { ok: false, result: 'needs_manual', detail: 'captcha after submit', finalUrl };
    }
    const errs = await page.locator('[role="alert"], .error, [class*="error"]').allInnerTexts().catch(() => []);
    await encounter('form', 'submitted but no confirmation on ' + hostOf(page.url()), { url: page.url(), page });
    return { ok: false, result: 'needs_manual', detail: 'no confirmation; ' + errs.filter(Boolean).slice(0, 3).join(' | ').slice(0, 200), finalUrl };
  } catch (e) {
    await encounter('form', 'exception: ' + e.message.split('\n')[0], { url, page }).catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}
