// src/dashboard/partials/clientscripts.js — Browser-side JavaScript for the dashboard.
// Returned as a <script> block string. Handles tab switching, answer saving,
// consent toggle, worker stop, bank filtering, and answer override.
// The tab() function is now switchTab() to avoid conflicts with browser globals.

/**
 * Returns the inline <script> block for the dashboard.
 * @param {number} UIPORT - the dashboard server port (for API calls from file:// context)
 * @returns {string} HTML <script>...</script>
 */
export function dashScripts(UIPORT) {
  return `<script>
// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(t){
  document.querySelectorAll('.pane').forEach(e => e.classList.toggle('on', e.id === 'p-' + t));
  document.querySelectorAll('.tabs button').forEach(e => e.classList.toggle('on', e.id === 'b-' + t));
  history.replaceState(null, '', '#tab-' + t);
}
// Activate tab from URL hash on load
(function(){
  const m = location.hash.match(/tab-(\\w+)/);
  switchTab(m ? m[1] : 'easy_apply');
})();

// ── Bank filter ───────────────────────────────────────────────────────────────
function flt(v){
  v = v.toLowerCase();
  document.querySelectorAll('#bank tbody tr').forEach(r => r.style.display = r.innerText.toLowerCase().includes(v) ? '' : 'none');
}

// ── Save a user-provided answer ───────────────────────────────────────────────
async function ans(qkey, value){
  if (!value) return;
  const base = (location.protocol === 'file:' || !location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'saving…'; }
  try {
    const r = await fetch(base + '/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qkey, answer: value })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // Stay on Questions tab after save
    location.hash = '#tab-questions';
    location.reload();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'save'; }
    alert('Could not save — is the worker/server running? Open the dashboard at ' + base + '\\n\\nError: ' + e.message);
  }
}

// ── Override an agent-answered question ───────────────────────────────────────
function overrideAns(qkey, currentVal){
  const newVal = prompt('Override agent answer for this question:\\n\\n(current: ' + currentVal + ')', currentVal);
  if (newVal !== null && newVal.trim()) ans(qkey, newVal.trim());
}

// ── Consent toggle ────────────────────────────────────────────────────────────
async function consent(on){
  const base = (location.protocol === 'file:' || !location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  try {
    const r = await fetch(base + '/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoContribute: on })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.reload();
  } catch(e) {
    alert('Could not update consent — open the dashboard at ' + base + '.\\n\\nError: ' + e.message);
  }
}

// ── Stop the worker ───────────────────────────────────────────────────────────
async function stopAll(){
  if (!confirm('Stop the JobPilot worker? All four lanes halt within a few seconds. Your logged-in Chrome stays open.')) return;
  const base = (location.protocol === 'file:' || !location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  const b = event && event.target;
  if (b) { b.disabled = true; b.textContent = 'Stopping…'; }
  try {
    const r = await fetch(base + '/api/stop', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (b) b.textContent = 'Stopped ✓';
  } catch(e) {
    if (b) { b.disabled = false; b.textContent = '⏹ Stop worker'; }
    alert('Could not stop — open the dashboard at ' + base + '.\\n\\nError: ' + e.message);
  }
}
</script>`;
}
