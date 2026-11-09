// src/evolve.js — the self-evolution memory.
//
// Three loops, all persisted in the same SQLite DB (gitignored, per-user):
//   1. ENCOUNTERS  — every failure/oddity, keyed by (area, signature). Count, last seen,
//                    a DOM snapshot + screenshot, and status open|learned|fixed. Your coding
//                    agent reads data/evolution/PLAYBOOK.md, patches the code, marks fixed.
//   2. ANSWERS     — application questions → answers. Sources: user, agent, harvested
//                    (LinkedIn prefilled values = your own past answers), inferred, default.
//                    pending states:
//                      0 = answered (from user/agent/harvested)
//                      1 = unknown, parked for user to answer (shown in "Questions for you")
//                      2 = auto-answered by the agent from profile context (shown in "Agent answered")
//                    Unknown questions become "questions for you" and are asked ONCE.
//                    Similar questions are matched fuzzy (≥0.75 overlap) so a reworded version
//                    of an already-answered question is never re-parked.
//   3. STRATEGY    — outcomes per (lane, key) e.g. query / domain / ATS. Used to weight
//                    query rotation (UCB bandit) and to auto-skip domains that keep failing.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { rows, one, save, getDB } from './tracker.js';
import { DATA } from './config.js';

const EVO_DIR = path.join(DATA, 'evolution');
fs.mkdirSync(EVO_DIR, { recursive: true });
const h = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

export function initEvolve() {
  const db = getDB();
  db.run(`
    CREATE TABLE IF NOT EXISTS encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, signature TEXT, domain TEXT, detail TEXT,
      sample_url TEXT, snapshot TEXT, count INTEGER DEFAULT 1, status TEXT DEFAULT 'open',
      first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), resolution TEXT DEFAULT '',
      UNIQUE(area, signature));
    CREATE TABLE IF NOT EXISTS answers (
      qkey TEXT PRIMARY KEY, question TEXT, answer TEXT, source TEXT, uses INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0, pending INTEGER DEFAULT 0, seen INTEGER DEFAULT 1, options TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS strategy (
      lane TEXT, key TEXT, tries INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, yield INTEGER DEFAULT 0,
      last TEXT DEFAULT (datetime('now')), PRIMARY KEY (lane, key));
    CREATE TABLE IF NOT EXISTS evolution_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, fingerprint TEXT UNIQUE,
      status TEXT DEFAULT 'open', needs_code INTEGER DEFAULT 0, occurrences INTEGER DEFAULT 1,
      issue_number INTEGER DEFAULT NULL, issue_url TEXT DEFAULT '', pr_url TEXT DEFAULT '',
      first_seen TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
      resolution TEXT DEFAULT '');
  `);
  const answerCols = new Set(rows('PRAGMA table_info(answers)').map(c => c.name));
  const addAnswer = (name, type) => { if (!answerCols.has(name)) db.run(`ALTER TABLE answers ADD COLUMN ${name} ${type}`); };
  addAnswer('confidence', 'INTEGER DEFAULT NULL');
  addAnswer('match_percent', 'INTEGER DEFAULT NULL');
  addAnswer('confidence_basis', "TEXT DEFAULT ''");
  save();
}

// ── 1. Encounters ────────────────────────────────────────────────────────────

/** Normalize volatile bits (ids, numbers, urls) so the same problem groups together. */
export function signatureOf(detail = '') {
  return String(detail).toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function domainOf(url = '') {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Record something the agent couldn't handle. Optionally snapshots the page for later diagnosis. */
export async function encounter(area, detail, { url = '', page = null, scope = null } = {}) {
  const sig = signatureOf(detail);
  recordEvolutionAudit('encounter', `${area}|${sig}`, { needsCode: true });
  const domain = domainOf(url);
  let snapshot = '';
  if (page) {
    try {
      const base = path.join(EVO_DIR, `${area}-${h(area + sig)}`);
      // Re-capture when we don't yet have a USEFUL html snapshot (missing or near-empty).
      // The old guard keyed only on the .png existing, so a first-capture failure left a
      // 0-byte .html that was never retried — which is why stuck pages couldn't be diagnosed.
      let haveGood = false;
      try { haveGood = fs.existsSync(base + '.html') && fs.statSync(base + '.html').size > 200; } catch {}
      if (!haveGood) {
        await page.screenshot({ path: base + '.png', fullPage: false }).catch(() => {});
        // Prefer the dialog/scope DOM; fall back to any open dialog, then the body.
        let html = '';
        for (const getter of [
          () => scope ? scope.evaluate(el => el.outerHTML) : Promise.resolve(''),
          () => page.locator('dialog[open], div[role="dialog"]').first().evaluate(el => el.outerHTML),
          () => page.evaluate(() => (document.querySelector('dialog[open], div[role="dialog"]') || document.body).outerHTML),
          () => page.locator('body').evaluate(el => el.outerHTML),
        ]) {
          html = await getter().catch(() => '');
          if (html && html.length > 200) break;
        }
        fs.writeFileSync(base + '.html', String(html)
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '')
          .slice(0, 200000));
      }
      snapshot = path.relative(DATA, base);
    } catch {}
  }
  const db = getDB();
  db.run(
    `INSERT INTO encounters (area, signature, domain, detail, sample_url, snapshot) VALUES (?,?,?,?,?,?)
     ON CONFLICT(area, signature) DO UPDATE SET
       count=count+1, last_seen=datetime('now'), detail=excluded.detail,
       sample_url=excluded.sample_url,
       snapshot=CASE WHEN excluded.snapshot!='' THEN excluded.snapshot ELSE snapshot END,
       status=CASE WHEN status='fixed' THEN 'regressed' ELSE status END`,
    [area, sig, domain, String(detail).slice(0, 600), url, snapshot]);
  save();

  // Fire-and-forget: attempt lightweight self-healing without blocking the lane
  attemptSelfHeal(area, detail, { url, page, scope });
}

export function resolveEncounter(id, resolution, status = 'fixed') {
  const prior = one(`SELECT area, signature FROM encounters WHERE id=?`, [id]);
  getDB().run(`UPDATE encounters SET status=?, resolution=? WHERE id=?`, [status, resolution, id]);
  if (prior && status === 'fixed') resolveEvolutionAudit(auditFingerprint('encounter', `${prior.area}|${prior.signature}`), resolution);
  save();
}

export function openEncounters(limit = 50) {
  return rows(
    `SELECT * FROM encounters WHERE status IN ('open','regressed') ORDER BY count DESC, last_seen DESC LIMIT ?`,
    [limit]);
}

// ── 1b. GitHub self-evolution audit ledger ──────────────────────────────────
// Only a stable fingerprint and non-sensitive metadata leave the machine. The
// original question, answer, URL, screenshot, CV, and profile remain local.
export function auditFingerprint(kind, value = '') {
  return h(`${kind}:${value}`);
}

/** Record a deduplicated learning/improvement event for later GitHub auditing. */
export function recordEvolutionAudit(kind, value = '', { needsCode = false } = {}) {
  const fingerprint = auditFingerprint(kind, value);
  if (!fingerprint) return null;
  const db = getDB();
  db.run(
    `INSERT INTO evolution_audits (kind, fingerprint, needs_code)
     VALUES (?,?,?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       occurrences=occurrences+1, needs_code=MAX(needs_code, excluded.needs_code),
       status='open', updated_at=datetime('now')`,
    [String(kind).slice(0, 40), fingerprint, needsCode ? 1 : 0]);
  save();
  return fingerprint;
}

export function evolutionAudits(limit = 200) {
  return rows(`SELECT * FROM evolution_audits ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?`, [limit]);
}

export function markAuditIssue(fingerprint, issueNumber, issueUrl = '') {
  if (!fingerprint) return;
  getDB().run(`UPDATE evolution_audits SET issue_number=?, issue_url=?, updated_at=datetime('now') WHERE fingerprint=?`,
    [issueNumber || null, issueUrl || '', fingerprint]);
  save();
}

export function linkAuditPr(fingerprint, prUrl) {
  if (!fingerprint || !prUrl) return;
  getDB().run(`UPDATE evolution_audits SET pr_url=?, updated_at=datetime('now') WHERE fingerprint=?`, [prUrl, fingerprint]);
  save();
}

export function resolveEvolutionAudit(fingerprint, resolution = '') {
  if (!fingerprint) return;
  getDB().run(`UPDATE evolution_audits SET status='resolved', resolution=?, updated_at=datetime('now') WHERE fingerprint=?`,
    [String(resolution).slice(0, 240), fingerprint]);
  save();
}

// ── 2. Answers ───────────────────────────────────────────────────────────────

const STOP = new Set(
  'a an the of to for in on with do you your are is have has what how many which please our this that we be as at or and if any'
  .split(' '));

/**
 * Conservative stemmer: collapses common inflections so differently-worded forms of the
 * same concept match (arrangement/arrangements→arrang, residence/reside→resid,
 * preferred/prefer→prefer, working→work, currently/current→current).
 * Order is fixed so it is DETERMINISTIC and consistent across singular/plural forms.
 * @param {string} w
 * @returns {string}
 */
function stem(w) {
  if (w.length <= 3) return w;
  const s = w
    .replace(/(ing|ed|ly|es|s)$/, '')                               // tense / plural / adverb
    .replace(/(ment|ness|ance|ence|tion|sion|ity|ive|ful|able)$/, '') // nominalisations
    .replace(/e$/, '')                                              // trailing e
    .replace(/(.)\1$/, '$1');                                       // collapse doubled final consonant
  return s.length >= 2 ? s : w;
}

/**
 * Canonical key for a question — lowercases, strips punctuation + stop words, stems each word.
 * Deterministic: the same question text always yields the same key, so lookups are stable.
 * Stemming lets reworded phrasings of the same question collapse to the same key.
 * @param {string} q
 * @returns {string}
 */
export function qkey(q = '') {
  return String(q).toLowerCase()
    .replace(/[*?:()\[\].,!"'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(w => w && !STOP.has(w))
    .map(stem)
    .filter(Boolean)
    .slice(0, 18)
    .join(' ');
}

/**
 * Jaccard-style word-overlap similarity between two qkeys.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0–1
 */
function sim(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let i = 0;
  for (const w of A) if (B.has(w)) i++;
  return i / Math.max(1, Math.min(A.size, B.size) + Math.abs(A.size - B.size) * 0.5);
}

/**
 * Find the best existing answered row that fuzzy-matches this question.
 * Matches answered rows (pending=0) AND agent-answered rows (pending=2).
 * Threshold ≥0.6 — intentionally generous so the agent reuses an answer it already has
 * for a similar question instead of asking the user again.
 * @param {string} question
 * @returns {string|null}
 */
export function learnedAnswer(question) {
  const k = qkey(question);
  if (!k) return null;
  // Exact match first (pending=0 or pending=2, both have real answers)
  const exact = one(`SELECT answer FROM answers WHERE qkey=? AND answer!='' AND pending!=1`, [k]);
  if (exact) return exact.answer;
  // Fuzzy match across all answered rows
  let best = null, bs = 0;
  for (const r of rows(`SELECT qkey, answer FROM answers WHERE answer!='' AND pending!=1`)) {
    const s = sim(k, r.qkey);
    if (s > bs) { bs = s; best = r; }
  }
  return bs >= 0.6 ? best.answer : null;
}

/**
 * Teach an answer. source: user | agent | harvested | inferred | default.
 * User rank is highest — once a user answers something it is never overwritten.
 * Preserves the original full question text if a parked row already holds it.
 * @param {string} question - full question text (preferred) or a qkey
 * @param {string} answer
 * @param {string} [source]
 */
export function learn(question, answer, source = 'agent') {
  const k = qkey(question);
  if (!k || answer == null) return;
  recordEvolutionAudit('learning', k);
  resolveEvolutionAudit(auditFingerprint('learning', k), `learning recorded from ${source}`);
  const rank = { default: 0, inferred: 1, harvested: 2, agent: 3, user: 4 };
  const cur = one(`SELECT source, pending, question FROM answers WHERE qkey=?`, [k]);
  if (cur && !cur.pending && (rank[cur.source] ?? 0) > (rank[source] ?? 0)) return;
  // Keep the richest question text we have (parked row's original question beats a bare qkey)
  const qText = (cur?.question && cur.question.length > String(question).length) ? cur.question : String(question);
  getDB().run(
    `INSERT INTO answers (qkey, question, answer, source, pending) VALUES (?,?,?,?,0)
     ON CONFLICT(qkey) DO UPDATE SET answer=excluded.answer, source=excluded.source, pending=0, updated_at=datetime('now')`,
    [k, qText.slice(0, 300), String(answer).slice(0, 2000), source]);
  save();
}

/**
 * Save a user answer addressed by the EXACT stored key (from the dashboard).
 * This bypasses re-keying entirely so the parked pending row is updated in place —
 * fixing the "answer given once but question keeps reappearing" bug.
 * @param {string} key    - the exact qkey the dashboard holds for the parked question
 * @param {string} answer
 * @param {string} [source]
 */
export function answerByKey(key, answer, source = 'user') {
  if (!key || answer == null) return;
  const existing = one(`SELECT question FROM answers WHERE qkey=?`, [key]);
  const question = existing?.question || key;
  getDB().run(
    `INSERT INTO answers (qkey, question, answer, source, pending) VALUES (?,?,?,?,0)
     ON CONFLICT(qkey) DO UPDATE SET answer=excluded.answer, source=excluded.source, pending=0, updated_at=datetime('now')`,
    [key, String(question).slice(0, 300), String(answer).slice(0, 2000), source]);
  save();
}

/**
 * Park a question for the user to answer (pending=1) ONLY when there is no existing answer.
 * If the question (or a fuzzy match ≥0.6) is already answered (pending=0 or pending=2),
 * this is a no-op — the answer engine reuses the existing answer automatically.
 * This prevents the same question appearing repeatedly on the dashboard.
 * @param {string} question
 * @param {string[]} [options]
 */
export function askLater(question, options = []) {
  // Login fields and site chrome are not application questions.
  if (/pass(word|code)|otp|one[- ]?time (code|pass)|verification code|2fa|two[- ]factor/i.test(String(question || ''))) return;
  if (/^(i'?m a candidate|for job seekers|sign in|join now|0 notifications|home|my network|for business)\b/i.test(String(question || '').trim())) return;
  const k = qkey(question);
  if (!k) return;

  // If already answered (any source, any form), don't re-park as pending
  const existing = one(`SELECT pending, answer FROM answers WHERE qkey=?`, [k]);
  if (existing && existing.pending !== 1) return;    // already answered or agent-answered

  // Fuzzy check: if a similar question is already answered, skip parking
  for (const r of rows(`SELECT qkey FROM answers WHERE answer!='' AND pending!=1`)) {
    if (sim(k, r.qkey) >= 0.6) return;              // similar answered question exists
  }

  getDB().run(
    `INSERT INTO answers (qkey, question, answer, source, pending, options) VALUES (?,?,'','pending',1,?)
     ON CONFLICT(qkey) DO UPDATE SET
       seen=seen+1,
       options=CASE WHEN excluded.options!='' THEN excluded.options ELSE options END`,
    [k, String(question).slice(0, 300), options.slice(0, 12).join(' | ')]);
  save();
}

/**
 * Record that the agent auto-answered a question from profile/CV context (pending=2).
 * These appear in the dashboard's "Agent answered" section so the user can review/override.
 * A user answer (source='user', pending=0) is NEVER overwritten.
 * @param {string} question
 * @param {string} answer  - the answer the agent used
 * @param {string} [basis] - short description of how it was derived
 */
export function recordAgentAnswer(question, answer, basis = '', meta = {}) {
  const k = qkey(question);
  if (!k || answer == null || String(answer).trim() === '') return;
  recordEvolutionAudit('answer', k);
  resolveEvolutionAudit(auditFingerprint('answer', k), 'CV/profile-grounded answer recorded for review');
  const cur = one(`SELECT source, pending FROM answers WHERE qkey=?`, [k]);
  // Never overwrite a user-provided answer
  if (cur && cur.pending === 0 && cur.source === 'user') return;
  getDB().run(
    `INSERT INTO answers (qkey, question, answer, source, pending, options, confidence, match_percent, confidence_basis) VALUES (?,?,?,?,2,?,?,?,?)
     ON CONFLICT(qkey) DO UPDATE SET
       answer=excluded.answer,
       source='agent',
       pending=CASE WHEN pending=0 AND source='user' THEN 0 ELSE 2 END,
       uses=uses+1,
       options=excluded.options,
       confidence=excluded.confidence,
       match_percent=excluded.match_percent,
       confidence_basis=excluded.confidence_basis,
       updated_at=datetime('now')`,
    [k, String(question).slice(0, 300), String(answer).slice(0, 2000), 'agent', basis.slice(0, 200),
      meta.confidence == null ? confidenceFromBasis(basis) : Math.round(meta.confidence),
      meta.matchPercent == null ? (meta.confidence == null ? confidenceFromBasis(basis) : Math.round(meta.confidence)) : Math.round(meta.matchPercent),
      String(meta.confidenceBasis || basis).slice(0, 200)]);
  save();
}

/** Stable, explainable confidence band used by the dashboard report. */
export function confidenceFromBasis(basis = '') {
  const b = String(basis).toLowerCase();
  if (/name|email|phone|linkedin|github|location|country|currentcompany|headline|years|salary|notice|education/.test(b)) return 95;
  if (/workauth|authorized|sponsorship|legal/.test(b)) return 90;
  if (/profile\.answers|override|harvested/.test(b)) return 98;
  if (/generated|cover|summary|free-form/.test(b)) return 70;
  if (/standard yes|default|remote preference/.test(b)) return 62;
  return 75;
}

/** @returns {object[]} Questions pending user input (pending=1). */
export function pendingQuestions(limit = 40) {
  return rows(`SELECT * FROM answers WHERE pending=1 ORDER BY seen DESC LIMIT ?`, [limit]);
}

/** @returns {object[]} Questions auto-answered by the agent (pending=2) — shown for review. */
export function agentAnsweredQuestions(limit = 60) {
  return rows(`SELECT * FROM answers WHERE pending=2 ORDER BY uses DESC, updated_at DESC LIMIT ?`, [limit]);
}

/** @returns {object[]} All answered questions (pending=0). */
export function allAnswers() {
  return rows(`SELECT * FROM answers WHERE pending=0 ORDER BY uses DESC, updated_at DESC`);
}

/** Increment the use counter for a question key. */
export function usedAnswer(question) {
  getDB().run(`UPDATE answers SET uses=uses+1 WHERE qkey=?`, [qkey(question)]);
}

// ── 3. Strategy (bandit + learned skips) ─────────────────────────────────────

export function outcome(lane, key, { win = false, yieldN = 0 } = {}) {
  if (!key) return;
  const auditKey = `${lane}|${key}`;
  recordEvolutionAudit('strategy', auditKey);
  resolveEvolutionAudit(auditFingerprint('strategy', auditKey), 'strategy observation recorded');
  getDB().run(
    `INSERT INTO strategy (lane, key, tries, wins, yield) VALUES (?,?,1,?,?)
     ON CONFLICT(lane, key) DO UPDATE SET tries=tries+1, wins=wins+excluded.wins, yield=yield+excluded.yield, last=datetime('now')`,
    [lane, key, win ? 1 : 0, yieldN]);
  save();
}

/** UCB1 ranking of candidate keys by average yield (unseen keys are explored first). */
export function rankByUCB(lane, keys) {
  const st = Object.fromEntries(
    rows(`SELECT key, tries, yield FROM strategy WHERE lane=?`, [lane]).map(r => [r.key, r]));
  const total = Object.values(st).reduce((a, r) => a + r.tries, 0) + 1;
  return [...keys]
    .map(k => {
      const r = st[k];
      const ucb = !r ? 1e9 : r.yield / r.tries + 2 * Math.sqrt(Math.log(total) / r.tries);
      return { k, ucb: ucb + Math.random() * 0.01 };
    })
    .sort((a, b) => b.ucb - a.ucb)
    .map(x => x.k);
}

/** Domains that failed ≥4 times with zero wins are skipped until reset. */
export function learnedSkip(lane, key) {
  const r = one(`SELECT tries, wins FROM strategy WHERE lane=? AND key=?`, [lane, key]);
  return !!r && r.tries >= 4 && r.wins === 0;
}

export function strategyTable(lane) {
  return rows(`SELECT * FROM strategy WHERE lane=? ORDER BY tries DESC LIMIT 60`, [lane]);
}

// ── Playbook for the coding agent ────────────────────────────────────────────

export function writePlaybook() {
  const enc   = openEncounters(40);
  const pq    = pendingQuestions(30);
  const agent = agentAnsweredQuestions(20);
  const fails = rows(
    `SELECT lane, key, tries, wins FROM strategy WHERE lane LIKE '%domain' AND tries>=3 ORDER BY (wins*1.0/tries) ASC, tries DESC LIMIT 20`);
  const md = `# Evolution playbook (auto-generated ${new Date().toISOString()})

Read this at the start of every session. Fix the top encounters in code, teach answers
with the \`learn_answer\` tool (or ask the user), then \`resolve_encounter\`.

## Open encounters (most frequent first)
${enc.map(e => `- [#${e.id}] **${e.area}** ×${e.count} · ${e.domain || '-'} · \`${e.signature}\`${e.snapshot ? ` · snapshot: data/${e.snapshot}.{png,html}` : ''}${e.sample_url ? `\n  sample: ${e.sample_url}` : ''}`).join('\n') || '- none 🎉'}

## Questions waiting for the user (asked once, remembered forever)
${pq.map(q => `- (${q.seen}×) ${q.question}${q.options ? ` — options: ${q.options}` : ''}`).join('\n') || '- none'}

## Auto-answered by agent (review if incorrect)
${agent.map(a => `- "${a.question}" → "${a.answer}" (used ${a.uses}×, basis: ${a.options || 'profile'})`).join('\n') || '- none'}

## Low-success domains / ATS
${fails.map(f => `- ${f.lane} ${f.key}: ${f.wins}/${f.tries}`).join('\n') || '- none'}
`;
  fs.writeFileSync(path.join(EVO_DIR, 'PLAYBOOK.md'), md);
  return md;
}


// ── Self-healing reasoning loop ───────────────────────────────────────────────
//
// When an encounter fires, this is called NON-BLOCKINGLY (fire-and-forget from the lane).
// It reasons about the failure signature and tries lightweight in-process fixes so the
// SAME problem doesn't keep happening without at least an attempted recovery.
//
// Design rule: NEVER block or slow down the job-hunting pipeline.
// All healing logic runs after the lane has already moved on (Promise.resolve().then(...)).

/** Heal strategies keyed by area + signature pattern. Each returns true if it did something. */
const HEAL_RULES = [
  // ── Login-wall ────────────────────────────────────────────────────────────
  {
    match: sig => /not logged in|authwall|sign in|login/i.test(sig),
    area:  'any',
    heal:  async (enc) => {
      // Already handled by the login-backoff system in worker.js — just mark noted.
      console.error(`[evolve:heal] login-wall on ${enc.domain} — login banner already surfaced`);
      return false; // worker.js owns this; we just log
    },
  },
  // ── "No submit button" on form ────────────────────────────────────────────
  {
    match: sig => /no submit|submit button|submit not found|could not find.*button/i.test(sig),
    area:  'form',
    heal:  async (enc, { page } = {}) => {
      if (!page) return false;
      // Try to find any button with submit-like text and click it
      try {
        const clicked = await page.evaluate(() => {
          const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
          const sub = btns.find(b => /submit|apply|send|continue|next/i.test(b.textContent + b.value));
          if (sub) { sub.click(); return true; }
          return false;
        });
        if (clicked) {
          console.error(`[evolve:heal] form no-submit: clicked fallback button on ${enc.domain}`);
          return true;
        }
      } catch {}
      return false;
    },
  },
  // ── Stale / expired Easy Apply dialog ────────────────────────────────────
  {
    match: sig => /dialog.*closed|modal.*gone|apply.*dialog.*not found|no.*dialog/i.test(sig),
    area:  'easy_apply',
    heal:  async (enc, { page } = {}) => {
      if (!page) return false;
      // Re-click the Easy Apply button
      try {
        const clicked = await page.evaluate(() => {
          const btn = document.querySelector('[data-control-name="jobdetails_topcard_inapply"], button.jobs-apply-button');
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (clicked) {
          console.error(`[evolve:heal] easy_apply stale dialog: re-clicked apply button`);
          return true;
        }
      } catch {}
      return false;
    },
  },
  // ── Captcha ───────────────────────────────────────────────────────────────
  {
    match: sig => /captcha|robot|human verification|recaptcha/i.test(sig),
    area:  'any',
    heal:  async (enc) => {
      // Cannot solve captchas — log and let the login-banner system surface it
      console.error(`[evolve:heal] captcha on ${enc.domain} — cannot auto-solve, surfacing for user`);
      return false;
    },
  },
  // ── Timeout / navigation error ────────────────────────────────────────────
  {
    match: sig => /timeout|navigation.*failed|net::err|connection refused/i.test(sig),
    area:  'any',
    heal:  async (enc) => {
      // Transient — the worker already retries. Just note it.
      console.error(`[evolve:heal] network timeout on ${enc.domain} — worker will retry`);
      return false;
    },
  },
];

/**
 * Attempt lightweight self-healing for a freshly recorded encounter.
 * Called FIRE-AND-FORGET from encounter() — never awaited by the lane so it
 * cannot slow down or block the job-hunting pipeline.
 *
 * @param {string} area      - encounter area (easy_apply, form, connect, …)
 * @param {string} detail    - raw detail string
 * @param {object} [context] - optional { page, url } passed through from the caller
 */
export function attemptSelfHeal(area, detail, context = {}) {
  // Fire and forget — the lane does NOT await this
  Promise.resolve().then(async () => {
    const sig = signatureOf(detail);
    const domain = domainOf(context.url || '');
    const enc = { area, signature: sig, domain };
    let healed = false;
    for (const rule of HEAL_RULES) {
      if (rule.area !== 'any' && rule.area !== area) continue;
      if (!rule.match(sig)) continue;
      try { healed = await rule.heal(enc, context); } catch {}
      if (healed) break;
    }
    if (healed) {
      // Mark the encounter as auto-resolved so it doesn't pile up on the dashboard
      const db = getDB();
      db.run(`UPDATE encounters SET status='fixed', resolution='auto-healed by evolve.js self-heal rule'
              WHERE area=? AND signature=?`, [area, sig]);
      save();
    }
  }).catch(() => {}); // never throws to caller
}
