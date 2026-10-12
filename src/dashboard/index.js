// src/dashboard/index.js — Dashboard coordinator. Assembles all partials into one HTML page.
//
// Structure:
//   partials/header.js       → top bar, login banners, consent bar, questions alert
//   partials/kpis.js         → KPI scorecards + channel queue cards
//   partials/tables.js       → all data tables (email leads, queues, done log, bank, …)
//   partials/evolution.js    → Questions tab + Evolution tab
//   partials/clientscripts.js → browser-side JS (tab switching, answer save, stop, etc.)
//   styles.js                → all CSS
//
// The only file that touches the DB and profile is this coordinator.
// Add new dashboard sections by creating a partial and wiring it in here.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rows, one, initDB } from '../tracker.js';
import { DASH, DATA } from '../config.js';
import { getProfile } from '../profile.js';
import { recommendAnswer } from '../mcp/answers.js';
import { agentAnsweredQuestions } from '../evolve.js';

import { dashStyles } from './styles.js';
import {
  renderHeader,
  renderLoginBanners,
  renderConsentBar,
  renderQuestionsBanner,
} from './partials/header.js';
import { renderKpis, renderQueueCards } from './partials/kpis.js';
import {
  renderEmailLeadsTable,
  renderQueueTable,
  renderDoneTable,
  renderManualTable,
  renderEmailLogTable,
  renderConnectsTable,
  renderBankTable,
} from './partials/tables.js';
import { renderQuestionsTab, renderEvolutionTab } from './partials/evolution.js';
import { dashScripts } from './partials/clientscripts.js';
import { esc, STATUS, badge } from './helpers.js';

const q  = (sql, a = []) => rows(sql, a);
const n  = (sql, a = []) => one(sql, a)?.n || 0;
const ORDER = `ORDER BY CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, id DESC`;

/**
 * Generate and write the dashboard HTML file, then return its path.
 * @returns {string} absolute path to dashboard.html
 */
export function writeDash() {
  const p       = getProfile();
  const UIPORT  = Number(process.env.JOB_AGENT_PORT) || 7788;

  // Worker state (heartbeat)
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(DATA, 'worker-state.json'), 'utf8')); } catch {}
  const hbAge = state.ts ? (Date.now() - Date.parse(state.ts)) / 1000 : 1e9;
  const live  = hbAge < 600;

  // ── Metrics ─────────────────────────────────────────────────────────────────
  const today = {
    found:    n(`SELECT COUNT(*) n FROM jobs WHERE added_at > datetime('now','-1 day')`),
    emails:   n(`SELECT COUNT(*) n FROM emails_sent WHERE result='sent' AND ts > datetime('now','-1 day')`),
    easy:     n(`SELECT COUNT(*) n FROM actions WHERE type='li_easy_apply' AND result='ok' AND ts > datetime('now','-1 day')`),
    forms:    n(`SELECT COUNT(*) n FROM actions WHERE type='portal_apply' AND result='ok' AND ts > datetime('now','-1 day')`),
    connects: n(`SELECT COUNT(*) n FROM actions WHERE type='li_connect' AND result='ok' AND ts > datetime('now','-1 day')`),
  };
  const tot = {
    jobs:         n('SELECT COUNT(*) n FROM jobs'),
    emailsSent:   n(`SELECT COUNT(*) n FROM emails_sent WHERE result='sent'`),               // total emails sent (matches the Emails-sent tab)
    emailedUniq:  n(`SELECT COUNT(DISTINCT lower(to_email)) n FROM emails_sent WHERE result='sent'`), // unique recipients
    applied:      n(`SELECT COUNT(*) n FROM jobs WHERE status='applied'`),
    connected:    n(`SELECT COUNT(*) n FROM jobs WHERE status='connected'`),
    manual:       n(`SELECT COUNT(*) n FROM jobs WHERE status='needs_manual'`),
  };
  const queueCounts = {
    email:      n(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND channel='email'`),
    easy_apply: n(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND channel='easy_apply'`),
    form:       n(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND channel='form'`),
    connect:    n(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND channel='connect'`),
  };
  const doneCounts = {
    emailed:      tot.emailsSent,                                                            // total emails sent
    easy_applied: n(`SELECT COUNT(*) n FROM jobs WHERE status='applied' AND channel='easy_apply'`),
    form_applied: n(`SELECT COUNT(*) n FROM jobs WHERE status='applied' AND channel='form'`),
    connected:    tot.connected,
  };

  // ── Email leads ──────────────────────────────────────────────────────────────
  const emailLeads = q(`SELECT * FROM jobs WHERE email!='' AND status NOT IN ('skipped','stale') ORDER BY CASE WHEN source='linkedin_post' THEN 0 ELSE 1 END, CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, id DESC LIMIT 80`);

  // ── Channel queues ───────────────────────────────────────────────────────────
  const easyList    = q(`SELECT * FROM jobs WHERE status='new' AND channel='easy_apply' ${ORDER} LIMIT 60`);
  const formList    = q(`SELECT * FROM jobs WHERE status='new' AND channel='form'       ${ORDER} LIMIT 60`);
  const connectList = q(`SELECT * FROM jobs WHERE status='new' AND channel='connect'    ${ORDER} LIMIT 60`);
  const emailList   = q(`SELECT * FROM jobs WHERE status='new' AND channel='email'      ${ORDER} LIMIT 60`);

  // ── Done log ─────────────────────────────────────────────────────────────────
  const done   = q(`SELECT * FROM actions WHERE type IN ('email_send','li_easy_apply','portal_apply','li_connect') ORDER BY id DESC LIMIT 150`);
  const manual = q(`SELECT * FROM jobs WHERE status='needs_manual' ORDER BY updated_at DESC LIMIT 60`);
  const emails = q('SELECT * FROM emails_sent ORDER BY id DESC LIMIT 200');
  const conns  = q('SELECT * FROM connects ORDER BY id DESC LIMIT 100');
  const bank   = q(`SELECT * FROM jobs ${ORDER} LIMIT 1500`);

  // ── Evolution / Questions ────────────────────────────────────────────────────
  let pend = [], agentAnswered = [], enc = [], learned = [];
  try { pend         = q(`SELECT * FROM answers WHERE pending=1 ORDER BY seen DESC LIMIT 60`); } catch {}
  try { agentAnswered= agentAnsweredQuestions(60); } catch {}
  try { enc          = q(`SELECT * FROM encounters WHERE status IN ('open','regressed') ORDER BY count DESC, last_seen DESC LIMIT 60`); } catch {}
  try { learned      = q(`SELECT * FROM answers WHERE pending=0 AND answer!='' ORDER BY uses DESC, updated_at DESC LIMIT 100`); } catch {}

  // ── Status legend ────────────────────────────────────────────────────────────
  const statusCounts = q('SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY n DESC');
  const legend = Object.entries(STATUS).map(([k, [c, d]]) =>
    `<div>${badge(k)} <span class="dim">${d}</span> <b>${statusCounts.find(s => s.status === k)?.n || 0}</b></div>`
  ).join('');

  // ── Assemble HTML ────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="45">
  <title>Job Agent — ${esc(p.name || '')}</title>
  <style>${dashStyles()}</style>
</head>
<body>

${renderHeader({ name: p.name, live, state, hbAge, totalJobs: tot.jobs, UIPORT })}

<div class="wrap">

  ${renderLoginBanners(state.loginNeeded)}
  ${renderConsentBar(p.consent?.autoContribute !== false)}
  ${renderQuestionsBanner(pend.length)}

  ${renderKpis(today, tot)}
  ${renderQueueCards(queueCounts, doneCounts)}

  <h2>🔥 Fresh email leads — LinkedIn posts first, then the web (HN, Reddit, boards) · newest first</h2>
  ${renderEmailLeadsTable(emailLeads)}

  <div class="tabs">
    <button id="b-easy_apply" onclick="switchTab('easy_apply')">⚡ Easy Apply queue</button>
    <button id="b-form"       onclick="switchTab('form')">📋 Form queue</button>
    <button id="b-connect"    onclick="switchTab('connect')">🔗 Connect queue</button>
    <button id="b-email"      onclick="switchTab('email')">✉ Email queue</button>
    <button id="b-done"       onclick="switchTab('done')">✅ Done log</button>
    <button id="b-manual"     onclick="switchTab('manual')">🙋 Needs you (${manual.length})</button>
    <button id="b-questions"  onclick="switchTab('questions')" style="${pend.length ? 'color:#fcd34d;border-color:#a16207' : ''}">🧠 Questions (${pend.length})</button>
    <button id="b-evolution"  onclick="switchTab('evolution')">🧬 Evolution (${enc.length})</button>
    <button id="b-sent"       onclick="switchTab('sent')">📤 Emails sent</button>
    <button id="b-conns"      onclick="switchTab('conns')">🤝 Connects</button>
    <button id="b-bank"       onclick="switchTab('bank')">🗃 All leads</button>
  </div>

  <div class="pane" id="p-easy_apply">
    ${renderQueueTable('easy_apply', easyList)}
  </div>
  <div class="pane" id="p-form">
    ${renderQueueTable('form', formList, ['Portal'], j => `<td class="dim">${esc(j.portal)}</td>`)}
  </div>
  <div class="pane" id="p-connect">
    ${renderQueueTable('connect', connectList, ['Poster'], j => `<td>${j.poster_url ? `<a href="${esc(j.poster_url)}" target="_blank">${esc(j.poster_name || 'profile')}</a>` : ''}</td>`)}
  </div>
  <div class="pane" id="p-email">
    ${renderQueueTable('email', emailList, ['Email'], j => `<td class="em">${esc(j.email)}</td>`)}
  </div>
  <div class="pane" id="p-done">${renderDoneTable(done)}</div>
  <div class="pane" id="p-manual">${renderManualTable(manual)}</div>
  <div class="pane" id="p-questions">
    ${renderQuestionsTab(pend, agentAnswered, recommendAnswer)}
  </div>
  <div class="pane" id="p-evolution">
    ${renderEvolutionTab(enc, learned)}
  </div>
  <div class="pane" id="p-sent">${renderEmailLogTable(emails)}</div>
  <div class="pane" id="p-conns">${renderConnectsTable(conns)}</div>
  <div class="pane" id="p-bank">${renderBankTable(bank)}</div>

  <h2>Status legend</h2>
  <div class="legend">${legend}</div>
  <p class="dim" style="margin-top:8px">"Posted" = age of the post/listing (green &lt;6h, lime &lt;24h, yellow &lt;3d). Queues are processed in priority order: Email (LinkedIn posts → web) → Easy Apply → Forms → Connect, newest first.</p>

</div>

${dashScripts(UIPORT)}
</body>
</html>`;

  fs.writeFileSync(DASH, html, 'utf8');
  return DASH;
}

// ── CLI entry-point ────────────────────────────────────────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDB();
  writeDash();
  console.log('wrote ' + DASH);
}
