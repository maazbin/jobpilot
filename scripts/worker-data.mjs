// scripts/worker-data.mjs — DATA-ONLY worker launcher (agent-triggered, never auto-started).
//
// This is the ONLY intended way to start the worker in this setup. It launches src/worker.js
// in DATA-ONLY mode: the worker scrapes leads into data/jobs.db and keeps the dashboard fresh,
// but NEVER emails, applies, or connects on its own. All job-finding reasoning, CV matching,
// applying, emailing, and connecting is done by the agent (Kiro) through the MCP tools.
//
// Triggered by the agent on a prompt signal (via a Kiro hook) or run manually: `npm run worker:data`.
//   • Clears any stale data/.stop flag so the worker can start.
//   • No-ops if a worker is already running (fresh heartbeat < 2 min old) — never double-starts.
//   • Spawns detached so it keeps scraping after this launcher exits.
// Stop it anytime with `npm run stop` (writes data/.stop) or the dashboard ⏹ Stop button.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const STATE = path.join(DATA, 'worker-state.json');
const STOPFILE = path.join(DATA, '.stop');
const NO_AUTOSTART_FILE = path.join(DATA, '.no-autostart');
const log = (...a) => process.stderr.write('[worker-data] ' + a.join(' ') + '\n');

// Kill-switch: when data/.no-autostart exists or JOBPILOT_NO_AUTOWORKER=1 is set, the worker must
// NOT start — not even via this launcher — unless the user EXPLICITLY forces it (so an automated
// hook or stray boot can never spawn it behind the user's back). The user forces a real start with
// `--force` / `JOBPILOT_FORCE_WORKER=1` (that is what `npm run worker:data -- --force` sends).
const FORCED = process.argv.includes('--force') || process.env.JOBPILOT_FORCE_WORKER === '1';
const killSwitch = process.env.JOBPILOT_NO_AUTOWORKER === '1' || fs.existsSync(NO_AUTOSTART_FILE);
if (killSwitch && !FORCED) {
  log('🔒 worker auto-start is DISABLED (data/.no-autostart or JOBPILOT_NO_AUTOWORKER=1). Not starting.');
  log('   The user must explicitly ask. To start on purpose: `npm run worker:data -- --force`.');
  process.exit(0);
}

// Already running? (heartbeat < 2 min old) → don't start a second one.
function workerIsLive() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return st.ts ? (Date.now() - Date.parse(st.ts)) < 2 * 60000 : false;
  } catch { return false; }
}

if (workerIsLive()) { log('a data worker is already running (fresh heartbeat) — not starting another.'); process.exit(0); }

// Make sure deps are present (first run installs them), same as `npm run worker`.
try {
  const ensure = spawnSync('node', [path.join(ROOT, 'scripts', 'ensure.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (ensure.status !== 0) { log('dependency check failed — run `npm install`.'); process.exit(1); }
} catch (e) { log('ensure step skipped: ' + (e.message || e)); }

// Clear any stale stop flag so the worker actually starts.
try { fs.rmSync(STOPFILE, { force: true }); } catch {}

// Launch the worker DATA-ONLY: scrape + dashboard only. No outreach, no self-evolve.
const env = { ...process.env, WORKER_DATA_ONLY: '1', WORKER_NO_EVOLVE: '1' };
const child = spawn('node', [path.join(ROOT, 'src', 'worker.js')], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  env,
});
child.unref();
log('🟢 data-only worker started (scrape + dashboard only; agent handles find/match/apply/email). Stop with `npm run stop`.');
