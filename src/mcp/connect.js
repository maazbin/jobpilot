// src/mcp/connect.js — LinkedIn connection request with a personalized note (2026 UI).
// Robust to the two profile layouts:
//   A) primary action = "Connect" / "Invite <name> to connect" (button or link) in the top card
//   B) primary action = "Follow"; Connect lives under the top-card "More" menu as a role=link
// Scopes to the MAIN column (x<850) so sidebar "Invite ... to connect" buttons are never clicked.
// Note is attached when LinkedIn allows it; if the free note quota is exhausted it sends without one.
// result: connected | connected_no_note | already_pending | already_connected | no_connect | limit | error
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { encounter } from '../evolve.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

export function connectNote({ posterName, role, company }) {
  const p = getProfile();
  const first = (posterName || '').split(/\s+/)[0];
  const hi = /^[A-Z][a-z]{1,15}$/.test(first) ? `Hi ${first}, ` : 'Hi, ';
  const r = role && role.length < 45 ? role : 'the role';
  const co = company && company.length < 30 ? ` at ${company}` : '';
  const yrs = p.yearsExperience ? `${p.yearsExperience}+ yrs ` : '';
  const skills = (p.skills || []).slice(0, 3).join('/') || 'software';
  let note = `${hi}saw your post about ${r}${co}. I'm a ${p.headline || 'software engineer'} (${yrs}${skills}) and would love to be considered — happy to share my CV. ${p.links?.portfolio || ''}`;
  if (note.length > 200) note = `${hi}saw your post about ${r}${co}. ${p.headline || 'Engineer'}, ${yrs}${skills}. Would love to be considered. ${p.links?.portfolio || ''}`;
  return note.slice(0, 200);
}

// first matching button/link in the MAIN column (not the sidebar)
async function mainCol(page, re) {
  for (const role of ['button', 'link']) {
    const loc = page.getByRole(role, { name: re });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
      if (inAside) continue;
      const b = await el.boundingBox().catch(() => null);
      if (b && b.x < 850 && b.y > 60) return el;
    }
  }
  return null;
}

// LinkedIn opens a Premium upsell ("Send unlimited personalized invites with Premium" /
// "You're out of free custom notes") instead of the note editor once the free custom-note quota
// is exhausted — see the saved connect encounter (screenshot shows the modal with only a
// Dismiss/Close × and an "Upgrade to Premium" button; no Send/textarea). A connection request
// should not fail just because an optional note is unavailable, so detect + dismiss it everywhere
// an invite note path can be reached, then continue sending the invite note-less.
// Returns true when the upsell was present and dismissed, else false.
async function dismissPremiumUpsell(page) {
  const copyRe = /out of free custom notes|send unlimited personalized invites|unlimited personalized invites with premium|upgrade to premium|restart premium/i;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const premiumCopy = page.getByText(copyRe).first();
  const premiumDialog = premiumCopy.locator('xpath=ancestor::*[@role="dialog"][1]');
  const premiumVisible = await premiumDialog.isVisible().catch(() => false);
  if (!premiumVisible && !copyRe.test(bodyText)) return false;
  const dismiss = premiumVisible
    ? premiumDialog.getByRole('button', { name: /dismiss|close/i }).first()
    : page.getByRole('button', { name: /dismiss|close/i }).last();
  await dismiss.click({ timeout: 2500 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
  await SLEEP(800);
  return true;
}

export async function connect({ profileUrl, posterName, role, company, withNote = true, dryRun = false }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(3000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await SLEEP(800);

    const main = page.locator('main');
    if (await mainCol(page, /^pending$/i)) { await page.close(); return { ok: true, result: 'already_pending', detail: 'invite already pending' }; }
    const mtext = await main.innerText().catch(() => '');
    if (/\b1st\b|· 1st/.test(mtext.slice(0, 400))) { await page.close(); return { ok: true, result: 'already_connected', detail: '1st-degree already' }; }

    // A) direct Connect in the main column
    let connectEl = await mainCol(page, /^connect$|^invite .* to connect$/i);
    // B) under the main-column More menu
    if (!connectEl) {
      const more = await mainCol(page, /^more$/i);
      if (more) { await more.click().catch(() => {}); await SLEEP(1200); connectEl = page.getByRole('link', { name: /invite .* to connect|^connect$/i }).first(); if (!await connectEl.count().catch(() => 0)) connectEl = page.getByRole('menuitem', { name: /^connect/i }).first(); }
    }
    if (!connectEl || !(await connectEl.count().catch(() => 0))) {
      await encounter('connect', 'no Connect control (follow-only or restricted)', { url: profileUrl, page });
      await page.close(); return { ok: true, result: 'no_connect', detail: 'no Connect option (follow-only / limits)' };
    }
    // LinkedIn 2026: the Connect control is often an <a href="/preload/custom-invite/?vanityName=...">
    // that NAVIGATES the page (full navigation, not an overlay). We capture the URL before clicking
    // so we can detect navigation and handle the custom-invite page directly.
    const urlBefore = page.url();
    await connectEl.click().catch(() => {});
    // Wait up to 6 s for either: a dialog to appear, OR a navigation away from the profile page.
    // LinkedIn 2026 uses a SPA router that may change the URL without firing waitForNavigation —
    // so we poll the URL manually as well.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {}),
      page.waitForSelector('dialog[open], div[role="dialog"], [data-test-modal]', { timeout: 6000 }).catch(() => {}),
      // Poll for URL change (covers SPA navigation that doesn't fire waitForNavigation)
      (async () => {
        for (let i = 0; i < 12; i++) {
          await SLEEP(500);
          if (page.url() !== urlBefore) return;
        }
      })(),
    ]).catch(() => {});
    await SLEEP(1000);
    const urlAfter = page.url();
    // navigated is true when the URL changed. The extra guard `!urlAfter.includes(urlBefore)` is
    // intentionally relaxed: only keep it for non-linkedin domains where one URL could embed another.
    // For LinkedIn profile → custom-invite navigation, the URLs share the linkedin.com domain but
    // differ in path, so a simple inequality check is sufficient and more reliable.
    const navigated = urlAfter !== urlBefore;

    if (process.env.DEBUG_CONN) console.log('after connect click; url:', urlAfter, 'navigated:', navigated);

    // note dialog (may be in shadow — getByRole pierces it)
    let usedNote = false;
    const note = connectNote({ posterName, role, company });

    // ── Custom-invite page (LinkedIn 2026 navigation flow) ────────────────────────
    // When the connect <a> navigates to /preload/custom-invite/ (or similar), the page
    // renders a standalone invite form with a textarea (the note) and a submit button.
    // Fill the textarea directly — there is no "Add a note" intermediate button.
    // Also handle the case where `navigated` is false but we're already on the custom-invite page
    // (LinkedIn SPA router sometimes changes the URL without firing Playwright's waitForNavigation).
    // Only treat this as the custom-invite flow when the URL is specifically an invite page.
    // The previous `/connect/i` match was far too broad — it matched almost any LinkedIn URL
    // (including a follow-only profile that never navigated to a real invite form), which drove
    // the code into the submit-button retry loop against unrelated disabled feed "Submit"
    // buttons. That mismatch was the dominant cause of encounter #20 (×48 "send button not found").
    const isCustomInviteUrl = /custom-invite|invitation|\/preload\/.*invite/i.test(urlAfter);
    if (navigated && isCustomInviteUrl) {
      if (withNote) {
        const ta = page.locator('textarea').first();
        const taVisible = await ta.isVisible().catch(() => false);
        if (taVisible) {
          await ta.fill(note).catch(() => {});
          await SLEEP(600);
          usedNote = true;
        } else {
          // Wait up to 4 s for textarea to appear (form may still be rendering)
          await ta.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
          if (await ta.isVisible().catch(() => false)) {
            await ta.fill(note).catch(() => {});
            await SLEEP(600);
            usedNote = true;
          }
          // No note textarea on this custom-invite page: the note is optional / not offered.
          // Proceed note-less rather than looping until the (disabled) submit never enables —
          // this was the dominant cause of encounter #20 (×48 "send button not found").
          else if (process.env.DEBUG_CONN) console.log('custom-invite: no note textarea, sending note-less');
        }
      }
      // The note editor is frequently replaced by the "out of free custom notes" Premium upsell
      // (the saved encounter #20 screenshot). Dismiss it and send the invite note-less rather than
      // falling into the submit-retry loop against the upsell/ad-dialog Submit buttons.
      if (await dismissPremiumUpsell(page)) usedNote = false;
      if (dryRun) {
        await page.goBack().catch(() => {});
        await page.close();
        return { ok: true, result: usedNote ? 'dry_note_ready' : 'dry_ready', detail: 'reached custom-invite page' + (usedNote ? ' with note' : ''), note: usedNote ? note : '' };
      }
      // Click the submit button on the custom-invite page (starts disabled, enables after textarea
      // fill). Prefer a submit scoped to a form/dialog that actually contains the note textarea —
      // a bare page-wide `button[type="submit"]` also matches unrelated disabled feed/search
      // "Submit" buttons (seen in encounter #20's snapshot), which never enable and cause a false
      // "send button not found" after the retry loop.
      const inviteForm = page.locator('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)').first();
      const inviteFormCount = await inviteForm.count().catch(() => 0);
      const submitScope = inviteFormCount ? inviteForm : page;
      const submitOnPage = submitScope.locator('button[type="submit"], input[type="submit"]').first();
      // Extra wait after fill to let the React/Vue change handler enable the submit button
      if (usedNote) await SLEEP(1000);
      // Retry up to 20×500 ms for the submit button to become enabled
      let submitReady = false;
      let submitEl = submitOnPage;
      for (let i = 0; i < 20 && !submitReady; i++) {
        const vis = await submitOnPage.isVisible().catch(() => false);
        const en = await submitOnPage.isEnabled().catch(() => false);
        if (vis && en) { submitReady = true; break; }
        // Also check by JS scan (obfuscated classes may prevent Playwright enable detection).
        // Only consider a submit button that lives in a form/dialog with a textarea (the invite
        // note form) and is NOT in the aside — a bare first `button[type="submit"]` can be an aside
        // ad-feedback dialog's "Submit", which never belongs to the invite.
        if (i >= 1) {
          const jsEnabled = await page.evaluate(() => {
            const scope = document.querySelector('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)');
            const btn = (scope || document).querySelector('button[type="submit"], input[type="submit"]');
            return btn ? (!btn.closest('aside') && !btn.disabled && btn.offsetParent !== null) : false;
          }).catch(() => false);
          if (jsEnabled) { submitReady = true; break; }
        }
        // Also scan for any visible enabled send button by text (LinkedIn 2026 uses "Send" text)
        if (i % 2 === 1) {
          const wideSend = page.getByRole('button', { name: /send without a note|send invitation|send now|^send$/i }).first();
          const wVis = await wideSend.isVisible().catch(() => false);
          const wEn = await wideSend.isEnabled().catch(() => false);
          if (wVis && wEn) { submitEl = wideSend; submitReady = true; break; }
          // JS scan for any enabled button with send-like text (handles obfuscated classes),
          // excluding aside buttons so the sidebar/ad-dialog controls never match.
          const jsSendBtn = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button, input[type="submit"]')];
            return btns.some(b => {
              if (b.closest('aside')) return false;
              const txt = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
              return /^send$|send invitation|send without a note|send now/.test(txt) && !b.disabled && b.offsetParent !== null;
            });
          }).catch(() => false);
          if (jsSendBtn) { submitReady = true; break; }
        }
        await SLEEP(500);
      }
      if (!submitReady) {
        // Last-resort recovery before giving up (was the #1 encounter, ×48):
        // 1) JS-click any visible send/submit control even if Playwright couldn't confirm it enabled
        //    (LinkedIn's obfuscated classes defeat the isEnabled() heuristic on note-less invites).
        const jsClicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, input[type="submit"]')];
          const target = btns.find(b => {
            if (b.offsetParent === null) return false;
            if (b.closest('aside')) return false; // never the aside ad-feedback "Submit" buttons
            const txt = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
            // A type=submit only counts when it sits in a form/dialog that also has the note
            // textarea — otherwise it may be an unrelated ad-feedback Submit outside the invite.
            const inNoteForm = !!b.closest('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)');
            const isSend = /^send$|send invitation|send without a note|send now/.test(txt) || (b.type === 'submit' && inNoteForm);
            return isSend;
          });
          if (target) { target.disabled = false; target.click(); return true; }
          return false;
        }).catch(() => false);
        if (jsClicked) {
          await SLEEP(3000);
          const body = await page.locator('body').innerText().catch(() => '');
          if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(body)) {
            await page.close();
            return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' };
          }
          const pendingNow = !!(await mainCol(page, /^pending$/i)) || /invitation sent|pending/i.test(body.slice(0, 2000));
          if (pendingNow) {
            await page.close();
            return { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: 'invite sent via custom-invite JS fallback', note: usedNote ? note : '' };
          }
        }
        await encounter('connect', 'send button not found in invite dialog', { url: profileUrl, page });
        await page.close();
        return { ok: false, result: 'error', detail: 'send button not found on custom-invite page' };
      }
      let sent = await submitEl.click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (!sent) sent = await submitEl.evaluate(el => el.click()).then(() => true).catch(() => false);
      await SLEEP(3000);
      const bodyAfter = await page.locator('body').innerText().catch(() => '');
      if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(bodyAfter)) {
        await page.close();
        return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' };
      }
      await page.close();
      return { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: usedNote ? 'invite + note sent via custom-invite page' : 'invite sent via custom-invite page', note: usedNote ? note : '' };
    }

    // ── Classic overlay / dialog flow (non-navigation, dialog appears on same page) ─
    await SLEEP(1000); // extra settle time if no navigation
    if (process.env.DEBUG_CONN) console.log('after connect click; addNote count', await page.getByRole('button', { name: /add a note/i }).count());

    if (withNote) {
      const addNote = page.getByRole('button', { name: /add a note/i }).first();
      if (await addNote.isVisible().catch(() => false)) {
        await addNote.click(); await SLEEP(1000);
        const ta = page.locator('textarea').first();
        await ta.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await ta.isVisible().catch(() => false)) { await ta.fill(note); await SLEEP(400); usedNote = true; }
        else if (process.env.DEBUG_CONN) console.log('textarea not visible after addNote');

        // Free custom-note quota exhausted → LinkedIn shows the Premium upsell instead of the
        // note editor. Dismiss it and continue with a note-less invitation.
        if (await dismissPremiumUpsell(page)) usedNote = false;
      } else {
        // LinkedIn 2026: no intermediate "Add a note" button — textarea may be directly visible in the dialog
        const ta = page.locator('dialog textarea, div[role="dialog"] textarea').first();
        if (await ta.isVisible().catch(() => false)) {
          await ta.fill(note).catch(() => {});
          await SLEEP(400);
          usedNote = true;
        } else if (await dismissPremiumUpsell(page)) {
          // No note textarea because the "out of free custom notes" Premium upsell took its place.
          // Dismiss it and continue to the Send/pending detection, sending note-less.
          usedNote = false;
        }
      }
    }
    if (dryRun) { await page.keyboard.press('Escape').catch(() => {}); await SLEEP(400); await page.getByRole('button', { name: /discard/i }).first().click({ timeout: 2500 }).catch(() => {}); await page.close(); return { ok: true, result: usedNote ? 'dry_note_ready' : 'dry_ready', detail: 'reached send' + (usedNote ? ' with note' : ''), note: usedNote ? note : '' }; }

    // The invite dialog (role=dialog / artdeco modal, or the 2026 native <dialog>) carries the
    // Send control. IMPORTANT: do NOT use `has: getByRole('button', SEND_RE)` to locate the
    // dialog — that filter ignores disabled buttons, so it fails while the send button is
    // briefly disabled/animating after open.  Instead find the dialog by its always-present
    // dismiss/close button, then look for send within it with a generous retry loop.
    // LinkedIn 2026 uses "Send" / "Send invitation" / "Send now" / "Send without a note"
    // in native <dialog> elements. The blanket `^submit$` was dropped: the snapshot proves the
    // only `type="submit"` "Submit" buttons on this page belong to the aside ad-feedback dialogs
    // ("Ad Options" / "Don't want to see this"), and matching them was the dominant cause of the
    // ×48 "send button not found" misfire. The real invite submit is reached via the dialog-scoped
    // `button[type="submit"]` lookup below, which requires a note textarea in the same scope.
    const SEND_RE = /send without a note|send invitation|send now|^send$/i;
    // Wait up to 8 s for ANY dialog/modal to appear after the Connect/Add-note click.
    // The 2026 LinkedIn UI uses obfuscated gfl* class names — we can't rely on .artdeco-modal.
    // Cast a wide net: div[role="dialog"], native <dialog[open]>, any element with a dismiss/close
    // button indicating a modal overlay is open, or a role=dialog nested anywhere.
    // Hidden stale dialogs are often kept in the DOM by LinkedIn after a previous overlay.
    // Selecting the first matching node could scope the send lookup to that hidden dialog and
    // miss the live invite modal entirely. Restrict the candidate set to visible overlays.
    const inviteDlg = page.locator('div[role="dialog"]:visible, dialog[open]:visible, [data-test-modal]:visible, [data-artdeco-is-focused-dialog]:visible').first();
    await inviteDlg.waitFor({ state: 'visible', timeout: 8000 }).catch(async () => {
      // 2026 LinkedIn may use a non-standard overlay without role=dialog.
      // Fall back: wait for any new visible button containing "send" text to appear.
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some(b =>
          /send/i.test(b.textContent || b.getAttribute('aria-label') || '') &&
          b.offsetParent !== null && !b.disabled),
        { timeout: 5000 }
      ).catch(() => {});
    });
    // Build dialog scope — prefer narrowed scope but fall back to whole page
    const dlgCount = await inviteDlg.count().catch(() => 0);
    const dlgScope = dlgCount ? inviteDlg : page;
    let send = dlgScope.getByRole('button', { name: SEND_RE }).first();
    // Also try type=submit — but ONLY inside a form/dialog that also holds the note textarea,
    // mirroring the custom-invite block. A bare dialog-wide `type="submit"` also matches the aside
    // ad-feedback dialogs' "Submit" buttons (snapshot offsets 61863 / 120093), which never belong
    // to an invite and never enable — that false match drove the ×48 "send button not found".
    // NOTE: after filling the textarea (usedNote=true), the submit button becomes enabled —
    // check for it regardless of enabled state first, then wait for it to enable.
    const submitScope = page.locator('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)').first();
    const submitScopeCount = await submitScope.count().catch(() => 0);
    const submitBtn = (submitScopeCount ? submitScope : dlgScope).locator('button[type="submit"], input[type="submit"]').first();
    // Retry up to 14×800 ms — the send button starts disabled and enables after the dialog animates in.
    let sendVisible = false;
    for (let i = 0; i < 14 && !sendVisible; i++) {
      sendVisible = await send.isVisible().catch(() => false);
      if (!sendVisible) {
        // also try enabled check — button may be visible but still disabled
        const enabled = await send.isEnabled().catch(() => false);
        if (enabled) { sendVisible = true; break; }
        // Try type=submit fallback within the dialog — check visibility only (may still be disabled briefly)
        const subVis = await submitBtn.isVisible().catch(() => false);
        const subEn = await submitBtn.isEnabled().catch(() => false);
        if (subVis && subEn) { send = submitBtn; sendVisible = true; break; }
        // If note was typed and submit is visible but still disabled, keep retrying (it will enable)
        if (usedNote && subVis && i < 10) { await SLEEP(800); continue; }
        // 2026 LinkedIn: try page-wide role=button scan every other iteration
        if (i % 2 === 1) {
          const wideSend = page.getByRole('button', { name: SEND_RE }).first();
          if (await wideSend.isVisible().catch(() => false)) { send = wideSend; sendVisible = true; break; }
        }
        await SLEEP(800);
      }
    }
    if (!sendVisible) {
      // 2026 LinkedIn sometimes sends immediately on Connect click (no dialog / quota exhausted note path)
      // Check: Pending button, or "Pending" text anywhere in the top card area
      if (await mainCol(page, /^pending$/i)) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent instantly (no dialog)' }; }
      const bodyTxt = await page.locator('main').innerText().catch(() => '');
      if (/pending/i.test(bodyTxt.slice(0, 1000))) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent (pending state detected)' }; }

      // Secondary scan: LinkedIn 2026 UI may render the send button outside the dialog scope
      // or use aria-label variations not matched by the role query above.
      const secondarySend = page.locator('button:not(aside button)').filter({ hasText: /^send$/i })
        .or(page.locator('[aria-label*="send" i]:not(aside [aria-label*="send" i])')).first();
      if (await secondarySend.isVisible().catch(() => false)) {
        await secondarySend.click({ timeout: 5000 }).catch(() => {});
        await SLEEP(3000);
        if (await mainCol(page, /^pending$/i)) {
          await page.close();
          return { ok: true, result: 'connected_no_note', detail: 'invite sent via secondary send scan' };
        }
      }

      // Tertiary scan: any button inside a modal, dialog, or overlay whose text includes "send".
      // The 2026 UI uses gfl* obfuscated classes — use a JS evaluate to find any visible "send" button.
      const jsSent = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
        const sendBtn = buttons.find(b => {
          if (b.closest('aside')) return false; // never the aside ad-feedback / sidebar buttons
          const txt = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim().toLowerCase();
          return /^send$|send invitation|send without a note|send now/.test(txt) &&
                 b.offsetParent !== null && !b.disabled;
        });
        if (sendBtn) { sendBtn.click(); return true; }
        return false;
      }).catch(() => false);
      if (jsSent) {
        await SLEEP(3000);
        const pendingNow = !!(await mainCol(page, /^pending$/i));
        const bodyNow = await page.locator('body').innerText().catch(() => '');
        if (pendingNow || /pending|invitation sent/i.test(bodyNow.slice(0, 2000))) {
          await page.close();
          return { ok: true, result: 'connected_no_note', detail: 'invite sent via JS send button scan' };
        }
      }

      // Also try a broader send button scan on the full page as last resort
      const pageSend = page.getByRole('button', { name: SEND_RE }).first();
      if (await pageSend.isVisible().catch(() => false)) {
        sendVisible = true;
        await pageSend.click({ timeout: 5000 }).catch(() => {});
        await SLEEP(3000);
        await page.close();
        return { ok: true, result: 'connected_no_note', detail: 'invite sent via page-level send button' };
      }
      await encounter('connect', 'send button not found in invite dialog', { url: profileUrl, page });
      await page.close(); return { ok: false, result: 'error', detail: 'send button not found in invite dialog' };
    }
    await send.scrollIntoViewIfNeeded().catch(() => {});
    let sent = await send.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!sent) sent = await send.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (!sent) await send.evaluate(el => el.click()).catch(() => {});
    // Wait up to 3000 ms for the dialog to close and the pending state to appear.
    await SLEEP(3000);
    const txt = await page.locator('body').innerText().catch(() => '');
    if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(txt)) { await page.close(); return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' }; }
    // Check dialog-gone as an additional confirmation signal.
    // The 2026 LinkedIn UI dropped data-test-modal-id; check for any visible role=dialog instead.
    const dialogClosed = (await page.locator('div[role="dialog"]:visible, dialog[open]:visible').count().catch(() => 1)) === 0;
    const pending = !!(await mainCol(page, /^pending$/i)) || /invitation sent|pending/i.test(txt.slice(0, 3000)) || dialogClosed;
    await page.close();
    return pending
      ? { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: usedNote ? 'invite + note sent' : 'invite sent (note quota likely exhausted)', note: usedNote ? note : '' }
      : { ok: false, result: 'error', detail: 'no Pending state after send' };
  } catch (e) {
    await encounter('connect', 'exception: ' + e.message.split('\n')[0], { url: profileUrl, page }).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 160) };
  }
}
