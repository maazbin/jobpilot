// src/worker.js — the always-on engine. Four lanes run CONCURRENTLY (own tab each),
// so scraping never blocks applying and email never blocks Easy Apply:
//   scout     — scrape LinkedIn posts/jobs (freshest first) + web (HN/boards); UCB-ranked queries
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
  alreadyEmailed, alreadyApplied, alreadyConnected, logConnect, rows, doneToday, isFakeEmail } from './tracker.js';
import { liPosts, liJobs, hnHiring, publicBoards, relToIso } from './mcp/sources.js';
import { easyApply } from './mcp/easyapply.js';
import { applyForm } from './mcp/forms.js';
import { connect } from './mcp/connect.js';
import { commentInterested } from './mcp/comment.js';
import { sendViaGmail } from './mcp/gmail.js';
import { subject as mkSubject, body as mkBody } from './scraper/email_content.js';
import { writeDash } from './dashboard.js';
import { startServer } from './server.js';
import { getProfile, isExcludedCompany, isOnboarded } from './profile.js';
import { outcome, rankByUCB, learnedSkip, writePlaybook, domainOf, encounter } from './evolve.js';
import { buildQueries, buildListingQueries } from './mcp/queries.js';
import { DATA } from './config.js';
import { assessJob, cvAttachmentForJob, selectCvVariant } from './cv.js';
import { getEasyApplyLimit, maybeRefreshEasyApplyLimit } from './limits.js';

const DRY = process.env.DRY === '1';
// DATA-ONLY mode: when WORKER_DATA_ONLY=1 the worker runs ONLY the data lanes (scout + refresher)
// — it scrapes leads into the DB and keeps the dashboard/playbook fresh, but NEVER emails,
// applies, or connects on its own. All of that reasoning + outreach is left to the agent (Kiro),
// which decides relevance, writes emails, and drives apply/connect through the MCP tools.
// The evolver (self-evolution/PR) lane is independent: it stays on unless WORKER_NO_EVOLVE=1.
const DATA_ONLY = process.env.WORKER_DATA_ONLY === '1';
const NO_EVOLVE = process.env.WORKER_NO_EVOLVE === '1';
// Daily caps. Email is DELIBERATELY uncapped by default (0 = unlimited): emailing through the
// user's Gmail carries no LinkedIn-restriction risk (only Gmail's own generous throttling), and
// the user asked for the brain to decide pace, not a hardcoded number. The user can still set a
// ceiling from the profile (limits.maxEmailsPerDay). Easy/form/connect keep account-safety caps.
const DAILY = { email: 0, easy: 80, form: 30, connect: 18 };
// Resolve the email daily cap from the profile at call time: 0, null, or absent → UNLIMITED.
// A positive number is honored as a user-chosen ceiling. Non-numeric/garbage → unlimited.
function emailDailyCap() {
  const v = getProfile().limits?.maxEmailsPerDay;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;   // 0 = unlimited
}
// Relevance floors per channel. Lowered (per user request: "don't skip stuff") so fewer
// borderline-but-real leads get dropped before we ever look at them — we'd rather see a
// lead and let the CV/role guards decide than silently filter it out on a fuzzy score.
const MIN_REL = { email: 0.15, easy_apply: 0.2, form: 0.25, connect: 0.3 };
const MAX_AGE_DAYS = { email: 12, easy_apply: 4, form: 7, connect: 3 };
// Per-lane pacing (ms, jittered). Heavy anti-restriction pacing is reserved for the Easy-Apply
// path only (see easyApplyCooldownRange). The mailer has its OWN brisk pace (emailPaceRange,
// profile knob limits.emailPaceMs) because email carries no LinkedIn-restriction risk — only
// Gmail throttling, which is generous. Scout only loads public pages, so it is polite-but-brisk
// rather than anti-restriction paced. The applier/connector stay widened (account-write lanes).
const PACE = { applier: [10000, 20000], connector: [45000, 90000], scout: [8000, 15000] };
// Extra fixed cooldown applied after EVERY action in the account-write lanes (applier/connector),
// on top of the jittered PACE above. Reads the user's profile knob (cooldownBetweenActionsMs) so
// it stays tunable. The mailer does NOT use this — email is paced only by emailPaceRange().
const extraCooldown = () => SLEEP(Math.max(0, +(getProfile().limits?.cooldownBetweenActionsMs) || 4000));
// Email (mailer) pace [min,max] ms, profile-configurable (limits.emailPaceMs). Falls back to a
// brisk default. This is intentionally NOT the Easy-Apply anti-restriction cooldown.
function emailPaceRange() {
  const v = getProfile().limits?.emailPaceMs;
  if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0) && v[1] >= v[0]) return v;
  return [4000, 9000];
}

// When the user prefers cold outreach, Easy Apply yields while eligible email leads
// remain. Scouting and the mailer stay concurrent, so this drains without starving
// discovery or requiring a second worker.
function pendingEmailLeads() {
  if (getProfile().preferences?.outreachPriority !== 'email_first') return 0;
  return queue('email', 50).filter(j => !alreadyEmailed(j.email) && !alreadyApplied(j.company, j.role)).length;
}
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

// ── NEVER STOP: global safety net ───────────────────────────────────────────────
// A stray exception or rejected promise anywhere must NOT kill the worker. Log and keep going.
process.on('uncaughtException',  e => { try { say('main', '⚠ uncaughtException (continuing): ' + ((e && e.stack) || e || '').toString().slice(0, 200)); } catch {} });
process.on('unhandledRejection', e => { try { say('main', '⚠ unhandledRejection (continuing): ' + ((e && e.stack) || e || '').toString().slice(0, 200)); } catch {} });

/**
 * Run a lane under supervision: if the lane's loop ever throws, log it, pause briefly, and
 * RESTART it — so a single lane crash can never bring down the worker or stop the pipeline.
 * Returns only when the worker is intentionally stopping (running() === false).
 * @param {string} name - lane name for logging
 * @param {() => Promise<void>} fn - the lane function (an internal `while(running())` loop)
 */
async function supervise(name, fn) {
  let restarts = 0;
  while (running()) {
    try {
      await fn();
      return;                       // lane returned because running() went false → clean stop
    } catch (e) {
      restarts++;
      const wait = Math.min(60000, 5000 * restarts);   // backoff, capped at 60s
      say(name, `💥 lane crashed (#${restarts}) — restarting in ${Math.round(wait / 1000)}s: ${((e && e.message) || e || '').toString().slice(0, 120)}`);
      beat(name, `crashed — auto-restarting (#${restarts})`);
      await SLEEP(wait);
    }
  }
}


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
// The user's action policy is to leave roles that require citizenship, a visa,
// a work permit, or other location-specific work authorization. These were treated as
// hard skips. Per user request ("don't skip stuff"), we now only hard-skip when the
// requirement is for a DIFFERENT country than where the user is authorized — i.e. a
// genuine foreign work-authorization wall (US citizens only, EU right-to-work, etc.).
// A Pakistan-based lead that asks "are you authorized to work here?" is answerable
// ("Yes"), so it's routed to manual/answer handling instead of being dropped.
const WORK_AUTH_REQUIRED = /citizenship|work authorization|authorized to work|right to work|work permit|visa sponsorship|sponsorship required|employment visa|security clearance|(?:us|u\.s\.|united states)\s+(?:citizens?|nationals?|permanent residents?|green card holders?|ead holders?)|green card holders?|ead holders?|unable to sponsor|cannot sponsor|can't sponsor|no sponsorship|sponsorship (?:is )?(?:not|isn't) (?:available|provided|offered)|\bw-?2\b/i;
// Where the user can legally work (from profile), lowercased for matching.
const authorizedCountries = () => {
  const p = getProfile();
  const list = [p.country, ...(p.workAuth?.authorizedIn || []), ...(p.preferences?.locations || [])]
    .filter(Boolean).map(s => String(s).toLowerCase());
  return list;
};
// True only when the role's text names a work-auth requirement for a country the user is
// NOT authorized in. A requirement that matches the user's own country is answerable, not a wall.
const requiresWorkAuthorization = r => {
  const text = [r?.detail || '', ...(r?.questions || []), r?.meta?.head || '', r?.company || '', r?.role || '', r?.location || '']
    .join(' ');
  if (!WORK_AUTH_REQUIRED.test(text)) return false;
  const lc = text.toLowerCase();
  const auth = authorizedCountries();
  // No country on the profile means we do not invent one. A named authorization wall
  // is skipped only when the profile lists countries and none of them appear here.
  if (!auth.length) return false;
  if (auth.some(c => lc.includes(c))) return false;
  // Relocation/visa-sponsorship preference: if the user is open to relocating AND the role offers
  // sponsorship/relocation OR sits in a preferred region (Middle East / EU / …), it is DESIRABLE,
  // not a wall — do not skip. The user explicitly wants these.
  const prof = getProfile();
  const prefLocs = (prof.preferences?.locations || []).map(s => String(s).toLowerCase());
  const wantsRelo = prof.workAuth?.willingToRelocate === true || prefLocs.length > 0;
  if (wantsRelo) {
    const offersSponsor = /\b(visa sponsorship|sponsorship (available|provided|offered)|relocation (assistance|package|support|provided|offered)|will sponsor|we sponsor|work permit (provided|sponsored))\b/.test(lc);
    const inPref = prefLocs.some(loc => loc && lc.includes(loc));
    if (offersSponsor || inPref) return false;
  }
  return true;
};
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
  const candidates = rows(`SELECT * FROM jobs WHERE status='new' AND channel=? AND relevance>=? AND COALESCE(attempts,0)<3
     AND (posted_at='' OR posted_at IS NULL OR posted_at>=?)
     ORDER BY ${channel === 'email' ? "CASE WHEN source='linkedin_post' THEN 0 ELSE 1 END," : ''}
       CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, relevance DESC LIMIT ?`,
    [channel, MIN_REL[channel], minPosted, limit * 3]).filter(locationAllowed);
  const p = getProfile();
  return candidates.filter(j => {
    if (isExcludedCompany(`${j.company || ''} ${j.role || ''} ${j.description || ''}`)) return false;
    const cv = assessJob(j, p);
    if (!cv.roleAligned) {
      setFields(j.url, {
        status: 'skipped',
        notes: `CV relevance guard: ${cv.basis}`,
        cv_match_percent: cv.matchPercent,
        cv_drift_percent: cv.driftPercent,
        cv_missing_terms: cv.missingTerms.join(', '),
        tailor_status: 'not_requested',
      });
      return false;
    }
    return true;
  }).slice(0, limit);
}
const capLeft = (k, type) => Math.max(0, DAILY[k] - doneToday(type));
function jobCvAttachment(j, p) {
  const selection = selectCvVariant(j, p);
  if (j.url) setFields(j.url, { selected_cv_id: selection.id, selected_cv_path: selection.path, selected_cv_reason: selection.reason });
  const attachment = cvAttachmentForJob(j, p);
  if (attachment && attachment.includes(`${path.sep}tailored-cv${path.sep}`) && j.url) {
    setFields(j.url, { tailor_status: 'generated', tailored_cv_path: attachment });
  }
  return attachment;
}

// Country scope keeps outreach inside the profile country. It never assumes a country.
const PK_CITIES = /\b(karachi|lahore|islamabad|rawalpindi|faisalabad|multan|peshawar|quetta|sialkot|hyderabad)\b/i;
const GEO_LOCK_ACTION = /\b(us|u\.s\.|usa|united states|uk|u\.k\.|united kingdom|eu|europe|european union|canada|india|brazil|latam|germany|australia|singapore|hong kong)[- ]?(only|based only|residents? only|citizens? only|timezone|tz)\b|\bmust (be|reside|live|work) (located |based )?in (the )?(us|usa|uk|eu|canada|india|europe)\b|\bus citizen|security clearance|\bh1b\b|\bno[- ]?sponsorship\b/i;

function locationAllowed(job) {
  if (!isOnboarded()) return false;
  const profile = getProfile();
  if (profile.preferences?.locationScope !== 'country') return true;
  const country = String(profile.country || '').trim().toLowerCase();
  if (!country) return false;

  const location = String(job.location || '').toLowerCase();
  const source   = String(job.source   || '').toLowerCase();
  const desc     = String(job.description || '').slice(0, 600).toLowerCase();
  const inCountry = text => text.includes(country) || (country === 'pakistan' && PK_CITIES.test(text));

  if (/rozee|mustakbil/.test(source)) return country === 'pakistan';
  if (inCountry(location)) return true;
  if (/^linkedin/.test(source)) {
    if (location) return false;
    if (GEO_LOCK_ACTION.test(desc) && !desc.includes(country)) return false;
    return inCountry(desc);
  }
  return inCountry(desc);
}

// ── ingest helper ────────────────────────────────────────────────────────────
function ingest(leads) {
  const scoped = leads.filter(locationAllowed);
  const excluded = l => isExcludedCompany(`${l.company || ''} ${l.role || ''} ${l.description || ''}`);
  const good = scoped.filter(l => !l.skip && !l.alreadyApplied && !excluded(l));
  const skip = scoped.filter(l => (l.skip || excluded(l)) && !l.alreadyApplied).map(l => ({ ...l, status: 'skipped', skipWhy: l.skipWhy || 'company excluded by profile' }));
  const applied = scoped.filter(l => l.alreadyApplied).map(l => ({ ...l, status: 'applied' }));
  const n = upsertJobs([...good, ...skip, ...applied]);
  for (const l of skip) { const j = getJob(l.url); if (j && j.status === 'skipped' && !j.notes) setFields(l.url, { notes: l.skipWhy }); }
  return { n, email: good.filter(l => l.email).length };
}

// ── SCOUT lane ────────────────────────────────────────────────────────────────
async function scout() {
  let i = 0;
  while (running()) {
    if (!isOnboarded()) { beat('scout', 'waiting for onboarding'); await SLEEP(15000); continue; }
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

      // 2) The wider internet — HN, public boards — run ALL of them EVERY loop (unbiased variety,
      //    no LinkedIn dependence, mostly email/form leads). This keeps email/form leads flowing
      //    even while LinkedIn is cooling/paused, so the email channel never starves.
      //    Reddit is intentionally excluded by default (per user request): its bot-check/redirect
      //    flow is noisy and low-yield. Un-starvation comes from HN/Boards getting more turns,
      //    never from re-enabling Reddit.
      const web = [
        ['HN', () => hnHiring({ maxAgeHours: 240 })],
        ['Boards', () => publicBoards({ maxAgeHours: 72 })],
      ];
      for (const [wname, wfn] of web) {
        beat('scout', 'web: ' + wname);
        try { const rr = await wfn(); const { n, email } = ingest(rr.leads); say('scout', `${wname} +${n} (${email} email)`); } catch (e) { say('scout', `${wname} err ${e.message.slice(0, 60)}`); }
        await jitter(PACE.scout);
        if (!running()) break;
      }
      if (!running()) break;

      // 3) LinkedIn job LISTINGS — secondary, only every OTHER loop (reduces LinkedIn load +
      //    throttle risk; posts and the web carry the pipeline). Also gated on login.
      if (i % 2 === 0 && !loginBackoff('LinkedIn')) {
        const jq = jobQ[0];
        beat('scout', `LI jobs: ${jq}`);
        const profile = getProfile();
        const country = String(profile.country || '').toLowerCase();
        const geoIds = profile.preferences?.locationScope === 'country'
          ? (country === 'pakistan' ? ['101022442'] : [])
          : ['92000000'];
        for (const geoId of geoIds) {
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
   if (!isOnboarded()) { beat('mailer', 'waiting for onboarding'); await SLEEP(15000); continue; }
   try {
    // Email daily cap: 0/absent = UNLIMITED (default). Only enforce if the user set a positive ceiling.
    const emailCap = emailDailyCap();
    if (emailCap > 0 && doneToday('email') >= emailCap) { beat('mailer', `daily cap reached (${emailCap}, user-set)`); await SLEEP(10 * 60000); continue; }
    // If Gmail needs a login, don't hammer it — show the banner and wait, re-probing every ~3 min.
    if (loginBackoff('Gmail')) { beat('mailer', 'paused — waiting for you to log into Gmail'); await SLEEP(30000); continue; }
    const j = queue('email', 12).find(j => !alreadyEmailed(j.email) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('mailer', 'idle (queue empty)'); await SLEEP(30000); continue; }
    const p = getProfile();
    const job = { ...j, posterName: j.poster_name, description: j.description };
    const subj = mkSubject(job, p), body = mkBody(job, p);
    beat('mailer', `emailing ${j.email}`);
    // Dry runs must be observational: do not consume attempts or mark a lead as sent.
    if (DRY) { say('mailer', `DRY → ${j.email}`); await jitter(emailPaceRange()); continue; }
    // An attempt is consumed ONLY on a genuine send attempt (see below) — never on a thrown
    // CDP/connect error or a transient not-logged-in interstitial, which should just retry later.
    let r;
    try {
      r = await sendViaGmail({ to: j.email, subject: subj, body, attachmentPath: jobCvAttachment(j, p) });
    } catch (e) {
      // thrown connect/unexpected error → transient: retry later, do NOT burn an attempt, no banner
      say('mailer', `transient send error (will retry): ${((e && e.message) || e || '').toString().slice(0, 80)}`);
      await jitter(emailPaceRange());
      continue;
    }
    // transient classified failure (cdp_unavailable, or interstitial not-logged-in): retry, no attempt burn
    if (r && r.skipped) {
      setStatus(j.url, isFakeEmail(j.email) ? 'fake' : 'skipped', r.detail || 'not a hiring contact');
      say('mailer', `skip ${j.email} — ${r.detail}`);
      continue;
    }
    if (r && r.transient) {
      if (notLoggedIn(r.detail)) flagLogin('Gmail', 'Please log into Gmail in the JobPilot Chrome window — emailing is paused until you do');
      say('mailer', `transient (${r.detail}) — will retry, attempt not consumed`);
      await jitter(emailPaceRange());
      continue;
    }
    // genuine send outcome → NOW consume the attempt, and re-read it so the cap arithmetic is correct.
    bumpAttempt(j.url);
    const attempts = (getJob(j.url)?.attempts) || ((j.attempts || 0) + 1);
    if (r.ok) { logEmail(j.email, j.company, j.role, subj, 'sent', j.url); setStatus(j.url, 'emailed', `sent: ${subj}`); clearLogin('Gmail'); }
    else {
      // Record an email-area encounter on a REAL send failure (page-less — gmail.js owns its page),
      // mirroring how the applier/forms/connect lanes call the encounter recorder.
      await encounter('email', `send failed: ${r.detail || 'unknown'}`, { url: j.url });
      if (attempts >= (p.limits?.maxAttemptsPerJob || 3)) setStatus(j.url, 'failed', r.detail);
    }
    log('email_send', j.company, j.role, j.email, r.ok ? 'ok' : 'fail', r.detail);
    outcome('email_domain', (j.email.split('@')[1] || ''), { win: r.ok });
    say('mailer', `${r.ok ? '✉ SENT' : '✗'} ${j.email} (${j.role} @ ${j.company})`);
    writeDash();
    await jitter(emailPaceRange());
   } catch (e) { say('mailer', 'error (skipping lead): ' + ((e && e.message) || e || '').toString().slice(0, 80)); await SLEEP(5000); }
  }
}

// ── APPLIER lane (Easy Apply + forms interleaved) ───────────────────────────────
let liCooldownUntil = 0;         // backoff when LinkedIn throttles
let easyFailStreak = 0;          // consecutive non-apply Easy Apply outcomes
async function applier() {
  let turn = 0;
  // Refresh the researched Easy Apply daily limit on boot if it's stale (>24h). Fire-and-forget:
  // never blocks the pipeline, never raises the cap on a bad fetch.
  maybeRefreshEasyApplyLimit().catch(() => {});
  while (running()) {
    if (!isOnboarded()) { beat('applier', 'waiting for onboarding'); await SLEEP(15000); continue; }
    let appliedEasy = false;     // set when an Easy Apply submission succeeds → longer cooldown
    const liCooling = Date.now() < liCooldownUntil || needsLogin('LinkedIn');
    // While LinkedIn is cooling down OR needs a login, only run the forms side (non-LinkedIn traffic).
    const emailBacklog = pendingEmailLeads();
    const alternatingEasy = turn++ % 2 === 0;
    const emailFirst = getProfile().preferences?.outreachPriority === 'email_first';
    const doEasy = liCooling ? false : (!emailFirst || emailBacklog === 0) && alternatingEasy;
    if (emailFirst && emailBacklog > 0 && !doEasy) beat('applier', `email-first: ${emailBacklog} cold-email lead(s) pending`);
    const chan = doEasy ? 'easy_apply' : 'form';
    const capType = doEasy ? 'li_easy_apply' : 'portal_apply';
    if (doEasy) {
      // Account-safety: stop Easy Apply at the 80% safety buffer of the (daily-refreshed) real
      // LinkedIn limit — well before the actual cap — to avoid a restriction. Email/forms/connect
      // keep running. The limit resets as the rolling 24h window clears, so we re-check hourly.
      const { effectiveCap, dailyLimit, safetyBuffer } = getEasyApplyLimit();
      const usedEasy = doneToday('li_easy_apply');
      if (usedEasy >= effectiveCap) {
        liCooldownUntil = Math.max(liCooldownUntil, Date.now() + 60 * 60000);
        say('applier', `🛡️ Easy Apply safety cap: ${usedEasy}/${effectiveCap} (${Math.round(safetyBuffer * 100)}% of ~${dailyLimit}/day LinkedIn limit) — pausing Easy Apply ~1h to avoid a restriction. Email/forms/connect continue.`);
        beat('applier', `Easy Apply safety cap ${usedEasy}/${effectiveCap} — paused ~1h`);
        await SLEEP(5000);
        continue;
      }
    } else if (capLeft('form', capType) <= 0) { await SLEEP(60000); continue; }
    const list = queue(chan, 15).filter(j => !alreadyApplied(j.company, j.role));
    // A learned form-domain skip must not leave a relevant lead silently stuck
    // as `new`; surface it for manual review and only apply the learned skip to
    // the form lane (never to Easy Apply).
    if (chan === 'form') {
      for (const blocked of list.filter(j => learnedSkip('form_domain', domainOf(j.apply_url || j.url)))) {
        setStatus(blocked.url, 'needs_manual', `manual review: repeated form failures on ${domainOf(blocked.apply_url || blocked.url)}`);
      }
    }
    const j = list.find(j => chan !== 'form' || !learnedSkip('form_domain', domainOf(j.apply_url || j.url)));
    if (!j) { beat('applier', `idle (${chan} queue empty)${liCooling ? ' · LinkedIn cooling down' : ''}`); await SLEEP(12000); continue; }
    // Dry runs must be observational: do not consume attempts or mark a lead applied.
    if (DRY) { say('applier', `DRY ${chan} → ${j.role}`); await jitter(PACE.applier); continue; }
    bumpAttempt(j.url);
    try {
      if (doEasy) {
        beat('applier', `⚡ ${j.role} @ ${j.company}`);
        const r = await easyApply({ url: j.apply_url || j.url, job: { ...j, role: j.role, company: j.company, description: j.description } });
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
        if (r.result === 'applied' || r.result === 'already_applied') { setStatus(j.url, 'applied', r.detail); easyFailStreak = 0; clearLogin('LinkedIn'); if (r.result === 'applied') appliedEasy = true; }
        else if (r.result === 'no_easy_apply') { if (r.externalUrl) setFields(j.url, { channel: 'form', apply_url: r.externalUrl }); else setStatus(j.url, 'skipped', 'no Easy Apply / external'); }
        else if (r.result === 'needs_answers') {
          if (requiresWorkAuthorization(r)) setStatus(j.url, 'skipped', 'skipped: work authorization/citizenship requirement');
          else setStatus(j.url, 'needs_manual', r.detail);
        }
        else if (r.result === 'closed') setStatus(j.url, 'skipped', 'closed');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        // repeated misses in a row usually mean soft-throttling → 30-min cooldown (per your guidance)
        if (!['applied', 'already_applied'].includes(r.result)) { easyFailStreak++; if (easyFailStreak >= 4) { liCooldownUntil = Date.now() + 30 * 60000; say('applier', '🛑 4 Easy Apply misses in a row — 30 min cooldown'); easyFailStreak = 0; } }
        log('li_easy_apply', j.company, j.role, j.url, r.result === 'applied' ? 'ok' : /needs_answers/.test(r.result) ? 'manual' : /already|no_easy|closed/.test(r.result) ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `⚡ ${r.result} → ${j.role} @ ${j.company}`);
      } else {
        const target = j.apply_url || j.url;
        beat('applier', `📋 ${j.role} @ ${j.company}`);
        const r = await applyForm({ url: target, submit: true, job: { ...j, role: j.role, company: j.company, description: j.description } });
        if (r.result === 'submitted') setStatus(j.url, 'applied', 'form submitted');
        else if (r.result === 'needs_manual') {
          if (requiresWorkAuthorization(r)) setStatus(j.url, 'skipped', 'skipped: work authorization/citizenship requirement');
          else setStatus(j.url, 'needs_manual', r.detail);
        }
        else if (r.result === 'no_form') setStatus(j.url, 'skipped', 'no form');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        if (r.finalUrl) setFields(j.url, { apply_url: r.finalUrl });
        outcome('form_domain', domainOf(r.finalUrl || target), { win: r.result === 'submitted' });
        log('portal_apply', j.company, j.role, r.finalUrl || target, r.result === 'submitted' ? 'ok' : r.result === 'needs_manual' ? 'manual' : r.result === 'no_form' ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `📋 ${r.result} → ${j.role} @ ${j.company}`);
      }
      await extraCooldown();
    } catch (e) { say('applier', 'error ' + e.message.slice(0, 80)); setStatus(j.url, 'needs_manual', e.message.slice(0, 120)); }
    writeDash();
    if (appliedEasy) {
      // Longer, randomized cooldown AFTER a successful Easy Apply so submissions are spread out
      // and never look like a fast, bot-like burst (a key restriction trigger).
      const [a, b] = easyApplyCooldownRange();
      const ms = Math.round(a + Math.random() * (b - a));
      beat('applier', `cooldown ${Math.round(ms / 1000)}s after Easy Apply (anti-restriction pacing)`);
      await SLEEP(ms);
    } else {
      await jitter(PACE.applier);
    }
  }
}

/** Inter-submission Easy Apply cooldown [min,max] ms, profile-configurable. */
function easyApplyCooldownRange() {
  const v = getProfile().limits?.easyApplyCooldownMs;
  if (Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0) && v[1] >= v[0]) return v;
  return [90000, 240000];
}

// ── CONNECTOR lane ──────────────────────────────────────────────────────────────
let connectPaused = false;
async function connector() {
  while (running()) {
   if (!isOnboarded()) { beat('connector', 'waiting for onboarding'); await SLEEP(15000); continue; }
   try {
    if (connectPaused || capLeft('connect', 'connect') <= 0) { beat('connector', connectPaused ? 'paused (weekly limit)' : 'daily cap'); await SLEEP(15 * 60000); continue; }
    if (needsLogin('LinkedIn')) { beat('connector', 'paused — waiting for you to log into LinkedIn'); await SLEEP(60000); continue; }
    const j = queue('connect', 15).find(j => j.poster_url && !alreadyConnected(j.poster_url) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('connector', 'idle (queue empty)'); await SLEEP(45000); continue; }
    // Dry runs must be observational: do not consume attempts or mark a lead connected.
    if (DRY) { say('connector', `DRY → ${j.poster_name}`); await jitter(PACE.connector); continue; }
    bumpAttempt(j.url);
    beat('connector', `🔗 ${j.poster_name}`);
    if (j.poster_url) {
      const { linkedinDM } = await import('./mcp/apply.js');
      const dmResult = await linkedinDM({ profileUrl: j.poster_url, role: j.role, company: j.company }).catch(() => null);
      if (dmResult && dmResult.result === 'dm_sent') {
        setStatus(j.url, 'connected', 'DM sent'); logConnect(j.poster_url, j.poster_name, j.company, j.role, '', 'dm_sent'); clearLogin('LinkedIn');
        log('li_connect', j.company, j.role, j.poster_url, 'ok', 'dm_sent');
        say('connector', `💬 DM sent → ${j.poster_name}`);
        writeDash(); await jitter(PACE.connector); continue;
      }
    }

    const r = await connect({ profileUrl: j.poster_url, posterName: j.poster_name, role: j.role, company: j.company });
    if (/^connected/.test(r.result)) { setStatus(j.url, 'connected', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, r.note || '', 'connected'); clearLogin('LinkedIn'); }
    else if (/already/.test(r.result)) { setStatus(j.url, 'skipped', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, '', 'pending'); }
    else if (r.result === 'limit') { connectPaused = true; say('connector', 'weekly invite limit — pausing'); }
    else if (r.result === 'no_connect') setStatus(j.url, 'skipped', r.detail);
    else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
    log('li_connect', j.company, j.role, j.poster_url, /^connected/.test(r.result) ? 'ok' : r.result === 'error' ? 'fail' : 'skip', `${r.result}: ${r.detail}`);
    say('connector', `🔗 ${r.result} → ${j.poster_name}`);

    // Comment "Interested" on the hiring POST itself (extra touchpoint recruiters notice).
    // Only for real LinkedIn feed/post URLs, once per post, and never when LinkedIn is
    // throttling. Failure here never blocks the lead — it's a bonus engagement step.
    // Prefer the stored post permalink (post_url); fall back to j.url only when it is itself
    // a feed/post URL. Never use the poster PROFILE url — comment_interested needs the POST.
    const postUrl = (j.post_url && /linkedin\.com\/(feed\/update|posts\/)/i.test(j.post_url) ? j.post_url : '')
      || (j.url && /linkedin\.com\/(feed\/update|posts\/)/i.test(j.url) ? j.url : '');
    if (postUrl && !needsLogin('LinkedIn') && r.result !== 'limit') {
      try {
        beat('connector', `💬 commenting on post → ${j.company || j.poster_name}`);
        const c = await commentInterested({ postUrl, role: j.role, company: j.company });
        log('li_comment', j.company, j.role, postUrl, /^(commented|already_commented)/.test(c.result) ? 'ok' : 'skip', `${c.result}: ${c.detail}`);
        if (c.result === 'commented') { setFields(j.url, { notes: `${j.notes ? j.notes + ' · ' : ''}commented Interested on post` }); say('connector', `💬 commented Interested → ${j.company || j.poster_name}`); }
        await extraCooldown();
      } catch (ce) { say('connector', 'comment skipped: ' + ((ce && ce.message) || ce || '').toString().slice(0, 70)); }
    }

    writeDash();
    await jitter(PACE.connector); await extraCooldown();
   } catch (e) { say('connector', 'error (skipping lead): ' + ((e && e.message) || e || '').toString().slice(0, 80)); await SLEEP(5000); }
  }
}

// ── dashboard + playbook + login refresher ──────────────────────────────────────
async function refresher() {
  let lastLoginCheck = 0;
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
    await SLEEP(20000);
  }
}

// ── EVOLVER lane — self-evolution + recontribution, a FIRST-CLASS lane ───────────
// PR work is treated with the SAME priority as applying: it runs as its own concurrent lane
// and handles PRs PROMPTLY rather than as a slow background chore.
//   • every ~2 min: sync with main + (main repo) review & merge open PRs — so PRs never sit.
//   • every ~10 min: full contribute round — file blocker issues + open PRs for any changes.
// Hard-guarded against committing data/creds. Paced so gh/git calls stay polite.
async function evolver() {
  let lastSync = 0, lastContribute = 0;
  const EVOLVE_PR_MS = 2 * 60000;    // prompt PR review/merge + sync — co-equal with apply pacing
  const EVOLVE_FULL_MS = 10 * 60000; // full contribute round
  while (running()) {
   try {
    if (DRY || getProfile().consent?.autoContribute === false) { await SLEEP(30000); continue; }

    // Prompt PR handling (same priority as job apply): sync + review/merge open PRs.
    if (Date.now() - lastSync > EVOLVE_PR_MS) {
      lastSync = Date.now();
      beat('evolver', 'sync + review PRs');
      const { syncBranch, repoInfo, reviewAndMergePRs } = await import('./contribute.js');
      const info = await repoInfo();
      const s = await syncBranch();
      if (s.advanced) say('contribute', `pulled newer upstream version (in sync with ${s.upstream || 'origin'})`);
      if (!info.isFork) {
        const rev = await reviewAndMergePRs();
        if (rev.merged?.length) say('contribute', `reviewed + merged PRs: ${rev.merged.join(', ')}`);
        if (rev.closed?.length) say('contribute', `closed empty/redundant PRs: ${rev.closed.join(', ')}`);
      }
    }

    // Full contribute round: file blocker issues + open PRs for local code/doc changes.
    if (Date.now() - lastContribute > EVOLVE_FULL_MS) {
      lastContribute = Date.now();
      beat('evolver', 'contribute round');
      const { contributeRound } = await import('./contribute.js');
      const r = await contributeRound();
      if (r.issues?.filed?.length) say('contribute', `filed issues: ${r.issues.filed.join(', ')}`);
      if (r.pr?.pr) say('contribute', `opened self-evolve PR: ${r.pr.pr}`);
      else if (r.pr?.reason && r.pr.reason !== 'nothing to contribute') say('contribute', r.pr.reason);
      if (r.review?.merged?.length) say('contribute', `reviewed + merged PRs: ${r.review.merged.join(', ')}`);
      if (r.review?.closed?.length) say('contribute', `closed empty/redundant PRs: ${r.review.closed.join(', ')}`);
      if (r.sync?.advanced) say('contribute', `synced to newer upstream version`);
    }

    beat('evolver', 'idle (watching for PRs + changes)');
    await SLEEP(30000);
   } catch (e) { say('contribute', 'evolver error (continuing): ' + ((e && e.message) || e || '').toString().slice(0, 80)); await SLEEP(30000); }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
try { fs.rmSync(STOPFILE, { force: true }); } catch {}   // clear any stale stop flag
try { await launchChrome(); } catch (e) { say('main', 'chrome launch issue (continuing): ' + (e.message || '').slice(0, 80)); }
await initDB();
// Self-heal: revive email leads frozen at the attempt cap by the pre-fix transient-attempt bug
// (status still 'new' but attempts exhausted → never re-queued). Idempotent; code-only.
try {
  const { reviveStuckEmailLeads } = await import('./tracker.js');
  const n = reviveStuckEmailLeads(getProfile().limits?.maxAttemptsPerJob || 3);
  if (n) say('main', `revived ${n} email lead(s) stuck at the attempt cap (transient-fail self-heal)`);
} catch {}
// Keep the repo branch in sync with the main repo on startup (fork → rebase on upstream).
// SKIPPED when NO_EVOLVE is set (data-only mode): the startup rebase/reset would otherwise wipe
// local uncommitted/untracked changes — including the data-only + hook scripts — on every boot.
if (!DRY && !NO_EVOLVE && getProfile().consent?.autoContribute !== false) {
  try { const { syncBranch } = await import('./contribute.js'); const s = await syncBranch(); say('main', `branch sync: ${s.synced ? 'in sync with ' + (s.upstream || 'origin') : 'skipped (' + (s.reason || '') + ')'}`); } catch {}
} else if (NO_EVOLVE) {
  say('main', 'data-only mode — skipping startup branch sync (local changes preserved)');
}
let uiPort = 7788;
try { uiPort = await startServer() || 7788; } catch (e) { say('main', 'dashboard server issue (continuing): ' + (e.message || '').slice(0, 80)); }
process.env.JOB_AGENT_PORT = String(uiPort);
// Build the active lane set. The DATA lanes (scout + refresher) always run. The ACTING lanes
// (mailer · applier · connector) run only when NOT in data-only mode — in data-only mode the
// agent (Kiro) owns all reasoning + outreach via the MCP tools. The evolver lane is independent.
const lanes = [['scout', scout]];
if (!DATA_ONLY) {
  lanes.push(['mailer', mailer], ['applier', applier], ['connector', connector]);
}
if (!NO_EVOLVE) lanes.push(['evolver', evolver]);
lanes.push(['refresher', refresher]);
const laneNames = lanes.map(([n]) => n).join(' · ');
say('main', `worker start${DRY ? ' (DRY)' : ''}${DATA_ONLY ? ' (DATA-ONLY — agent handles outreach)' : ''} — concurrent lanes: ${laneNames}`);
say('main', `dashboard + Stop button live at http://127.0.0.1:${uiPort}`);
if (!isOnboarded()) say('main', `no profile yet — finish http://127.0.0.1:${uiPort}/onboard before any search or outreach`);
beat('main', 'running', { uiPort, dataOnly: DATA_ONLY });
// Watchdog: when the Stop flag appears (UI/CLI), exit the whole process promptly.
(async () => { while (!stopped()) await SLEEP(1500); say('main', '⏹ Stop requested — shutting down all lanes'); beat('main', 'stopped'); await SLEEP(500); process.exit(0); })();
// Each lane runs under supervise(): a crash auto-restarts the lane, never the whole worker.
// Promise.all resolves only when every lane returns (i.e. Stop was requested).
await Promise.all(lanes.map(([name, fn]) => supervise(name, fn)));
beat('main', 'stopped');
process.exit(0);
