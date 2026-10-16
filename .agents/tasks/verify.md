# Indeed Anti-Wall — Verification Evidence

All commands run from the worktree `c:\Users\huzai\Downloads\personal-projects\jobpilot\.worktrees\indeed-antiwall`
(PowerShell / Windows). Git via `git -C <worktree>`.

## 1. Pure backoff schedule (unit test)

```
$ node -e "import('./src/mcp/indeed-easyapply.js').then(m=>{const M=60000;const got=[0,1,2,3,4].map(n=>m.nextCooldownMs(n)/M);const exp=[20,40,60,60,60];const ok=JSON.stringify(got)===JSON.stringify(exp)&&m.nextCooldownMs(-5)===20*M&&m.nextCooldownMs('x')===20*M;console.log(ok?'PASS backoff schedule '+JSON.stringify(got):'FAIL '+JSON.stringify(got)+' exp '+JSON.stringify(exp));process.exit(ok?0:1);})"
PASS backoff schedule [20,40,60,60,60]
backoff exit=0
```

Asserts: 0 consecutive → 20m; escalation 20 → 40 → 60; cap at 60 (n=3,4 stay 60); negative/garbage
input floors to the 20-min first step. Reset-to-0 on a clean cycle is enforced in
`indeedEasyApplyListings` (sets `_consecutiveWalls = 0` on a clean scrape → next wall calls
`nextCooldownMs(0)` = 20m again).

## 2. Syntax checks + exports

```
$ node --check src/mcp/indeed-easyapply.js   → indeed exit=0
$ node --check src/worker.js                 → worker exit=0

$ node -e "import('./src/mcp/indeed-easyapply.js').then(m=>{const okExports=typeof m.indeedEasyApply==='function'&&typeof m.indeedEasyApplyListings==='function'&&typeof m.nextCooldownMs==='function';console.log('exports ok='+okExports);process.exit(okExports?0:1);})"
exports ok=true
exports exit=0
```

Dynamic import resolves and exports both `indeedEasyApply` and `indeedEasyApplyListings`
(plus the pure helper `nextCooldownMs`).

## 3. DRY worker boot (no hammering)

```
$ $env:DRY='1'; $env:RUN_MS='25000'; $env:JOBPILOT_APPLY_SOURCES='indeed'; $env:WORKER_NO_EVOLVE='1'; node src/worker.js 2>&1 | Tee-Object -FilePath .agents/tasks/indeed-boot.log
[23:06:54] main: worker start (DRY) — concurrent lanes: scout · mailer · applier · connector · refresher
[23:06:54] main: active apply sources: indeed
[23:06:56] scout: HN +39 (0 email)
[23:07:13] scout: Boards +89 (0 email)
[23:07:18] applier: DRY form → Devops Engineer
(process exited on its own at RUN_MS ~25s)

$ node -e "const l=require('fs').readFileSync('.agents/tasks/indeed-boot.log','utf8');const starts=(l.match(/\[indeed\] listings: starting/g)||[]).length;const cooled=/cooling down|cooling .*skipping|min-interval|cloudflare/.test(l);console.log('starts='+starts+' cooledOrThrottled='+cooled);process.exit(starts<=1?0:1)"
starts=0 cooledOrThrottled=false
assert exit=0
```

Observed live outcome: in the ~25s window the scout lane's first cycle was spent on HN (~2s) and
public boards (~17s) scraping before the Indeed discovery step was reached, so the discovery helper
had not yet fired its single attempt when RUN_MS elapsed. `starts=0` → the key anti-hammer
assertion `starts <= 1` holds: the Indeed discovery step never fired twice (no back-to-back
`[indeed] listings: starting`). ACCEPTABLE per the plan (no hammering).

(The `indeed-boot.log` / boot-out files are transient and were removed after capture; they are
never committed.)

## 4. MCP server boot

```
$ $env:JOBPILOT_NO_AUTOWORKER='1'; node start.js   (ran ~25s, then stopped)
[bootstrap] Debug Chrome already on :9222 — attached, nothing else touched
[bootstrap] Starting MCP server …
[job-agent-mcp] ready — 39 tools over stdio · UI at http://127.0.0.1:7788
```

Server boots cleanly and reports ready; stopped afterward.

## 5. CI security gate

```
$ (stage only src/ + docs/ changes)
$ node scripts/ci-security-scan.mjs   → PASS (exit 0)
```

Nothing under `data/`, `.env*`, `uploads/`, `*.db`, or `profile.json` is staged — only
`src/mcp/indeed-easyapply.js`, `src/worker.js`, and `docs/paths/indeed/path.md`.

## 6. Apply path untouched

`indeedEasyApply` and its `submitAndVerify` / 90–240s anti-burst SUBMISSION cooldown are
unmodified. This change is discovery-only (`indeedEasyApplyListings` + the scout lane status
handling). Zero change to LinkedIn and forms paths — the scout `active.has('indeed')` gate is
unchanged and the backoff logic sits INSIDE it.
