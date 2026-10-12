// src/dashboard/partials/tables.js — HTML for all data tables in the dashboard tabs.
// Each function returns a <table> HTML string from pre-fetched row data.
// Keeps all table rendering in one place for easy modification.

import { table, ago, srcLabel, rel, badge, link, esc, CH } from '../helpers.js';

/**
 * Render the "Fresh email leads" table.
 * @param {object[]} emailLeads - job rows with email field
 * @returns {string} HTML
 */
export function renderEmailLeadsTable(emailLeads) {
  const rows = emailLeads.map(j => `<tr>
    <td>${ago(j.posted_at || j.added_at)}</td>
    <td>${srcLabel(j.source)}</td>
    <td class="role">${esc(j.role)}</td>
    <td>${esc(j.company)}</td>
    <td><span class="em">${esc(j.email)}</span></td>
    <td>${rel(j.relevance)}</td>
    <td>${badge(j.status)}</td>
    <td class="dim">${j.status === 'emailed' ? 'sent ' + esc((j.applied_at || '').slice(5, 16).replace('T', ' ')) : esc((j.notes || '').slice(0, 50))}</td>
    <td>${link(j.url.startsWith('email:') ? '' : j.url)}</td>
  </tr>`).join('');
  return table('emails', ['Posted', 'Source', 'Role', 'Company', 'Email', 'Match', 'Status', 'Result', 'Post'],
    rows, 'No email leads yet');
}

/**
 * Render a channel queue table (Easy Apply / Form / Connect / Email).
 * @param {string} ch - channel key
 * @param {object[]} list - job rows for this channel
 * @param {string[]} extraHead - extra column headers
 * @param {function(object):string} extraCell - returns <td>...</td> HTML for extra columns
 * @returns {string} HTML
 */
export function renderQueueTable(ch, list, extraHead = [], extraCell = () => '') {
  const rows = list.map(j => `<tr>
    <td>${ago(j.posted_at || j.added_at)}</td>
    <td>${srcLabel(j.source)}</td>
    <td class="role">${esc(j.role)}</td>
    <td>${esc(j.company)}</td>
    ${extraCell(j)}
    <td>${rel(j.relevance)}</td>
    <td class="dim">${j.attempts || 0}</td>
    <td>${link(j.apply_url || j.url)}</td>
  </tr>`).join('');
  return table('q_' + ch, ['Posted', 'Source', 'Role', 'Company', ...extraHead, 'Match', 'Tries', 'Link'],
    rows, 'Queue empty — worker is scraping for more');
}

/**
 * Render the Done log table (all completed actions).
 * @param {object[]} done - action rows
 * @returns {string} HTML
 */
export function renderDoneTable(done) {
  const TYPE = { email_send: '✉ Email', li_easy_apply: '⚡ Easy Apply', portal_apply: '📋 Form', li_connect: '🔗 Connect' };
  const rows = done.map(a => {
    const c = a.result === 'ok' ? '#22c55e' : a.result === 'manual' ? '#f97316' : a.result === 'skip' ? '#64748b' : '#ef4444';
    return `<tr>
      <td class="dim">${esc((a.ts || '').slice(5, 16))}</td>
      <td>${TYPE[a.type] || esc(a.type)}</td>
      <td class="role">${esc(a.role)}</td>
      <td>${esc(a.company)}</td>
      <td class="dim">${esc((a.target || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 45))}</td>
      <td><b style="color:${c}">${esc(a.result)}</b></td>
      <td class="dim">${esc((a.detail || '').slice(0, 90))}</td>
    </tr>`;
  }).join('');
  return table('done', ['When', 'Channel', 'Role', 'Company', 'Target', 'Result', 'Detail'],
    rows, 'Nothing done yet');
}

/**
 * Render the "Needs you" (manual) table.
 * @param {object[]} manual - job rows with status=needs_manual
 * @returns {string} HTML
 */
export function renderManualTable(manual) {
  const rows = manual.map(j => `<tr>
    <td>${ago(j.posted_at || j.added_at)}</td>
    <td>${CH[j.channel] || ''}</td>
    <td class="role">${esc(j.role)}</td>
    <td>${esc(j.company)}</td>
    <td class="dim" style="max-width:420px">${esc(j.notes)}</td>
    <td>${link(j.apply_url || j.url, 'finish ↗')}</td>
  </tr>`).join('');
  return table('manual', ['Posted', 'Channel', 'Role', 'Company', 'Why / unanswered questions', 'Link'],
    rows, 'Nothing needs you 🎉');
}

/**
 * Render the emails-sent log table.
 * @param {object[]} emails - email_sent rows
 * @returns {string} HTML
 */
export function renderEmailLogTable(emails) {
  const rows = emails.map(e => `<tr>
    <td class="dim">${esc((e.ts || '').slice(5, 16))}</td>
    <td class="em">${esc(e.to_email)}</td>
    <td>${esc(e.company)}</td>
    <td class="role">${esc(e.role)}</td>
    <td class="dim">${esc((e.subject || '').slice(0, 70))}</td>
    <td><b style="color:${e.result === 'sent' ? '#22c55e' : '#f59e0b'}">${esc(e.result)}</b></td>
  </tr>`).join('');
  return table('sent', ['When', 'To', 'Company', 'Role', 'Subject', 'Result'],
    rows, 'No emails yet');
}

/**
 * Render the connects log table.
 * @param {object[]} conns - connects rows
 * @returns {string} HTML
 */
export function renderConnectsTable(conns) {
  const rows = conns.map(c => `<tr>
    <td class="dim">${esc((c.ts || '').slice(5, 16))}</td>
    <td>${link(c.profile_url, esc(c.name || (c.profile_url || '').split('/in/')[1] || c.profile_url))}</td>
    <td class="role">${esc(c.role)}</td>
    <td>${esc(c.result)}</td>
    <td class="dim">${esc((c.note || '').slice(0, 110))}</td>
  </tr>`).join('');
  return table('conns', ['When', 'Person', 'About', 'Result', 'Note'],
    rows, 'No connects yet');
}

/**
 * Render the full job bank table (all leads, searchable via JS).
 * @param {object[]} bank - all job rows
 * @returns {string} HTML
 */
export function renderBankTable(bank) {
  const rows = bank.map(j => `<tr data-s="${esc(j.status)}">
    <td>${ago(j.posted_at || j.added_at)}</td>
    <td>${srcLabel(j.source)}</td>
    <td class="role">${esc(j.role)}</td>
    <td>${esc(j.company)}</td>
    <td>${CH[j.channel] || '—'}</td>
    <td class="em">${esc(j.email)}</td>
    <td>${rel(j.relevance)}</td>
    <td>${badge(j.status)}</td>
    <td class="dim">${esc((j.notes || '').slice(0, 60))}</td>
    <td>${link(j.apply_url || j.url)}</td>
  </tr>`).join('');
  return `<input class="s" placeholder="filter… (role, company, status, email)" oninput="flt(this.value)">
${table('bank', ['Posted', 'Source', 'Role', 'Company', 'Channel', 'Email', 'Match', 'Status', 'Notes', 'Link'],
    rows, 'Empty')}`;
}
