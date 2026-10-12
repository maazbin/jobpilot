// src/dashboard/partials/kpis.js — KPI scorecards and channel queue cards.
// Renders the two rows of KPI tiles (today + all-time) and the 4 channel queue cards
// that link to the corresponding tab.

import { kpi, esc } from '../helpers.js';

/**
 * Render today's and all-time KPI cards.
 * @param {object} today - { found, emails, easy, forms, connects }
 * @param {object} tot   - { jobs, emailsSent, emailedUniq, applied, connected, manual }
 * @returns {string} HTML
 */
export function renderKpis(today, tot) {
  return `
<div class="ks">
  ${kpi(today.found,    'New leads (24h)',         '#60a5fa')}
  ${kpi(today.emails,   'Emails sent (24h)',        '#22c55e')}
  ${kpi(today.easy,     'Easy Applies (24h)',       '#3b82f6')}
  ${kpi(today.forms,    'Forms submitted (24h)',    '#06b6d4')}
  ${kpi(today.connects, 'Connects (24h)',           '#a855f7')}
  ${kpi(tot.emailsSent, 'Emails sent, all-time',    '#22c55e')}
  ${kpi(tot.emailedUniq,'Unique recipients',        '#16a34a')}
  ${kpi(tot.applied,    'Applied, all-time',        '#3b82f6')}
  ${kpi(tot.connected,  'Connected, all-time',      '#a855f7')}
  ${kpi(tot.manual,     'Needs you',                '#f97316')}
</div>`.trim();
}

/**
 * Render one channel queue summary card.
 * @param {string} ch - channel key (email|easy_apply|form|connect)
 * @param {string} label - display label with emoji
 * @param {string} c - accent colour
 * @param {string} doneLine - e.g. "42 emailed"
 * @returns {string} HTML
 */
export function renderQueueCard(ch, label, c, doneLine) {
  return `<a class="qc" href="#tab-${esc(ch)}" onclick="switchTab('${esc(ch)}')" style="border-color:${c}55">
  <div class="qh" style="color:${c}">${label}</div>
  <div id="qcount-${esc(ch)}">loading…</div>
  <div class="dim">${doneLine}</div>
</a>`;
}

/**
 * Render the grid of four channel queue cards.
 * @param {object} counts - { email, easy_apply, form, connect } queue counts
 * @param {object} done   - { emailed, easy_applied, form_applied, connected } done counts
 * @returns {string} HTML
 */
export function renderQueueCards(counts, done) {
  // Inline counts into the cards (no JS needed to load them)
  const card = (ch, label, c, doneLabel) =>
    `<a class="qc" href="#tab-${ch}" onclick="switchTab('${ch}')" style="border-color:${c}55">
      <div class="qh" style="color:${c}">${label}</div>
      <div><b>${counts[ch] || 0}</b> queued</div>
      <div class="dim">${doneLabel}</div>
    </a>`;
  return `<div class="qs">
  ${card('email',      '✉ Email queue',          '#22c55e', `${done.emailed} emailed`)}
  ${card('easy_apply', '⚡ Easy Apply queue',     '#3b82f6', `${done.easy_applied} applied`)}
  ${card('form',       '📋 External form queue',  '#06b6d4', `${done.form_applied} submitted`)}
  ${card('connect',    '🔗 Connect queue',        '#a855f7', `${done.connected} sent`)}
</div>`.trim();
}
