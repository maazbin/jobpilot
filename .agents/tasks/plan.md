# Configurable Apply/Discovery Channels — Implementation Plan

> **For agentic workers:** Implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax
> for tracking. Each task leaves the worktree in a buildable, runnable state.

**Goal:** Make the always-on worker's apply/discovery CHANNELS configurable so a user can run all
three boards (LinkedIn, Indeed, Glassdoor) or any subset, defaulting to ALL enabled (zero behavior
change unless configured).

**Architecture:** Add one tiny pure-ESM module `src/apply-sources.js` exposing a pure parser
`parseApplySources(input, profileVal)` and a live resolver `activeSources()` that reads the env
override and the profile knob AT CALL TIME. Gate the three board-specific branches in
`src/worker.js` (applier lane: `easy_apply` behind `linkedin`, `indeed_easy` behind `indeed`;
scout lane: LI posts/jobs behind `linkedin`, Indeed PK discovery behind `indeed`, Glassdoor behind
`glassdoor`). HN/boards/web discovery and the `form`/`email`/`connect` channels stay ungated.

**Tech Stack:** Node.js ESM, no new dependencies. Project `say()`/`beat()` console logging
convention. Tests are standalone ESM scripts under `scripts/` run with `node`, printing PASS/FAIL
and exiting non-zero on failure (pattern: `scripts/test-exclusions.mjs`, `scripts/test-board-pages.mjs`).

---

## Key findings from exploration (ground truth — read before editing)

- **`src/profile.js`** — `updateProfile(patch)` shallow-merges `preferences`:
  `preferences: { ...p.preferences, ...(patch.preferences || {}) }`. `getProfile()` returns the
  live profile from disk each call (`load()` re-reads `data/profile.json`). So a new key
  `preferences.applySources` **already persists** through `set_profile` and is readable live. **Do
  NOT change profile.js or the set_profile schema** — confirm with a test instead (Task 4).
- **`mcp-server.js`** `set_profile` handler → `updateProfile(args)`; `preferences` is a free-form
  `object` in the schema, so arbitrary keys pass through. No change needed.
- **`src/worker.js` APPLIER lane** (lines ~419–428): 3-way rotation
  `const slot = turn++ % 3;` → `wantEasy` (slot 0, not cooling) / `wantIndeed` (slot 1, or slot 0
  while LI cooling) / else `form`. `chan = wantEasy ? 'easy_apply' : wantIndeed ? 'indeed_easy' : 'form'`.
  The Easy-Apply cooldown/limit vars (`liCooling`, `liCooldownUntil`, `easyFailStreak`) are computed
  before this block and used in the `doEasy` branch — gating must only change channel SELECTION, not
  touch those vars.
- **`src/worker.js` SCOUT lane** (lines ~278–338): step 1 LI posts (`beat('scout', 'LI posts:…')`,
  line ~283), step 2 web (HN + Boards, lines ~303–312 — **keep always-on**), step 3 Indeed PK
  listings (`beat('scout', 'indeed:…')`, line ~316), step 4 LI jobs (`i % 2 === 0`, line ~327).
- **Glassdoor has NO discovery/scrape call in the scout lane today.** Glassdoor is external /
  board-pages routed only (`src/mcp/board-pages.js`). There is nothing to gate in scout for
  Glassdoor right now. We still expose `glassdoor` in `activeSources()` so the toggle exists and is
  wired/testable, and we add a guard comment at the scout Indeed/web region documenting that any
  future Glassdoor scout step must be gated behind `glassdoor`. Record this in the verify note.
- **Boot log line**: resolved active sources must be logged once at boot near the existing
  `say('main', 'worker start …')` line (~708).
- **CI security gate** (`scripts/ci-security-scan.mjs`): never stage anything under `data/`,
  `.env*`, `uploads/`, `*.db`, `profile.json`. The new module and test touch none of these.
- **No existing `src/apply-sources.js`** — safe to create.

---

## Task 1: Create `src/apply-sources.js` (pure parser + live resolver)

**Files:**
- Create: `src/apply-sources.js`

Implement an ESM module with a canonical source set `{ linkedin, indeed, glassdoor }`, a PURE
parser used by both env and profile inputs, and a live resolver read AT CALL TIME.

Normalization rules for `parseApplySources(input, profileVal)` (precedence high→low: env `input`,
then profile `profileVal`, then default all):
- Each input may be a string (comma-separated) OR an array of strings. Tokens are trimmed and
  lowercased (case-insensitive).
- `all` or `*` (as any token) → all three enabled.
- Known tokens: `linkedin`, `indeed`, `glassdoor`. Unknown tokens are ignored.
- If an input is empty/absent (empty string, whitespace-only, empty array, null, undefined) → fall
  through to the next source. If BOTH env and profile fall through → default: all three.
- If an input is NON-empty but parses to an EMPTY known-set (e.g. `"foo,bar"` — only unknown
  tokens) → treat as all-enabled (never silently disable everything) AND return a signal so the
  caller can LOG one clear line that the input parsed to empty.
- The parser is pure: no I/O, no env reads, no logging. It returns a normalized result the resolver
  turns into a `Set` and a log decision.

Suggested shape (adapt names to match project style; keep it tiny):

```js
// src/apply-sources.js — which job BOARDS the worker acts on / discovers.
// Three logical sources: linkedin, indeed, glassdoor. Default = all three (no behavior change).
// Resolved AT CALL TIME (never cached at boot) so set_profile changes take effect next loop.
// Precedence high→low: env JOBPILOT_APPLY_SOURCES, profile.preferences.applySources, default-all.
import { getProfile } from './profile.js';

export const ALL_SOURCES = ['linkedin', 'indeed', 'glassdoor'];

function tokens(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  return arr.map(t => String(t).trim().toLowerCase()).filter(Boolean);
}

/**
 * Pure. Resolve the active board set from an env value and a profile value.
 * @returns {{ sources: string[], emptyInput: boolean }}
 *   sources: normalized subset of ALL_SOURCES (always non-empty).
 *   emptyInput: true when a NON-empty input parsed to zero known tokens (caller should log once).
 */
export function parseApplySources(input, profileVal) {
  for (const candidate of [input, profileVal]) {
    const toks = tokens(candidate);
    if (!toks.length) continue;                     // empty/absent → fall through
    if (toks.includes('all') || toks.includes('*')) return { sources: [...ALL_SOURCES], emptyInput: false };
    const known = ALL_SOURCES.filter(s => toks.includes(s));
    if (known.length) return { sources: known, emptyInput: false };
    // non-empty but all tokens unknown → never disable everything; flag for a log line
    return { sources: [...ALL_SOURCES], emptyInput: true };
  }
  return { sources: [...ALL_SOURCES], emptyInput: false };   // default: all three
}

let warnedEmpty = false;
/**
 * Live resolver — reads env + profile AT CALL TIME (not a boot snapshot).
 * @param {(line:string)=>void} [log] optional logger for the parsed-to-empty warning (once).
 * @returns {Set<string>} normalized active sources (always non-empty).
 */
export function activeSources(log) {
  const env = process.env.JOBPILOT_APPLY_SOURCES;
  const profileVal = getProfile().preferences?.applySources;
  const { sources, emptyInput } = parseApplySources(env, profileVal);
  if (emptyInput && !warnedEmpty) {
    warnedEmpty = true;
    if (typeof log === 'function') log(`apply sources input parsed to empty (unknown tokens) — defaulting to all: ${sources.join(', ')}`);
  }
  return new Set(sources);
}
```

- [ ] **Step 1:** Create `src/apply-sources.js` with the content above (keep comments concise,
      match project ESM + comment style).

- [ ] **Step 2:** Verify the module imports cleanly.
      Run: `node -e "import('./src/apply-sources.js').then(m=>console.log(typeof m.parseApplySources, typeof m.activeSources, m.ALL_SOURCES.join(',')))"`
      Expected: `function function linkedin,indeed,glassdoor`

---

## Task 2: Unit test the pure parser (`scripts/test-apply-sources.mjs`)

**Files:**
- Create: `scripts/test-apply-sources.mjs`
- Modify: `package.json` (add `"test:apply-sources": "node scripts/test-apply-sources.mjs"` to `scripts`)

Mirror the PASS/FAIL + `process.exit` convention of `scripts/test-exclusions.mjs`. Cover the
normalization rules on `parseApplySources` ONLY (pure — no env/profile I/O, no browser).

```js
// scripts/test-apply-sources.mjs — pure parser tests for apply-source toggles.
import { parseApplySources, ALL_SOURCES } from '../src/apply-sources.js';

let fail = 0;
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fail++; };

const all = [...ALL_SOURCES];

// Default: both empty → all three
check('both empty → all', eq(parseApplySources(undefined, undefined).sources, all));
check('empty string → all', eq(parseApplySources('', '').sources, all));
check('empty array profile → all', eq(parseApplySources(undefined, []).sources, all));

// Env precedence over profile
check('env wins over profile', eq(parseApplySources('indeed', ['linkedin']).sources, ['indeed']));
check('profile used when env absent', eq(parseApplySources(undefined, ['indeed','glassdoor']).sources, ['indeed','glassdoor']));

// Case-insensitive + whitespace + comma string
check('case-insensitive + spaces', eq(parseApplySources(' LinkedIn , INDEED ', undefined).sources, ['linkedin','indeed']));

// all / * aliases
check('all alias', eq(parseApplySources('all', undefined).sources, all));
check('star alias', eq(parseApplySources('*', undefined).sources, all));
check('all in array', eq(parseApplySources(['glassdoor','all'], undefined).sources, all));

// Unknown tokens ignored (mixed)
check('unknown mixed ignored', eq(parseApplySources('indeed,facebook', undefined).sources, ['indeed']));

// Non-empty but all-unknown → all + emptyInput flag
const empt = parseApplySources('foo,bar', undefined);
check('all-unknown → all (never disable)', eq(empt.sources, all));
check('all-unknown → emptyInput flagged', empt.emptyInput === true);

// Array profile value supported
check('array profile subset', eq(parseApplySources(undefined, ['Linkedin']).sources, ['linkedin']));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
```

- [ ] **Step 1:** Create `scripts/test-apply-sources.mjs` with the content above.

- [ ] **Step 2:** Add the npm script. In `package.json` `scripts`, after `"test:cv"`, add:
      `"test:apply-sources": "node scripts/test-apply-sources.mjs",`

- [ ] **Step 3:** Run the test and confirm all cases pass.
      Run: `npm run test:apply-sources`
      Expected: a `PASS - …` line per case and a final `ALL PASS`; exit code 0.

---

## Task 3: Gate the board channels in `src/worker.js`

**Files:**
- Modify: `src/worker.js` (import; applier lane ~419–428; scout lane ~278–338; boot log ~708)

All gating reads `activeSources()` **inside the loop iteration** (live, not boot-cached) so a
`set_profile` change is honored on the NEXT iteration.

- [ ] **Step 1: Import the resolver.** Add to the import group near the other `./…` imports (e.g.
      after the `import { getEasyApplyLimit, maybeRefreshEasyApplyLimit } from './limits.js';` line):

```js
import { activeSources } from './apply-sources.js';
```

- [ ] **Step 2: Gate the APPLIER lane channel selection.** In `applier()`, locate the block:

```js
    const slot = turn++ % 3;
    const wantEasy = slot === 0 && !liCooling && (!emailFirst || emailBacklog === 0);
    const wantIndeed = !wantEasy && (slot === 1 || (slot === 0 && liCooling));
```

Replace with (read the live set once per iteration, then AND each board flag with its toggle):

```js
    const slot = turn++ % 3;
    // Live board toggles (env JOBPILOT_APPLY_SOURCES → profile.preferences.applySources → all).
    // Read every iteration so a set_profile change takes effect on the NEXT loop. A disabled
    // board is simply never selected as the channel → it falls through to the next active channel
    // and ultimately to `form`; no busy-spin, and the Easy-Apply cooldown/limit vars are untouched.
    const active = activeSources(m => say('applier', m));
    const liOn = active.has('linkedin');
    const indeedOn = active.has('indeed');
    const wantEasy = liOn && slot === 0 && !liCooling && (!emailFirst || emailBacklog === 0);
    const wantIndeed = indeedOn && !wantEasy && (slot === 1 || (slot === 0 && liCooling));
```

Leave everything after (`chan = wantEasy ? … : wantIndeed ? … : 'form'`, `doEasy`, `doIndeed`, the
cap/cooldown branches) UNCHANGED. When LinkedIn is off, `wantEasy` is always false so the `doEasy`
branch and its `getEasyApplyLimit()`/cooldown logic simply never run; `liCooling`/`liCooldownUntil`
remain defined and harmless. When both LI and Indeed are off, `chan` is always `'form'`.

- [ ] **Step 3: Gate the SCOUT lane LI posts (step 1).** Wrap the LI-posts step so it only runs
      when `linkedin` is active. Compute the live set at the top of the `try` body (once per loop)
      so steps 1/3/4 share it:

      Immediately inside the scout `while (running()) { try {` block, before `const postQ = …`, add:

```js
      const active = activeSources(m => say('scout', m));
```

      Then change the LI-posts guard from:

```js
      if (!loginBackoff('LinkedIn')) {
```

      to:

```js
      if (active.has('linkedin') && !loginBackoff('LinkedIn')) {
```

- [ ] **Step 4: Gate the SCOUT Indeed PK discovery (step 3).** Wrap the Indeed listings step
      (`beat('scout', 'indeed:…')` region, ~314–321) so it only runs when `indeed` is active.
      Change the opening of that `try` block from:

```js
      try {
        const roles = getProfile().preferences?.roles || [];
        const iq = roles[i % Math.max(1, roles.length)] || 'AI Engineer';
        beat('scout', 'indeed: ' + iq);
```

      to:

```js
      // Glassdoor has no scout discovery step today (external/board-pages routed only); when one
      // is added it MUST be gated behind active.has('glassdoor'). Indeed PK discovery is gated here.
      if (active.has('indeed')) try {
        const roles = getProfile().preferences?.roles || [];
        const iq = roles[i % Math.max(1, roles.length)] || 'AI Engineer';
        beat('scout', 'indeed: ' + iq);
```

      (The existing `} catch (e) { say('scout', 'indeed err …'); }` stays as the matching catch of
      this `if (...) try { … }` statement — valid JS. Do not change the catch.)

- [ ] **Step 5: Gate the SCOUT LI jobs (step 4).** Change the step-4 guard from:

```js
      if (i % 2 === 0 && !loginBackoff('LinkedIn')) {
```

      to:

```js
      if (active.has('linkedin') && i % 2 === 0 && !loginBackoff('LinkedIn')) {
```

      Leave step 2 (HN + Boards web discovery) UNGATED — those feed email/form and must stay
      always-on.

- [ ] **Step 6: Boot log of resolved active sources.** Near the existing boot log
      (`say('main', 'worker start …')`, ~708), add one line AFTER it:

```js
say('main', `active apply sources: ${[...activeSources(m => say('main', m))].join(', ')}`);
```

      This prints e.g. `main: active apply sources: linkedin, indeed, glassdoor` at boot. It is a
      one-time snapshot FOR DISPLAY only — the lanes still re-resolve live each iteration.

- [ ] **Step 7: Verify the worker module loads and the boot log is correct (default = all).**
      Run a short, self-terminating boot in DRY + DATA-ONLY so no browser outreach happens, and
      confirm the active-sources line. (DATA_ONLY runs only scout+refresher; the applier edit is
      still exercised by Step 8's targeted check.)
      Run: `$env:DRY='1'; $env:WORKER_DATA_ONLY='1'; $env:WORKER_NO_EVOLVE='1'; $env:RUN_MS='4000'; node src/worker.js`
      Expected: process starts, prints `main: active apply sources: linkedin, indeed, glassdoor`
      (default = all three), runs the scout lane briefly, then exits cleanly at RUN_MS. No crash,
      no `uncaughtException`.

- [ ] **Step 8: Verify the subset env override resolves live.** Confirm the resolver honors an env
      subset without touching profile/data.
      Run: `$env:JOBPILOT_APPLY_SOURCES='indeed,glassdoor'; node -e "import('./src/apply-sources.js').then(m=>console.log([...m.activeSources()].join(',')))"`
      Expected: `indeed,glassdoor`
      Then clear it: `Remove-Item Env:JOBPILOT_APPLY_SOURCES` and re-run →
      Expected: `linkedin,indeed,glassdoor`

---

## Task 4: Confirm `set_profile` persists `preferences.applySources` (verify-only, no code change)

**Files:**
- None (confirmation only). If this verify FAILS, revisit `src/profile.js` `updateProfile`
  preferences merge — but exploration shows it already shallow-merges, so expect PASS.

- [ ] **Step 1:** Confirm the profile knob round-trips through the same code path `set_profile`
      uses (`updateProfile` → `getProfile`), then restore the profile so no data is left mutated.
      This writes `data/profile.json` transiently; capture-and-restore avoids leaving test state.
      Run:
```
node -e "import('./src/profile.js').then(({getProfile,updateProfile})=>{const before=JSON.parse(JSON.stringify(getProfile().preferences||{}));updateProfile({preferences:{applySources:['indeed','glassdoor']}});const got=getProfile().preferences.applySources;const roles=getProfile().preferences.roles;console.log('applySources=',JSON.stringify(got),'rolesPreserved=',Array.isArray(roles));updateProfile({preferences:{applySources:before.applySources}});process.exit(JSON.stringify(got)==='[\"indeed\",\"glassdoor\"]'?0:1);})"
```
      Expected: `applySources= ["indeed","glassdoor"] rolesPreserved= true`, exit code 0. This proves
      the knob persists via the existing shallow-merge and that other preference keys survive. (Note
      in the final summary: no change to `profile.js` or the `set_profile` schema was needed.)

---

## Task 5: Full regression sanity + commit

**Files:**
- None new.

- [ ] **Step 1: Re-run the existing related tests** to confirm no regression from the new module/import.
      Run: `npm run test:apply-sources`  → Expected: `ALL PASS`, exit 0.
      Run: `node scripts/test-exclusions.mjs` → Expected: `ALL PASS`, exit 0 (profile.js untouched).
      Run: `node scripts/test-board-pages.mjs` → Expected: `ok 19`, exit 0 (board routing untouched).

- [ ] **Step 2: Confirm the security gate still passes** (no forbidden paths staged).
      Stage only the intended files first:
      `git add src/apply-sources.js scripts/test-apply-sources.mjs src/worker.js package.json`
      Run: `node scripts/ci-security-scan.mjs`
      Expected: `✅ Security gate passed`. If it reports any `data/`, `.env`, `*.db`, or
      `profile.json` path, UNSTAGE it — those must never be committed.

- [ ] **Step 3: Commit locally** (do NOT push).
```
git commit -m "feat(worker): configurable apply/discovery boards (linkedin/indeed/glassdoor)"
```

---

## Self-review checklist (run after implementing)

1. **Default = all three, zero regression.** No env, no profile knob → `activeSources()` returns
   `{linkedin,indeed,glassdoor}`; applier rotation and scout steps behave exactly as before.
2. **Live resolution.** `activeSources()` is called INSIDE each lane's loop iteration (Task 3
   Steps 2–5), not cached at boot — a `set_profile` change is honored on the next iteration. The
   boot line (Step 6) is display-only.
3. **Precedence.** env `JOBPILOT_APPLY_SOURCES` > `profile.preferences.applySources` > default-all,
   enforced by `parseApplySources` fall-through order (Task 1 / Task 2 tests).
4. **Never silently disable everything.** Non-empty input with only unknown tokens → all enabled +
   one logged warning (`emptyInput` flag). Covered by Task 2 tests and the applier/scout log hooks.
5. **Scope tight.** Only `linkedin`/`indeed`/`glassdoor` board branches gated. `form`, `email`,
   `connect`, and HN/boards/web discovery are untouched. No new deps. ESM throughout.
6. **No forbidden writes.** Only `src/apply-sources.js`, `scripts/test-apply-sources.mjs`,
   `src/worker.js`, `package.json` change. Nothing under `data/`, `.env*`, `uploads/` is staged
   (CI gate Task 5 Step 2). Task 4's transient profile write is captured-and-restored.

## Files changed (summary)
- **Create** `src/apply-sources.js` — pure `parseApplySources` + live `activeSources`.
- **Create** `scripts/test-apply-sources.mjs` — pure parser unit test.
- **Modify** `src/worker.js` — import resolver; gate applier `easy_apply`/`indeed_easy`; gate scout
  LI posts/jobs + Indeed PK; boot log of active sources; Glassdoor-scout guard comment.
- **Modify** `package.json` — add `test:apply-sources` script.
- **No change** to `src/profile.js` or the `mcp-server.js` `set_profile` schema (verified they
  already pass `preferences.applySources` through — Task 4).
