// src/dashboard/partials/evolution.js — Questions tab + Evolution tab HTML.
// These are the two "self-improvement" tabs:
//   • Questions: unknown questions the agent hit, with pre-filled recommendations
//   • Evolution: open encounters (stuck pages) + the full learned-answers table

import { table, esc, agentBadge } from '../helpers.js';

/**
 * Render the Questions tab content.
 * Each row shows the question, how many times it was seen, a recommended answer
 * (pre-filled from profile), and an inline save button.
 * Auto-answered questions (derived by the agent) are shown with an informational badge
 * so the user can review and override them.
 *
 * @param {object[]} pend - pending question rows (pending=1)
 * @param {object[]} agentAnswered - questions the agent answered automatically (pending=2)
 * @param {function(string, string[]):object} recommend - recommendAnswer(q, opts) → {value, basis}
 * @returns {string} HTML
 */
export function renderQuestionsTab(pend, agentAnswered, recommend) {
  // --- Pending questions (need your input) ---
  const pendRows = pend.map(a => {
    const opts = (a.options || '').split(' | ').filter(Boolean);
    let rec = { value: '', basis: '' };
    try { rec = recommend(a.question, opts) || rec; } catch {}
    const recHint = rec.basis ? `<div class="dim" style="margin-top:4px">💡 suggested (${esc(rec.basis)})</div>` : '';
    let field;
    if (opts.length && opts.length <= 6) {
      field = opts.map(o =>
        `<button class="opt${o === rec.value ? ' rec' : ''}" onclick="ans('${esc(a.qkey)}','${esc(o)}')">${esc(o)}${o === rec.value ? ' ✓' : ''}</button>`
      ).join(' ');
    } else {
      const v = esc(rec.value || '');
      field = `<textarea class="ai" id="ai_${esc(a.qkey)}" rows="${rec.value && rec.value.length > 60 ? 3 : 1}" placeholder="type answer…">${v}</textarea><button class="opt" onclick="ans('${esc(a.qkey)}',document.getElementById('ai_${esc(a.qkey)}').value)">save</button>`;
    }
    return `<tr>
      <td class="role" style="max-width:520px">${esc(a.question)}<div class="dim">asked ${a.seen}×</div>${recHint}</td>
      <td>${field}</td>
    </tr>`;
  }).join('');

  // --- Agent-answered questions (informational, user can override) ---
  const agentRows = agentAnswered.map(a => `<tr>
    <td class="role" style="max-width:520px">
      ${esc(a.question)}
      <div class="dim" style="margin-top:2px">used ${a.uses || 1}×</div>
    </td>
    <td>
      <span class="em">${esc(a.answer)}</span>
      &nbsp;${agentBadge()}
      &nbsp;<button class="opt" style="font-size:11px;padding:2px 8px" onclick="overrideAns('${esc(a.qkey)}','${esc(a.answer)}')">override</button>
    </td>
  </tr>`).join('');

  const pendTable = table('questions',
    ['Question the agent hit', 'Your answer'],
    pendRows,
    'No open questions 🎉 the agent is answering everything itself');

  const agentTable = agentAnswered.length
    ? `<h2 style="margin-top:18px">🤖 Auto-answered by agent (${agentAnswered.length}) — review &amp; override if needed</h2>
       <p class="dim" style="margin-bottom:8px">These were derived from your profile. The agent used them already — click override to correct any.</p>
       ${table('agent_answered', ['Question', 'Agent\'s answer'], agentRows, '')}`
    : '';

  return `
<p class="dim" style="margin-bottom:8px">Answer once — the agent reuses it on every future application and stops asking.</p>
${pendTable}
${agentTable}`.trim();
}

/**
 * Render the Evolution tab content: open encounters + learned answers table.
 * @param {object[]} enc - open encounter rows
 * @param {object[]} learned - learned answer rows (pending=0)
 * @returns {string} HTML
 */
export function renderEvolutionTab(enc, learned) {
  const encRows = enc.map(e => `<tr>
    <td class="dim">#${e.id}</td>
    <td><b>${esc(e.area)}</b></td>
    <td class="dim">×${e.count}</td>
    <td>${esc(e.domain)}</td>
    <td class="role" style="max-width:460px">${esc(e.signature)}</td>
    <td>${e.snapshot
      ? `<a href="/evidence/${esc(e.snapshot.replace(/\\\\/g, '/').split('/').pop())}.png" target="_blank">shot</a> · <a href="/evidence/${esc(e.snapshot.replace(/\\\\/g, '/').split('/').pop())}.html" target="_blank">html</a>`
      : ''}</td>
    <td>${e.sample_url ? `<a href="${esc(e.sample_url)}" target="_blank">↗</a>` : ''}</td>
  </tr>`).join('');

  const learnRows = learned.map(a => `<tr>
    <td class="role" style="max-width:460px">${esc(a.question)}</td>
    <td class="em">${esc(a.answer)}</td>
    <td class="dim">${esc(a.source)}</td>
    <td class="dim">${a.uses}×</td>
  </tr>`).join('');

  return `
<p class="dim" style="margin-bottom:8px">Every failure the agent hit, grouped and counted, with a saved screenshot + HTML snapshot. Your coding agent reads <code>data/evolution/PLAYBOOK.md</code>, patches the code, and marks them fixed.</p>
${table('enc', ['#', 'Area', 'Count', 'Domain', 'Signature', 'Evidence', 'Sample'], encRows, 'No open encounters 🎉')}
<h2 style="margin-top:16px">Learned answers (${learned.length})</h2>
${table('learn', ['Question', 'Answer', 'Source', 'Uses'], learnRows, 'Nothing learned yet')}`.trim();
}
