// scripts/agent-forever.mjs — NEVER-STOP entrypoint for the HANDS of the brain-driven architecture.
//
// Runs and respawns ONLY the DATA-ONLY worker (src/worker.js with WORKER_DATA_ONLY=1): it scrapes
// leads into the DB and keeps the dashboard fresh. It never emails/applies/connects on its own.
//
// IMPORTANT — one brain must NEVER spawn another brain. This supervisor does NOT launch any
// coding-agent CLI (codex/grok/claude/gemini). Each brain runs INDEPENDENTLY (started by the user /
// its own runtime), reads AGENTS.md, connects to the JobPilot MCP, and drives every apply/email/
// connect itself. The brain is the top of the stack; this process is just the hands it feeds from.
//
// Usage:  npm run agent   (or: node scripts/agent-forever.mjs)
// Stop:   npm run stop  / dashboard ⏹  (writes data/.stop)
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOPFILE = path.join(ROOT, 'data', '.stop');
const NO_AUTOSTART_FILE = path.join(ROOT, 'data', '.no-autostart');
const log = (...a) => process.stderr.write('[agent-forever] ' + a.join(' ') + '\n');

// Kill-switch: refuse to run the supervisor at all when auto-start is disabled, unless the user
// explicitly forces it (`--force` / JOBPILOT_FORCE_WORKER=1). Prevents an unattended `npm run agent`
// from reviving the worker when the user has turned auto-start off.
const FORCED = process.argv.includes('--force') || process.env.JOBPILOT_FORCE_WORKER === '1';
if ((process.env.JOBPILOT_NO_AUTOWORKER === '1' || fs.existsSync(NO_AUTOSTART_FILE)) && !FORCED) {
  log('🔒 auto-start is DISABLED (data/.no-autostart or JOBPILOT_NO_AUTOWORKER=1). Supervisor not starting.');
  log('   To run on purpose: `npm run agent -- --force`.');
  process.exit(0);
}

try { fs.rmSync(STOPFILE, { force: true }); } catch {}   // clear a stale stop flag so we start
const stopped = () => fs.existsSync(STOPFILE);

/** Supervise the data-only worker: respawn on non-clean exit unless the user has Stopped. */
let restarts = 0;
function start() {
  if (stopped()) { log('stop flag present — not starting.'); return; }
  const child = spawn('node', [path.join(ROOT, 'src', 'worker.js')], {
    cwd: ROOT, stdio: 'inherit',
    // DATA-ONLY hands; NO_EVOLVE so the worker never git-syncs/contributes or wipes local changes
    // on boot — contribution is a brain's job, done through the MCP tools per AGENTS.md.
    env: { ...process.env, WORKER_DATA_ONLY: '1', WORKER_NO_EVOLVE: '1' },
  });
  child.on('exit', (code, signal) => {
    if (code === 0 || stopped()) { log('worker exited cleanly / stop requested — supervisor done.'); process.exit(0); return; }
    restarts++;
    const wait = Math.min(60000, 3000 * restarts);
    log(`worker died (code=${code} signal=${signal}) — restarting in ${Math.round(wait / 1000)}s (#${restarts})`);
    setTimeout(start, wait);
  });
  child.on('error', e => log('spawn error: ' + e.message));
}

log('starting data-only worker (the hands). A brain attaches independently and drives via AGENTS.md.');
start();

// Exit promptly once the user Stops.
const iv = setInterval(() => { if (stopped()) { log('⏹ Stop requested — supervisor exiting.'); clearInterval(iv); process.exit(0); } }, 3000);
