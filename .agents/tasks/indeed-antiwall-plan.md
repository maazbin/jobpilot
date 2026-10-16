# Indeed Anti-Wall Discovery — Implementation Plan

**Goal:** Make the worker's Indeed Pakistan discovery wall-resistant and self-protecting: reuse one persistent tab, warm-navigate gently, throttle discovery to once per ~10–15 min, hard-back-off on a Cloudflare wall (0→20→40→60 min, cap 60, reset on success), record the wall as an evolution encounter once per cooldown, and flag the user to clear Cloudflare manually when persistently walled — all inside the existing `indeed` source gate, with zero change to the apply/submit path.

**Architecture:** All navigation-cadence + backoff state lives module-level in `src/mcp/indeed-easyapply.js`. The pure backoff math is factored into a small exported helper (`nextCooldownMs`) so it is unit-testable with `node -e`. `indeedEasyApplyListings` becomes gate-aware: it returns `{ ok, status, leads, detail, persistentWall }` where `status ∈ {'ok','cooling','wall'}`. The scout lane in `src/worker.js` keeps the `active.has('indeed')` gate, honors the returned status (logs cooling/wall without re-navigating), and calls the existing `flagLogin` mechanism — extended with an `Indeed` entry — when `persistentWall` is set. The apply driver `indeedEasyApply` and its submit/verify logic are untouched.

**Tech Stack:** Node ESM, Playwright over CDP (:9222), no new dependencies. Verification uses the repo's standalone `node scripts/*.mjs` / `node -e` convention (no test framework).

---

## Context the implementer needs (read these first)

- `src/mcp/indeed-easyapply.js` — the ONLY module with Indeed browser logic. Discovery = `indeedEasyApplyListings(query, { pages })` (bottom of file, ~lines 266–345 in the current file). Apply = `indeedEasyApply(...)` (do NOT touch). Shared helpers already present and REUSED by this plan: `hitWall(page)` (title+body regex), `WALL_RE`, `SLEEP`, `PK_RESULTS(q)`, `score`/`relToIso` (from `./sources.js`), `encounter`/`askLater` (from `../evolve.js`). The apply path already has `cleanResultsPage(bctx, query)` which reuses a `pk.indeed.com/jobs` tab — mirror that reuse idea for discovery.
- `src/worker.js` scout lane — the Indeed step is the `if (active.has('indeed')) try { ... indeedEasyApplyListings(iq) ... }` block (current file ~lines 320–333, comment "3) Indeed Pakistan 'Easily apply' listings"). `flagLogin(site, reason, url)` is module-private (~line 133) with `LOGIN_URL = { LinkedIn, Gmail }` (~line 132). `clearLogin(site)`, `say('scout', …)`, `beat('scout', …)`, `jitter(PACE.scout)` are the logging/pacing primitives. The applier lane already treats Indeed `result:'captcha'` as a cooldown — leave that as-is.
- `src/evolve.js` — `encounter(area, detail, { url, page, scope })` is async; call with `area='indeed_easy'`. Reuse, do not reinvent.
- `src/apply-sources.js` — `activeSources(log) → Set`, pure `parseApplySources`. The `indeed` gate already wraps the scout Indeed step; the new logic sits INSIDE it. No change needed here.
- `docs/paths/indeed/path.md` — the proven anti-wall navigation table. Append a short "warm navigation + backoff" note.
- `scripts/test-apply-sources.mjs` — the house style for a pure unit test (plain `node`, `PASS`/`FAIL` lines, `process.exit`). The `node -e` test in Task 2 mirrors this shape inline.

Key facts that shape the plan:
- A direct `page.goto()` to `/jobs?q=…` or any `viewjob?jk=` URL walls. The proven path is: `goto https://pk.indeed.com/` (homepage) → fill `#text-input-what` + `#text-input-where`='Pakistan' → click **Find jobs** → land on results via in-page interaction.
- Module-level state persists across scout cycles because the module is imported once. This is how the persistent tab, the min-interval timestamp, and the cooldown counter survive between ~90s scout loops.
- When Chrome is absent, `getContext()` throws; `indeedEasyApplyListings` catches it and returns `{ ok:false }`. The DRY verification (Task 7) relies on this: the min-interval gate must run and short-circuit BEFORE `getContext()`, so the "runs at most once / does not retry on a wall" behavior is observable even without a live browser.

---

## Task 1: Add the pure cooldown helper + module-level backoff/cadence state

**Files:**
- Modify: `src/mcp/indeed-easyapply.js` (add near the top constants, after `WALL_RE`)

Add an exported PURE helper and module-level state. The helper computes the NEXT cooldown duration from the current consecutive-wall count; it has no side effects so it is unit-testable.

- [ ] **Step 1: Add the pure helper and state block**

Insert after the `const WALL_RE = …;` line:

```js
// ── Discovery cadence + wall backoff (module-level, persists across scout cycles) ──
// Normal discovery runs at most once per MIN_DISCOVERY_MS. On a Cloudflare wall we set a long
// cooldown that grows per consecutive wall: 20 → 40 → 60 min (cap 60), and resets to 0 after a
// clean cycle. nextCooldownMs is PURE (no I/O) so the schedule is unit-testable.
const MIN_DISCOVERY_MS = 12 * 60 * 1000;          // ~12 min between normal Indeed discovery runs
const WALL_STEP_MIN = 20;                          // first wall → 20 min
const WALL_CAP_MIN = 60;                           // cap at 60 min
const PERSISTENT_WALL_THRESHOLD = 2;               // # of 60-min-cap walls before flagging the user

/**
 * Pure. Given the number of CONSECUTIVE walls seen SO FAR (0 before the first wall), return the
 * cooldown to apply for the wall just hit, in milliseconds. Schedule (minutes): 0→20, 20→40,
 * 40→60, then capped at 60. A clean cycle resets the caller's counter to 0 (→ next wall is 20 again).
 * @param {number} consecutiveWalls - walls already recorded before this one (>= 0)
 * @returns {number} cooldown in ms
 */
export function nextCooldownMs(consecutiveWalls) {
  const n = Math.max(0, Math.floor(Number(consecutiveWalls) || 0));
  const minutes = Math.min(WALL_CAP_MIN, WALL_STEP_MIN * (n + 1));
  return minutes * 60 * 1000;
}

// Mutable discovery state (one Indeed tab + cadence/backoff). Reset-on-success keeps walls rare.
let _indeedPage = null;          // cached Playwright Page on a clean pk.indeed.com/jobs results view
let _lastDiscoveryAt = 0;        // epoch ms of the last discovery attempt (min-interval gate)
let _coolUntil = 0;              // epoch ms until which discovery is skipped (wall cooldown)
let _consecutiveWalls = 0;       // # of consecutive walls (drives nextCooldownMs; reset on clean)
let _capHits = 0;                // # of times cooldown reached the 60-min cap (→ persistent-wall flag)
let _encounterLoggedThisCooldown = false; // ensures ONE encounter() per cooldown period, not per skip
```

**Files touched:** `src/mcp/indeed-easyapply.js`.
**Verify:** `node --check src/mcp/indeed-easyapply.js` — exits 0 (file parses).

---

## Task 2: Unit-test the pure cooldown schedule

**Files:**
- (No new file — inline `node -e` test; schedule is asserted directly.)

- [ ] **Step 1: Run the backoff-schedule assertion**

Run (from the worktree root `c:\Users\huzai\Downloads\personal-projects\jobpilot\.worktrees\indeed-antiwall`):

```bash
node -e "import('./src/mcp/indeed-easyapply.js').then(m=>{const M=60000;const got=[0,1,2,3,4].map(n=>m.nextCooldownMs(n)/M);const exp=[20,40,60,60,60];const ok=JSON.stringify(got)===JSON.stringify(exp)&&m.nextCooldownMs(-5)===20*M&&m.nextCooldownMs('x')===20*M;console.log(ok?'PASS backoff schedule '+JSON.stringify(got):'FAIL '+JSON.stringify(got)+' exp '+JSON.stringify(exp));process.exit(ok?0:1);})"
```

Expected output: `PASS backoff schedule [20,40,60,60,60]` and exit code 0. This asserts the exact schedule 0→20m, 20→40, 40→60, cap 60, and that garbage/negative input floors to the 20-min first step.

**Files touched:** none.
**Verify:** the command above prints `PASS …` and exits 0.

---

## Task 3: Add a gentle warm-navigation helper that reaches results via the on-page search box

**Files:**
- Modify: `src/mcp/indeed-easyapply.js` (add a new helper near `cleanResultsPage`)

This helper reaches the results page the proven way (homepage → fill search → click Find jobs), never `goto`-ing `/jobs?q=…`. It is used ONLY by discovery; the apply path's `cleanResultsPage` is left as-is.

- [ ] **Step 1: Add `warmNavigateToResults`**

Insert above `indeedEasyApplyListings` (near `cleanResultsPage`):

```js
// Reach the Pakistan results page the WALL-SAFE way: load the homepage, then drive the on-page
// search box (fill what/where, click Find jobs) so results arrive via in-page interaction — never
// a direct goto to /jobs?q=... (that walls). Returns { page, walled }. On a homepage wall, returns
// { page, walled:true } without touching the search box. Mirrors docs/paths/indeed/path.md.
async function warmNavigateToResults(bctx, query) {
  const page = await bctx.newPage();
  page.setDefaultTimeout(30000);
  await page.goto('https://pk.indeed.com/', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => {});
  await SLEEP(3000 + Math.floor(Math.random() * 2000));   // jittered settle
  if (await hitWall(page)) return { page, walled: true };
  // Fill the on-page search and submit via the Find jobs button (in-page nav, no goto).
  try {
    const what = page.locator('#text-input-what').first();
    const where = page.locator('#text-input-where').first();
    if (await what.isVisible().catch(() => false)) { await what.fill(''); await what.type(query, { delay: 40 }); }
    if (await where.isVisible().catch(() => false)) { await where.fill(''); await where.type('Pakistan', { delay: 40 }); }
    const find = page.locator('button[type="submit"], button').filter({ hasText: /find jobs/i }).first();
    if (await find.isVisible().catch(() => false)) {
      await Promise.all([ page.waitForLoadState('domcontentloaded').catch(() => {}), find.click().catch(() => {}) ]);
    } else {
      await where.press('Enter').catch(() => {});
    }
    await SLEEP(3000 + Math.floor(Math.random() * 2000));
  } catch {}
  if (await hitWall(page)) return { page, walled: true };
  return { page, walled: false };
}

// Scrape the visible Easy-Apply cards from a results page into leads. Factored out so BOTH a
// reused tab and a freshly-warmed tab share one scraping path. Pure DOM read + mapping.
async function scrapeResultCards(page) {
  const cards = await page.evaluate(() => {
    const sels = ['a.jcs-JobTitle', 'a[data-jk]', 'h2.jobTitle a'];
    const seen = [];
    for (const s of sels) for (const el of document.querySelectorAll(s)) if (!seen.includes(el)) seen.push(el);
    return seen.map(a => {
      const card = a.closest('.job_seen_beacon, .cardOutline, li, td.resultContent') || a.parentElement;
      const jk = a.getAttribute('data-jk') || (a.href.match(/[?&]jk=([a-z0-9]+)/i) || [])[1] || '';
      const role = (a.innerText || a.getAttribute('title') || '').trim();
      const company = (card?.querySelector('[data-testid="company-name"], .companyName, span.companyName')?.innerText || '').trim();
      const location = (card?.querySelector('[data-testid="text-location"], .companyLocation, div.companyLocation')?.innerText || '').trim();
      const dateTxt = (card?.querySelector('[data-testid="myJobsStateDate"], .date, span.date')?.innerText || '').trim();
      const text = (card?.innerText || '').replace(/\s+/g, ' ').trim();
      return { jk, role, company, location, dateTxt, text };
    }).filter(c => c.jk);
  }).catch(() => []);
  const out = []; const seen = new Set();
  for (const c of cards) {
    if (seen.has(c.jk)) continue; seen.add(c.jk);
    const s = score(`${c.role} ${c.company} ${c.location} ${c.text}`, c.role);
    out.push({
      jk: c.jk, role: c.role, company: c.company, location: c.location || 'Pakistan',
      url: `https://pk.indeed.com/viewjob?jk=${c.jk}`,
      applyUrl: `https://pk.indeed.com/viewjob?jk=${c.jk}`,
      channel: 'indeed_easy', source: 'indeed_easy', portal: 'indeed',
      posted_at: relToIso(c.dateTxt) || '', relevance: s.rel, skip: s.skip, skipWhy: s.why,
      remote: /remote/i.test(c.location + ' ' + c.text),
    });
  }
  return out;
}
```

**Files touched:** `src/mcp/indeed-easyapply.js`.
**Verify:** `node --check src/mcp/indeed-easyapply.js` — exits 0.

---

## Task 4: Rewrite `indeedEasyApplyListings` for tab reuse, min-interval gate, and wall backoff

**Files:**
- Modify: `src/mcp/indeed-easyapply.js` — replace the body of `indeedEasyApplyListings` (current ~lines 266–345)

The new function: (a) short-circuits with `status:'cooling'` while `Date.now() < _coolUntil` or within `MIN_DISCOVERY_MS` of the last run — WITHOUT calling `getContext()` or navigating; (b) reuses `_indeedPage` if still on a clean results view; (c) otherwise warm-navigates once; (d) on a wall, grows the cooldown via `nextCooldownMs`, records ONE encounter per cooldown, tracks cap hits, and returns `status:'wall'` with `persistentWall`; (e) on a clean cycle resets all wall state.

- [ ] **Step 1: Replace the whole `indeedEasyApplyListings` function**

Replace the existing `export async function indeedEasyApplyListings(...)` through its final `}` with:

```js
/**
 * Discover Pakistan Easy-Apply listings — wall-resistant + self-throttling.
 * Reuses ONE persistent results tab across cycles; warm-navigates (homepage → search box → Find
 * jobs) only when no usable tab exists; NEVER goto()s /jobs?q= or viewjob?jk= directly. Throttles
 * to once per MIN_DISCOVERY_MS even without a wall, and HARD-backs-off (20→40→60m, cap 60) on a
 * Cloudflare wall, logging ONE encounter per cooldown period and surfacing a persistentWall flag
 * when the cooldown has hit the 60-min cap PERSISTENT_WALL_THRESHOLD times.
 * @returns {Promise<{ ok:boolean, status:'ok'|'cooling'|'wall', leads:object[], detail:string, persistentWall?:boolean, coolMs?:number }>}
 */
export async function indeedEasyApplyListings(query, { pages = 1 } = {}) {
  const now = Date.now();

  // (A) Cooling after a wall → skip entirely, do NOT navigate or even open the browser.
  if (now < _coolUntil) {
    const mins = Math.ceil((_coolUntil - now) / 60000);
    return { ok: false, status: 'cooling', leads: [], detail: `cooling ${mins}m (cloudflare)`, coolMs: _coolUntil - now };
  }
  // (B) Normal min-interval throttle → skip quietly until the window elapses.
  if (now - _lastDiscoveryAt < MIN_DISCOVERY_MS) {
    const mins = Math.ceil((MIN_DISCOVERY_MS - (now - _lastDiscoveryAt)) / 60000);
    return { ok: false, status: 'cooling', leads: [], detail: `throttled ${mins}m (min-interval)` };
  }
  _lastDiscoveryAt = now;

  console.error('[indeed] listings: starting, query=' + query);
  let bctx;
  try { bctx = await getContext(); } catch (e) {
    console.error('[indeed] listings: getContext() failed:', e.message);
    return { ok: false, status: 'wall', leads: [], detail: `browser error: ${e.message}` };
  }

  const markWall = async () => {
    // Grow cooldown, count cap hits, log ONE encounter per cooldown period, maybe flag persistent.
    const coolMs = nextCooldownMs(_consecutiveWalls);
    _consecutiveWalls += 1;
    _coolUntil = Date.now() + coolMs;
    if (coolMs >= WALL_CAP_MIN * 60000) _capHits += 1;
    const persistentWall = _capHits >= PERSISTENT_WALL_THRESHOLD;
    if (!_encounterLoggedThisCooldown) {
      _encounterLoggedThisCooldown = true;
      await encounter('indeed_easy', 'discovery cloudflare wall — human must clear Cloudflare in Chrome', {
        url: 'https://pk.indeed.com/', page: _indeedPage || null,
      }).catch(() => {});
    }
    // Drop the (possibly walled) cached tab so the next run warm-navigates fresh.
    try { if (_indeedPage) await _indeedPage.close().catch(() => {}); } catch {}
    _indeedPage = null;
    const mins = Math.round(coolMs / 60000);
    console.error(`[indeed] listings: hit cloudflare wall — cooling down ${mins}m${persistentWall ? ' (persistent)' : ''}`);
    return { ok: false, status: 'wall', leads: [], detail: `wall — cooling ${mins}m`, persistentWall, coolMs };
  };

  try {
    // (C) Reuse the cached tab if it is still a clean results page.
    let page = null, reused = false;
    if (_indeedPage && !_indeedPage.isClosed?.()) {
      try {
        if (/pk\.indeed\.com\/jobs/.test(_indeedPage.url()) && !(await hitWall(_indeedPage))) { page = _indeedPage; reused = true; }
      } catch { page = null; }
    }
    // (D) No usable tab → warm-navigate ONCE via the homepage search box.
    if (!page) {
      const wn = await warmNavigateToResults(bctx, query);
      page = wn.page;
      _indeedPage = page;                 // cache even if walled; markWall() closes it
      if (wn.walled || await hitWall(page)) return await markWall();
    }

    // Clean cycle → scrape, reset ALL wall state.
    const out = await scrapeResultCards(page);
    _consecutiveWalls = 0; _capHits = 0; _encounterLoggedThisCooldown = false; _coolUntil = 0;
    console.error(`[indeed] listings: ${out.length} Easy-Apply leads${reused ? ' (reused tab)' : ''}`);
    return { ok: true, status: 'ok', leads: out, detail: `${out.length} listings` };
  } catch (e) {
    console.error('[indeed] listings: error:', e.message);
    return { ok: false, status: 'wall', leads: [], detail: (e.message || '').slice(0, 200) };
  }
  // NOTE: do NOT close `page` here — the clean results tab is cached in _indeedPage for reuse.
}
```

Rationale for choices: caching the Page object (not just "a tab exists") lets a reused clean tab be re-scraped with zero navigation, which is the single biggest wall-avoidance win. The min-interval gate runs before `getContext()` so throttling is observable with no browser (and costs nothing). `markWall()` centralizes the backoff/encounter/flag bookkeeping so the three wall exit points (homepage wall, post-search wall, cached-tab turned walled) stay consistent.

**Files touched:** `src/mcp/indeed-easyapply.js`.
**Verify:** `node --check src/mcp/indeed-easyapply.js` — exits 0. Then re-run the Task 2 `node -e` test to confirm the exports still resolve and the schedule is unchanged.

---

## Task 5: Wire the scout lane to honor status + flag persistent walls

**Files:**
- Modify: `src/worker.js` — the `LOGIN_URL` map (~line 132) and the scout Indeed step (~lines 320–333, inside `if (active.has('indeed'))`)

Keep the `active.has('indeed')` gate exactly where it is; the new logic sits INSIDE it. Add `Indeed` to the login-URL map so `flagLogin('Indeed', …)` surfaces a correct one-click link.

- [ ] **Step 1: Add Indeed to the login URL map**

Change:

```js
const LOGIN_URL = { LinkedIn: 'https://www.linkedin.com/login', Gmail: 'https://mail.google.com/' };
```

to:

```js
const LOGIN_URL = { LinkedIn: 'https://www.linkedin.com/login', Gmail: 'https://mail.google.com/', Indeed: 'https://pk.indeed.com/' };
```

- [ ] **Step 2: Replace the scout Indeed step body**

Replace the inner body of the `if (active.has('indeed')) try { ... } catch (e) { ... }` block with:

```js
      if (active.has('indeed')) try {
        const roles = getProfile().preferences?.roles || [];
        const iq = roles[i % Math.max(1, roles.length)] || 'AI Engineer';
        beat('scout', 'indeed: ' + iq);
        const ri = await indeedEasyApplyListings(iq);
        if (ri.status === 'ok') {
          const { n } = ingest(ri.leads);
          say('scout', `indeed "${iq}" +${n}`);
          clearLogin('Indeed');                       // a clean cycle clears any stale banner
        } else if (ri.status === 'cooling') {
          // Cooling (wall backoff) OR min-interval throttle: do NOT navigate; just note and move on.
          say('scout', `[indeed] ${ri.detail} — skipping`);
        } else { // status === 'wall'
          say('scout', `[indeed] ${ri.detail}`);
          if (ri.persistentWall) {
            flagLogin('Indeed', 'Indeed keeps hitting a Cloudflare check — open Indeed in the JobPilot Chrome window and clear the "Just a moment" check manually (do not let the worker solve it).');
          }
        }
        // No per-step jitter needed beyond the module's own throttle, but keep the lane's pacing.
        await jitter(PACE.scout);
      } catch (e) { say('scout', 'indeed err ' + e.message.slice(0, 60)); }
```

Note: the module now self-throttles, so even though the scout loop reaches this block every cycle, the `cooling` short-circuit means it does NOT open a browser or navigate while throttled/cooling — satisfying "do not navigate when cooling".

**Files touched:** `src/worker.js`.
**Verify:** `node --check src/worker.js` — exits 0.

---

## Task 6: Document the warm-navigation + backoff requirement

**Files:**
- Modify: `docs/paths/indeed/path.md` (append a short section)

- [ ] **Step 1: Append the discovery-cadence note**

Add at the end of the file:

```markdown
## Discovery navigation (worker scout lane)

Indeed walls cold scripted navigation. The scout's discovery step must NOT `page.goto()` the
`/jobs?q=...` results URL (nor any `viewjob?jk=`). It reaches results the same way a human does:
load `https://pk.indeed.com/`, fill the on-page search (`#text-input-what`, `#text-input-where` =
`Pakistan`), click **Find jobs**. One persistent results tab is kept and re-read across cycles so
re-navigation is rare.

Cadence + backoff (see `src/mcp/indeed-easyapply.js`):
- Normal discovery runs at most once every ~12 minutes (module-level min-interval gate).
- On a Cloudflare wall it hard-backs-off: 20 → 40 → 60 min (cap 60), resetting to 0 after a clean
  cycle. While cooling it returns immediately (`status:'cooling'`) and the scout logs
  `[indeed] cooling … — skipping` WITHOUT navigating.
- The first wall per cooldown period is recorded as an evolution encounter.
- When the cooldown has hit the 60-min cap at least twice (persistent wall), the worker flags the
  user via the dashboard login banner to open Indeed and clear the check manually. Never solve it.
```

**Files touched:** `docs/paths/indeed/path.md`.
**Verify:** `node -e "const t=require('fs').readFileSync('docs/paths/indeed/path.md','utf8');process.exit(/Discovery navigation/.test(t)&&/min-interval/.test(t)?0:1)"` — exits 0.

---

## Task 7: Boot the worker in DRY mode and capture anti-hammer evidence

**Files:**
- Create: `.agents/tasks/verify.md` (the evidence file)

This proves (c): with the worker running ~25s, the Indeed discovery step runs AT MOST once and does NOT immediately retry after a wall/throttle. Because Chrome need not be live, the acceptable live outcome is EITHER a clean discovery OR a single wall-then-cooling — the pass criterion is the ABSENCE of hammering (no second `[indeed] listings: starting` within the run).

- [ ] **Step 1: Run the DRY, time-boxed boot and tee logs**

Run from the worktree root:

```bash
$env:DRY='1'; $env:RUN_MS='25000'; $env:JOBPILOT_APPLY_SOURCES='indeed'; $env:WORKER_NO_EVOLVE='1'; node src/worker.js 2>&1 | Tee-Object -FilePath .agents/tasks/indeed-boot.log
```

Expected: the process exits on its own at ~25s (RUN_MS). The log contains at most ONE `[indeed] listings: starting` line. If a wall occurs it is followed by a `cooling down Nm` line and NO second `starting` line in the same run. The scout lane may print `[indeed] … cooling … — skipping` on subsequent loops but must NOT re-navigate. `JOBPILOT_APPLY_SOURCES='indeed'` isolates the Indeed step; `WORKER_NO_EVOLVE=1` keeps the evolver quiet.

- [ ] **Step 2: Assert no hammering from the captured log**

Run:

```bash
node -e "const l=require('fs').readFileSync('.agents/tasks/indeed-boot.log','utf8');const starts=(l.match(/\[indeed\] listings: starting/g)||[]).length;const cooled=/cooling down|cooling .*skipping|min-interval/.test(l);console.log('starts='+starts+' cooledOrThrottled='+cooled);process.exit(starts<=1?0:1)"
```

Expected: `starts=0` or `starts=1`, exit code 0. `starts=0` is acceptable (browser unavailable → `getContext()` fails fast on the single attempt, or the min-interval gate had not yet elapsed); the key assertion is `starts<=1` — the discovery step never fired twice in a ~25s window, i.e. no hammering.

- [ ] **Step 3: Write `.agents/tasks/verify.md`**

Create `.agents/tasks/verify.md` with: (1) the Task 2 backoff `node -e` command and its `PASS` output; (2) the `node --check` results for both edited source files; (3) the DRY-boot command, the `starts=…` assertion output, and a one-line statement of which acceptable live outcome occurred (clean discovery vs. single wall-then-cooling); (4) a note that the apply path (`indeedEasyApply`) was not modified. Example skeleton:

```markdown
# Indeed Anti-Wall — Verification Evidence

## 1. Pure backoff schedule (unit test)
$ node -e "...nextCooldownMs..."
PASS backoff schedule [20,40,60,60,60]

## 2. Syntax checks
$ node --check src/mcp/indeed-easyapply.js   → ok
$ node --check src/worker.js                 → ok

## 3. DRY worker boot (no hammering)
$ $env:DRY='1'; $env:RUN_MS='25000'; $env:JOBPILOT_APPLY_SOURCES='indeed'; node src/worker.js ...
starts=<0 or 1> cooledOrThrottled=<bool>
Observed live outcome: <clean discovery | single wall-then-cooling>  → ACCEPTABLE (no second 'starting' in-run)

## 4. Apply path untouched
indeedEasyApply + submitAndVerify unchanged (discovery-only change).
```

**Files touched:** `.agents/tasks/verify.md` (+ transient `.agents/tasks/indeed-boot.log`).
**Verify:** `.agents/tasks/verify.md` exists and records a `starts<=1` result; the Task 2 and `node --check` commands are shown passing.

---

## Task 8: CI security gate + final regression check

**Files:** none (verification only)

- [ ] **Step 1: Run the CI security scan**

Run:

```bash
node scripts/ci-security-scan.mjs
```

Expected: exits 0 (no `data/`, `.env*`, `uploads/`, or credential paths staged/added by this change — all edits are to `src/` and `docs/`). If it reports staged forbidden paths, unstage them; this plan never writes under `data/`.

- [ ] **Step 2: Confirm no LinkedIn/forms regression (static)**

Run the existing pure-parser test to confirm the source-gate contract is intact:

```bash
node scripts/test-apply-sources.mjs
```

Expected: `ALL PASS`, exit 0. The scout `active.has('indeed')` gate is unchanged, LinkedIn/HN/boards/forms steps are untouched, and the applier Indeed branch (which treats `result:'captcha'` as a cooldown) is not modified — so there is zero behavioral change outside Indeed discovery.

**Files touched:** none.
**Verify:** both commands exit 0.

---

## Self-review notes

- **Spec coverage:** (1) persistent tab reuse → Task 4 `_indeedPage` cache + reuse branch. (2) gentle warm navigation → Task 3 `warmNavigateToResults` (homepage → search box → Find jobs, never goto results/viewjob). (3) hard wall backoff 20→40→60 cap 60, reset on success → Task 1 `nextCooldownMs` + Task 4 `markWall`/clean-cycle reset; `cooling` returns immediately without navigating (Task 4 branch A + scout branch Task 5). (4) min-interval throttle ~10–15 min → `MIN_DISCOVERY_MS=12m`, Task 4 branch B. (5) encounter once per cooldown → `_encounterLoggedThisCooldown` in `markWall`. (6) persistent-wall user flag via existing `flagLogin` → Task 5, with `Indeed` added to `LOGIN_URL`. Apply path untouched → explicitly out of scope in every task. Pakistan-only (`l=Pakistan`) preserved via `where`='Pakistan' and existing `PK_RESULTS`/`locationAllowed`.
- **Backoff signature (b):** `nextCooldownMs(consecutiveWalls: number) → number (ms)`; schedule `0→20m, 20→40, 40→60, cap 60`, reset-to-0 on clean cycle; asserted by the Task 2 `node -e` command.
- **DRY verification (c):** Task 7 Steps 1–2 — boot `DRY=1 RUN_MS=25000`, assert `starts<=1`, no second `starting` within the run.
- **Evidence file (d):** `.agents/tasks/verify.md` written in Task 7 Step 3.
- **Acceptable outcomes (e):** stated in Task 7 — clean discovery OR single wall-then-cooling both pass, as long as there is no hammering.
- **Type consistency:** the discovery return shape `{ ok, status, leads, detail, persistentWall?, coolMs? }` is produced in Task 4 and consumed in Task 5 by `ri.status`/`ri.detail`/`ri.persistentWall`. `flagLogin('Indeed', …)`/`clearLogin('Indeed')` match the `LOGIN_URL.Indeed` key added in Task 5 Step 1.
- **No new deps, ESM, no `data/` writes** — all edits under `src/` + `docs/`; evidence under `.agents/tasks/` (outside the repo's committed tree concerns and never staged by the security gate target paths).
```