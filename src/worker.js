// src/worker.js — the always-on engine. Four lanes run CONCURRENTLY (own tab each),
// so scraping never blocks applying and email never blocks Easy Apply:
//   scout     — scrape LinkedIn posts/jobs (freshest first) + web (HN/Reddit/boards); UCB-ranked queries
//   mailer    — email leads (LinkedIn posts first, then web), newest posted first
//   applier   — Easy Apply + external forms, interleaved, newest first
//   connector — connection request + note to the poster
// Priority is encoded in the queue ordering (email: LI-post first; everything: newest posted first).
// Pacing is brisk but jittered; daily caps + dedup are always enforced. Everything self-records
// into the evolution memory (encounters, harvested answers, query/domain stats).
import fs from 'fs';
import path from 'path';
import { launchChrome } from './mcp/chrome.js';
import { verifyLogins } from './agent/browser.js';
import { initDB, upsertJobs, setStatus, setFields, bumpAttempt, logEmail, log, getJob,
  alreadyEmailed, alreadyApplied, alreadyConnected, logConnect, rows, doneToday } from './tracker.js';
import { liPosts, liJobs, hnHiring, redditHiring, publicBoards, relToIso } from './mcp/sources.js';
import { easyApply } from './mcp/easyapply.js';
import { applyForm } from './mcp/forms.js';
import { connect } from './mcp/connect.js';
import { sendViaGmail } from './mcp/gmail.js';
import { subject as mkSubject, body as mkBody } from './scraper/email_content.js';
import { writeDash } from './dashboard.js';
import { startServer } from './server.js';
import { getProfile } from './profile.js';
import { outcome, rankByUCB, learnedSkip, writePlaybook, domainOf } from './evolve.js';
import { buildQueries, buildListingQueries } from './mcp/queries.js';
import { DATA } from './config.js';

const DRY = process.env.DRY === '1';
const DAILY = { email: 50, easy: 80, form: 30, connect: 18 };
const MIN_REL = { email: 0.3, easy_apply: 0.4, form: 0.45, connect: 0.5 };
const MAX_AGE_DAYS = { email: 12, easy_apply: 4, form: 7, connect: 3 };
const PACE = { mailer: [12000, 22000], applier: [4000, 9000], connector: [35000, 70000], scout: [15000, 30000] };
const RUN_MS = +(process.env.RUN_MS || 0) || Infinity; // 0/absent = run forever

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const jitter = ([a, b]) => SLEEP(a + Math.random() * (b - a));
const STATE = path.join(DATA, 'worker-state.json');
const STOPFILE = path.join(DATA, '.stop');          // UI/CLI writes this to halt all lanes
const stopped = () => fs.existsSync(STOPFILE);
const running = () => !stopped() && Date.now() - started < RUN_MS;
const started = Date.now();
let state = { startedAt: new Date().toISOString(), lanes: {}, cycle: 0 };
function beat(lane, phase, extra = {}) {
  state.lanes[lane] = { phase, ts: new Date().toISOString() };
  state.ts = new Date().toISOString();
  Object.assign(state, extra);
  try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch {}
}
const say = (lane, m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${lane}: ${m}`);

// When a site needs the user to (re)log in, surface a ONE-CLICK link on the dashboard.
const LOGIN_URL = { LinkedIn: 'https://www.linkedin.com/login', Gmail: 'https://mail.google.com/' };
function flagLogin(site, reason, url) {
  state.loginNeeded = state.loginNeeded || {};
  state.loginNeeded[site] = { url: url || LOGIN_URL[site] || '', reason: reason || '', ts: new Date().toISOString() };
  say('main', `⚠ ${site} needs login — surfaced one-click link on dashboard (${state.loginNeeded[site].url})`);
  beat('main', 'login-needed');
}
function clearLogin(site) { if (state.loginNeeded && state.loginNeeded[site]) { delete state.loginNeeded[site]; delete loginProbeAt[site]; try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch {} } }
const notLoggedIn = d => /not logged in|log into|authwall|sign in|please log in/i.test(d || '');
// Login backoff: once a site needs login, stop hammering it — surface the banner and only
// re-probe every few minutes. Returns true if we should SKIP acting on this site right now.
const loginProbeAt = {};
function loginBackoff(site) {
  if (!state.loginNeeded || !state.loginNeeded[site]) return false;
  const now = Date.now();
  if (now >= (loginProbeAt[site] || 0)) { loginProbeAt[site] = now + 3 * 60000; return false; } // allow one probe / 3 min
  return true;
}
const needsLogin = site => !!(state.loginNeeded && state.loginNeeded[site]); // read-only check

// ── queue selector (shared) ──────────────────────────────────────────────────
function queue(channel, limit = 25) {
  const minPosted = new Date(Date.now() - MAX_AGE_DAYS[channel] * 86400e3).toISOString();
  return rows(`SELECT * FROM jobs WHERE status='new' AND channel=? AND relevance>=? AND COALESCE(attempts,0)<3
     AND (posted_at='' OR posted_at IS NULL OR posted_at>=?)
     ORDER BY ${channel === 'email' ? "CASE WHEN source='linkedin_post' THEN 0 ELSE 1 END," : ''}
       CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, relevance DESC LIMIT ?`,
    [channel, MIN_REL[channel], minPosted, limit]);
}
const capLeft = (k, type) => Math.max(0, DAILY[k] - doneToday(type));

// ── ingest helper ────────────────────────────────────────────────────────────
function ingest(leads) {
  const good = leads.filter(l => !l.skip && !l.alreadyApplied);
  const skip = leads.filter(l => l.skip && !l.alreadyApplied).map(l => ({ ...l, status: 'skipped' }));
  const applied = leads.filter(l => l.alreadyApplied).map(l => ({ ...l, status: 'applied' }));
  const n = upsertJobs([...good, ...skip, ...applied]);
  for (const l of skip) { const j = getJob(l.url); if (j && j.status === 'skipped' && !j.notes) setFields(l.url, { notes: l.skipWhy }); }
  return { n, email: good.filter(l => l.email).length };
}

// ── SCOUT lane ────────────────────────────────────────────────────────────────
async function scout() {
  let i = 0;
  while (running()) {
    try {
      const postQ = rankByUCB('post_query', buildQueries({ limit: 30 }));
      const jobQ = rankByUCB('job_query', buildListingQueries({ limit: 18 }));

      // 1) LinkedIn hiring POSTS — primary source (highest email yield), every loop.
      //    Skipped while LinkedIn needs a login (banner shown); re-probed every ~3 min.
      if (!loginBackoff('LinkedIn')) {
        const q = postQ[0];
        beat('scout', `LI posts: ${q}`);
        const r = await liPosts(q, { datePosted: 'past-24h' });
        if (r.ok) { const { n, email } = ingest(r.leads); outcome('post_query', q, { yieldN: email * 2 + n }); say('scout', `posts "${q}" +${n} (${email} email)`); clearLogin('LinkedIn'); }
        else if (notLoggedIn(r.detail)) flagLogin('LinkedIn', 'Please log into LinkedIn in the JobPilot Chrome window — scraping is paused until you do');
        await jitter(PACE.scout);
        if (!running()) break;
      } else { beat('scout', 'LinkedIn paused — waiting for you to log in'); }

      // 2) The wider internet — HN, Reddit, public boards — EVERY loop (unbiased variety,
      //    no LinkedIn dependence, mostly email/form leads). Rotate one web source per loop
      //    so we cover all of them quickly without hammering any single site.
      const web = [
        ['HN', () => hnHiring({ maxAgeHours: 240 })],
        ['Reddit', () => redditHiring()],
        ['Boards', () => publicBoards({ maxAgeHours: 72 })],
      ];
      const [wname, wfn] = web[i % web.length];
      beat('scout', 'web: ' + wname);
      try { const rr = await wfn(); const { n, email } = ingest(rr.leads); say('scout', `${wname} +${n} (${email} email)`); } catch (e) { say('scout', `${wname} err ${e.message.slice(0, 60)}`); }
      await jitter(PACE.scout);
      if (!running()) break;

      // 3) LinkedIn job LISTINGS — secondary, only every OTHER loop (reduces LinkedIn load +
      //    throttle risk; posts and the web carry the pipeline). Also gated on login.
      if (i % 2 === 0 && !loginBackoff('LinkedIn')) {
        const jq = jobQ[0];
        beat('scout', `LI jobs: ${jq}`);
        for (const geoId of ['92000000', '101022442']) { // Worldwide, Pakistan
          const rj = await liJobs(jq, { easyOnly: true, tpr: 86400, geoId, pages: 1 });
          if (rj.ok) { const { n } = ingest(rj.leads); outcome('job_query', jq, { yieldN: n }); clearLogin('LinkedIn'); }
          else if (notLoggedIn(rj.detail)) flagLogin('LinkedIn', 'Please log into LinkedIn in the JobPilot Chrome window — scraping is paused until you do');
          await SLEEP(2500);
          if (!running()) break;
        }
        say('scout', `jobs "${jq}" done`);
      }
      i++;
      await jitter(PACE.scout);
    } catch (e) { say('scout', 'error ' + e.message.slice(0, 80)); await SLEEP(15000); }
  }
}

// ── MAILER lane ────────────────────────────────────────────────────────────────
async function mailer() {
  while (running()) {
    if (capLeft('email', 'email') <= 0) { beat('mailer', 'daily cap reached'); await SLEEP(10 * 60000); continue; }
    // If Gmail needs a login, don't hammer it — show the banner and wait, re-probing every ~3 min.
    if (loginBackoff('Gmail')) { beat('mailer', 'paused — waiting for you to log into Gmail'); await SLEEP(30000); continue; }
    const j = queue('email', 12).find(j => !alreadyEmailed(j.email) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('mailer', 'idle (queue empty)'); await SLEEP(30000); continue; }
    const p = getProfile();
    const job = { ...j, posterName: j.poster_name, description: j.description };
    const subj = mkSubject(job, p), body = mkBody(job, p);
    beat('mailer', `emailing ${j.email}`);
    bumpAttempt(j.url);
    if (DRY) { say('mailer', `DRY → ${j.email}`); setStatus(j.url, 'emailed', 'DRY'); await jitter(PACE.mailer); continue; }
    const r = await sendViaGmail({ to: j.email, subject: subj, body, attachmentPath: p.cvPath });
    if (r.ok) { logEmail(j.email, j.company, j.role, subj, 'sent', j.url); setStatus(j.url, 'emailed', `sent: ${subj}`); clearLogin('Gmail'); }
    else if (notLoggedIn(r.detail)) { flagLogin('Gmail', 'Please log into Gmail in the JobPilot Chrome window — emailing is paused until you do'); continue; }
    else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
    log('email_send', j.company, j.role, j.email, r.ok ? 'ok' : 'fail', r.detail);
    outcome('email_domain', (j.email.split('@')[1] || ''), { win: r.ok });
    say('mailer', `${r.ok ? '✉ SENT' : '✗'} ${j.email} (${j.role} @ ${j.company})`);
    writeDash();
    await jitter(PACE.mailer);
  }
}

// ── APPLIER lane (Easy Apply + forms interleaved) ───────────────────────────────
let liCooldownUntil = 0;         // backoff when LinkedIn throttles
let easyFailStreak = 0;          // consecutive non-apply Easy Apply outcomes
async function applier() {
  let turn = 0;
  while (running()) {
    const liCooling = Date.now() < liCooldownUntil || needsLogin('LinkedIn');
    // While LinkedIn is cooling down OR needs a login, only run the forms side (non-LinkedIn traffic).
    const doEasy = liCooling ? false : turn++ % 2 === 0;
    const chan = doEasy ? 'easy_apply' : 'form';
    const capK = doEasy ? 'easy' : 'form', capType = doEasy ? 'li_easy_apply' : 'portal_apply';
    if (capLeft(capK, capType) <= 0) { await SLEEP(60000); continue; }
    const list = queue(chan, 15).filter(j => !alreadyApplied(j.company, j.role));
    const j = list.find(j => !learnedSkip('form_domain', domainOf(j.apply_url || j.url)));
    if (!j) { beat('applier', `idle (${chan} queue empty)${liCooling ? ' · LinkedIn cooling down' : ''}`); await SLEEP(12000); continue; }
    bumpAttempt(j.url);
    if (DRY) { say('applier', `DRY ${chan} → ${j.role}`); setStatus(j.url, 'applied', 'DRY'); await jitter(PACE.applier); continue; }
    try {
      if (doEasy) {
        beat('applier', `⚡ ${j.role} @ ${j.company}`);
        const r = await easyApply({ url: j.apply_url || j.url });
        if (r.result === 'daily_limit') {
          // LinkedIn says "apply tomorrow" — stop Easy Apply for the rest of the day; forms keep going.
          liCooldownUntil = Date.now() + 14 * 3600000;
          say('applier', '🛑 LinkedIn DAILY submission limit — pausing Easy Apply ~14h (until tomorrow). Email/forms/connect continue.');
          beat('applier', 'LinkedIn daily limit — Easy Apply paused until tomorrow');
          continue;
        }
        if (r.result === 'throttled') {
          // LinkedIn is actively blocking — cool down 30 min (grows if it keeps happening); forms keep working.
          easyFailStreak++;
          const mins = Math.min(90, 30 * easyFailStreak);
          liCooldownUntil = Date.now() + mins * 60000;
          say('applier', `🛑 LinkedIn throttle — cooling down ${mins} min`);
          beat('applier', `LinkedIn cooldown ${mins}m`);
          flagLogin('LinkedIn', 'LinkedIn security check — open LinkedIn and complete the check / re-login');
          continue; // don't burn this lead's attempt on a throttle
        }
        if (r.result === 'applied' || r.result === 'already_applied') { setStatus(j.url, 'applied', r.detail); easyFailStreak = 0; clearLogin('LinkedIn'); }
        else if (r.result === 'no_easy_apply') { if (r.externalUrl) setFields(j.url, { channel: 'form', apply_url: r.externalUrl }); else setStatus(j.url, 'skipped', 'no Easy Apply / external'); }
        else if (r.result === 'needs_answers') setStatus(j.url, 'needs_manual', r.detail);
        else if (r.result === 'closed') setStatus(j.url, 'skipped', 'closed');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        // repeated misses in a row usually mean soft-throttling → 30-min cooldown (per your guidance)
        if (!['applied', 'already_applied'].includes(r.result)) { easyFailStreak++; if (easyFailStreak >= 4) { liCooldownUntil = Date.now() + 30 * 60000; say('applier', '🛑 4 Easy Apply misses in a row — 30 min cooldown'); easyFailStreak = 0; } }
        log('li_easy_apply', j.company, j.role, j.url, r.result === 'applied' ? 'ok' : /needs_answers/.test(r.result) ? 'manual' : /already|no_easy|closed/.test(r.result) ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `⚡ ${r.result} → ${j.role} @ ${j.company}`);
      } else {
        const target = j.apply_url || j.url;
        beat('applier', `📋 ${j.role} @ ${j.company}`);
        const r = await applyForm({ url: target, submit: true });
        if (r.result === 'submitted') setStatus(j.url, 'applied', 'form submitted');
        else if (r.result === 'needs_manual') setStatus(j.url, 'needs_manual', r.detail);
        else if (r.result === 'no_form') setStatus(j.url, 'skipped', 'no form');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        if (r.finalUrl) setFields(j.url, { apply_url: r.finalUrl });
        outcome('form_domain', domainOf(r.finalUrl || target), { win: r.result === 'submitted' });
        log('portal_apply', j.company, j.role, r.finalUrl || target, r.result === 'submitted' ? 'ok' : r.result === 'needs_manual' ? 'manual' : r.result === 'no_form' ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `📋 ${r.result} → ${j.role} @ ${j.company}`);
      }
    } catch (e) { say('applier', 'error ' + e.message.slice(0, 80)); setStatus(j.url, 'needs_manual', e.message.slice(0, 120)); }
    writeDash();
    await jitter(PACE.applier);
  }
}

// ── CONNECTOR lane ──────────────────────────────────────────────────────────────
let connectPaused = false;
async function connector() {
  while (running()) {
    if (connectPaused || capLeft('connect', 'connect') <= 0) { beat('connector', connectPaused ? 'paused (weekly limit)' : 'daily cap'); await SLEEP(15 * 60000); continue; }
    if (needsLogin('LinkedIn')) { beat('connector', 'paused — waiting for you to log into LinkedIn'); await SLEEP(60000); continue; }
    const j = queue('connect', 15).find(j => j.poster_url && !alreadyConnected(j.poster_url) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('connector', 'idle (queue empty)'); await SLEEP(45000); continue; }
    bumpAttempt(j.url);
    if (DRY) { say('connector', `DRY → ${j.poster_name}`); setStatus(j.url, 'connected', 'DRY'); await jitter(PACE.connector); continue; }
    beat('connector', `🔗 ${j.poster_name}`);
    const r = await connect({ profileUrl: j.poster_url, posterName: j.poster_name, role: j.role, company: j.company });
    if (/^connected/.test(r.result)) { setStatus(j.url, 'connected', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, r.note || '', 'connected'); clearLogin('LinkedIn'); }
    else if (/already/.test(r.result)) { setStatus(j.url, 'skipped', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, '', 'pending'); }
    else if (r.result === 'limit') { connectPaused = true; say('connector', 'weekly invite limit — pausing'); }
    else if (r.result === 'no_connect') setStatus(j.url, 'skipped', r.detail);
    else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
    log('li_connect', j.company, j.role, j.poster_url, /^connected/.test(r.result) ? 'ok' : r.result === 'error' ? 'fail' : 'skip', `${r.result}: ${r.detail}`);
    say('connector', `🔗 ${r.result} → ${j.poster_name}`);
    writeDash();
    await jitter(PACE.connector);
  }
}

// ── dashboard + playbook + self-contribution refresher ──────────────────────────
async function refresher() {
  let lastContribute = 0, lastLoginCheck = 0, lastSync = 0;
  while (running()) {
    try { writeDash(); writePlaybook(); } catch {}
    // Reconcile stale login banners with reality: if a site is FLAGGED but actually logged in
    // (the flag came from a transient failure), re-verify the real session and clear it so the
    // dashboard never nags you after you're already in. Only runs while a banner is up.
    if (!DRY && state.loginNeeded && Object.keys(state.loginNeeded).length && Date.now() - lastLoginCheck > 60000) {
      lastLoginCheck = Date.now();
      try {
        const v = await verifyLogins();
        if (v.linkedin) clearLogin('LinkedIn');
        if (v.gmail) clearLogin('Gmail');
        if (v.linkedin || v.gmail) { writeDash(); say('main', `login reconciled → LinkedIn:${v.linkedin} Gmail:${v.gmail}`); }
      } catch {}
    }
    // Every ~10 min: KEEP SYNCING with the main repo (hard rule — see AGENTS.md).
    //   Fork → rebase on upstream/main and push the fork current (move to the newer version).
    //   Main → review + merge open self-evolve PRs that passed CI, then fast-forward main.
    // This runs independently of the full contribute round so the branch never drifts.
    if (!DRY && getProfile().consent?.autoContribute !== false && Date.now() - lastSync > 10 * 60000) {
      lastSync = Date.now();
      try {
        const { syncBranch, repoInfo, reviewAndMergePRs } = await import('./contribute.js');
        const info = await repoInfo();
        const s = await syncBranch();
        if (s.advanced) say('contribute', `pulled newer upstream version (now in sync with ${s.upstream || 'origin'})`);
        if (!info.isFork) {
          const rev = await reviewAndMergePRs();
          if (rev.merged?.length) say('contribute', `reviewed + merged self-evolve PRs: ${rev.merged.join(', ')}`);
        }
      } catch (e) { say('contribute', 'sync skip: ' + e.message.slice(0, 80)); }
    }
    // Every ~20 min: full contribute round — sync first, file blocker issues, then open a PR
    // (fork) or review+merge PRs (main). ON by default; hard-guarded against committing data/creds.
    if (!DRY && getProfile().consent?.autoContribute !== false && Date.now() - lastContribute > 20 * 60000) {
      lastContribute = Date.now();
      try {
        const { contributeRound } = await import('./contribute.js');
        const r = await contributeRound();
        if (r.issues?.filed?.length) say('contribute', `filed issues: ${r.issues.filed.join(', ')}`);
        // PR opened for local changes (fork → upstream, main → its own main)
        if (r.pr?.pr) say('contribute', `opened self-evolve PR: ${r.pr.pr}`);
        else if (r.pr?.reason && r.pr.reason !== 'nothing to contribute') say('contribute', r.pr.reason);
        // Main-repo reviewer: merged open self-evolve PRs that passed CI
        if (r.review?.merged?.length) say('contribute', `reviewed + merged self-evolve PRs: ${r.review.merged.join(', ')}`);
        if (r.sync?.advanced) say('contribute', `synced to newer upstream version`);
      } catch (e) { say('contribute', 'skip: ' + e.message.slice(0, 80)); }
    }
    await SLEEP(20000);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(STOPFILE, { force: true }); } catch {}   // clear any stale stop flag
await launchChrome();
await initDB();
// Keep the repo branch in sync with the main repo on startup (fork → rebase on upstream).
if (!DRY && getProfile().consent?.autoContribute !== false) {
  try { const { syncBranch } = await import('./contribute.js'); const s = await syncBranch(); say('main', `branch sync: ${s.synced ? 'in sync with ' + (s.upstream || 'origin') : 'skipped (' + (s.reason || '') + ')'}`); } catch {}
}
const uiPort = await startServer();           // dashboard + Questions + /api/answers + /evidence + /api/stop
process.env.JOB_AGENT_PORT = String(uiPort || 7788);
say('main', `worker start${DRY ? ' (DRY)' : ''} — concurrent lanes: scout · mailer · applier · connector`);
say('main', `dashboard + Stop button live at http://127.0.0.1:${uiPort || 7788}`);
beat('main', 'running', { uiPort: uiPort || 7788 });
// Watchdog: when the Stop flag appears (UI/CLI), exit the whole process promptly.
(async () => { while (!stopped()) await SLEEP(1500); say('main', '⏹ Stop requested — shutting down all lanes'); beat('main', 'stopped'); await SLEEP(500); process.exit(0); })();
await Promise.all([scout(), mailer(), applier(), connector(), refresher()]);
beat('main', 'stopped');
process.exit(0);
