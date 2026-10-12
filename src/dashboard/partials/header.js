// src/dashboard/partials/header.js — Top header bar + banner alerts.
// Renders the worker status dot, live beat info, login-needed banners,
// consent toggle, and the "questions pending" alert banner.

import { esc } from '../helpers.js';

/**
 * Render the fixed top header bar.
 * @param {object} opts
 * @param {string} opts.name - user display name
 * @param {boolean} opts.live - is the worker currently running?
 * @param {object} opts.state - worker-state.json contents
 * @param {number} opts.hbAge - heartbeat age in seconds
 * @param {number} opts.totalJobs - total jobs in DB
 * @param {number} UIPORT - dashboard port
 * @returns {string} HTML
 */
export function renderHeader({ name, live, state, hbAge, totalJobs, UIPORT }) {
  return `
<div class="hdr">
  <div>
    <h1><span class="dot" style="background:${live ? '#22c55e' : '#ef4444'}"></span>Job Agent — ${esc(name || '')}</h1>
    <div class="dim">${live
      ? `Worker LIVE · ${esc(Object.entries(state.lanes || {}).map(([k, v]) => k + ':' + (v.phase || '')).join(' · ').slice(0, 160)) || esc(state.phase || '')} · beat ${Math.round(hbAge)}s ago`
      : 'Worker not running'} · ${new Date().toLocaleString('en-GB')} · auto-refresh 45s</div>
  </div>
  <div style="text-align:right">
    <div class="kv" style="color:#60a5fa">${totalJobs}</div>
    <div class="dim">leads in bank</div>
    ${live ? `<button class="stopbtn" onclick="stopAll()">⏹ Stop worker</button>` : ''}
  </div>
</div>`.trim();
}

/**
 * Render login-needed banners (one per site that needs re-auth).
 * @param {object} loginNeeded - { site: { reason, url } }
 * @returns {string} HTML (empty string if no logins needed)
 */
export function renderLoginBanners(loginNeeded = {}) {
  if (!Object.keys(loginNeeded).length) return '';
  return Object.entries(loginNeeded).map(([site, info]) =>
    `<div class="loginbanner">🔑 <b>${esc(site)} needs you to log in.</b> ${esc(info.reason || '')} &nbsp;→&nbsp;
    <a class="loginbtn" href="${esc(info.url)}" target="_blank" rel="noopener">Open ${esc(site)} &amp; log in ↗</a>
    <span class="dim">(in the JobPilot Chrome window — the agent resumes automatically once you're back in)</span></div>`
  ).join('');
}

/**
 * Render the self-contribution consent toggle bar.
 * @param {boolean} autoContribute - current consent state
 * @returns {string} HTML
 */
export function renderConsentBar(autoContribute) {
  return autoContribute
    ? `<div class="consentbar">🧬 <b>Self-contribution: ON.</b> JobPilot may file blocker issues and push <i>code/doc</i> improvements to the public repo (never your data). <button class="cbtn off" onclick="consent(false)">Turn off</button></div>`
    : `<div class="consentbar">🧬 <b>Self-contribution: OFF.</b> JobPilot keeps every improvement local. Opt in to let it file issues &amp; push <i>code/doc</i> fixes back (hard-guarded — never your data/creds). <button class="cbtn on" onclick="consent(true)">Enable contributing back</button></div>`;
}

/**
 * Render the "questions pending" alert banner if any questions need answers.
 * @param {number} pendCount - number of pending questions
 * @returns {string} HTML (empty if no pending questions)
 */
export function renderQuestionsBanner(pendCount) {
  if (!pendCount) return '';
  return `<div class="qbanner">🧠 The agent needs <b>${pendCount}</b> answer${pendCount > 1 ? 's' : ''} from you to apply to more jobs → <a href="#tab-questions" onclick="switchTab('questions')" style="color:#fcd34d;text-decoration:underline">answer them in the Questions tab ↓</a>. It remembers every answer forever.</div>`;
}
