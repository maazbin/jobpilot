// src/dashboard/helpers.js — Pure formatting helpers for the dashboard.
// All functions are stateless: they take raw values and return HTML strings.
// No DB access, no profile reads — those happen in the coordinator (index.js).

/** HTML-escape a value. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Status definitions: { statusKey: [color, tooltip] } */
export const STATUS = {
  new:          ['#64748b', 'Found, waiting in a queue'],
  emailed:      ['#22c55e', 'Email sent from your Gmail (CV attached)'],
  applied:      ['#3b82f6', 'Application submitted (Easy Apply or external form)'],
  connected:    ['#a855f7', 'LinkedIn connection request sent to the poster'],
  needs_manual: ['#f97316', 'Started but needs you (unknown question, captcha, login-gated ATS)'],
  skipped:      ['#475569', 'Not relevant (junior, non-engineering, skip term) or duplicate'],
  stale:        ['#334155', 'Too old to act on'],
  failed:       ['#ef4444', 'Failed after max attempts'],
  draft:        ['#f59e0b', 'Legacy draft (not sent)'],
};

/** Channel display labels. */
export const CH = { email: '✉ Email', easy_apply: '⚡ Easy Apply', form: '📋 Form', connect: '🔗 Connect', none: '— none' };

/**
 * Render a colored status badge.
 * @param {string} s - status key
 * @returns {string} HTML
 */
export const badge = s => {
  const c = (STATUS[s] || ['#64748b'])[0];
  return `<span class="b" style="background:${c}22;color:${c};border-color:${c}55" title="${esc((STATUS[s] || [])[1] || '')}">${esc(s)}</span>`;
};

/**
 * Render an "agent answered" informational badge.
 * @returns {string} HTML
 */
export const agentBadge = () => `<span class="b-agent" title="The agent derived this answer from your profile — review if needed">🤖 agent answered</span>`;

/**
 * Human-readable age of an ISO timestamp, coloured by recency.
 * @param {string|null} iso
 * @returns {string} HTML
 */
export function ago(iso) {
  if (!iso) return '<span class="dim">?</span>';
  const s = (Date.now() - Date.parse(iso.length <= 19 ? iso.replace(' ', 'T') + 'Z' : iso)) / 1000;
  if (isNaN(s)) return '?';
  const t = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  const c = s < 6 * 3600 ? '#22c55e' : s < 86400 ? '#84cc16' : s < 3 * 86400 ? '#eab308' : '#64748b';
  return `<span style="color:${c};font-weight:700">${t}</span>`;
}

/**
 * Render a relevance percentage, coloured.
 * @param {number|string} r - 0–1 relevance score
 * @returns {string} HTML
 */
export const rel = r => {
  const v = Math.round((+r || 0) * 100);
  const c = v >= 60 ? '#22c55e' : v >= 40 ? '#3b82f6' : '#64748b';
  return `<span style="color:${c};font-weight:600">${v}%</span>`;
};

/**
 * Render an external link anchor (opens in new tab).
 * @param {string} u - URL
 * @param {string} [t] - link text
 * @returns {string} HTML
 */
export const link = (u, t = '↗') => u ? `<a href="${esc(u.startsWith('email:') ? '#' : u)}" target="_blank">${t}</a>` : '';

/**
 * Normalise source labels for display.
 * @param {string} s
 * @returns {string}
 */
export const srcLabel = s => esc((s || '').replace('linkedin_post', 'LI post').replace('linkedin_easy', 'LI jobs').replace('linkedin_jobs', 'LI jobs').replace('hn_hiring', 'HN hiring').replace('reddit_', 'r/'));

/**
 * Render a generic sortable HTML table.
 * @param {string} id - table element id
 * @param {string[]} head - column headers
 * @param {string} body - inner HTML of tbody
 * @param {string} empty - empty-state message
 * @returns {string} HTML
 */
export function table(id, head, body, empty) {
  return `<table id="${id}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="empty">${empty}</td></tr>`}</tbody></table>`;
}

/**
 * Render a KPI card.
 * @param {number|string} v - value
 * @param {string} l - label
 * @param {string} c - accent color
 * @returns {string} HTML
 */
export const kpi = (v, l, c) => `<div class="k" style="border-top-color:${c}"><div class="kv" style="color:${c}">${v}</div><div class="kl">${l}</div></div>`;
