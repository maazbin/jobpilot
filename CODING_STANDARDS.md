# JobPilot — Coding Standards

These conventions apply to every file under `src/`. Follow them when adding features,
fixing encounters, or contributing improvements back to the repo.

---

## 1. Module system

- **ESM only** — `import`/`export`, never `require()`.
- Every file has a short comment block at the top (see §4).
- Use named exports. Default exports only for one-thing modules.

## 2. File header comment

Every source file starts with a header that states its purpose and key design decisions:

```js
// src/<path>/<name>.js — one-line purpose.
//
// Key design decisions / non-obvious things about this file.
// Any important invariants (e.g. "never touches the DB directly").
```

`src/dashboard/` partials additionally note which coordinator imports them.

## 3. JSDoc on every exported function

```js
/**
 * Brief description.
 * @param {Type} name - description
 * @returns {Type}
 */
export function myFn(name) { … }
```

Private helpers don't need JSDoc but should have a one-line comment if non-obvious.

## 4. Personal data rules (hard)

- **Nothing about the user lives in source code.** Profile, CV path, salary, answers —
  all read from `data/profile.json` via `src/profile.js`.
- No hardcoded email addresses, names, API keys, or credentials anywhere in `src/`.
- The auto-contributor's `DENY` list enforces this at commit time.

## 5. Error handling

- Async functions that touch the browser or network catch their own errors and
  record them via `encounter()` rather than letting them propagate uncaught.
- Never `throw` across lane boundaries — return `{ ok: false, reason }` instead.
- `encounter()` is fire-and-forget; callers don't await it.
- `attemptSelfHeal()` is also fire-and-forget — never block the lane on healing.

## 6. Dashboard partials

- Each partial (`src/dashboard/partials/*.js`) exports one or more pure functions
  that take plain data objects and return HTML strings.
- **No DB access, no profile reads inside partials.** All data comes from
  `src/dashboard/index.js` (the coordinator).
- CSS lives in `src/dashboard/styles.js` — edit there, not inline in partials.
- Client-side JS lives in `src/dashboard/partials/clientscripts.js` only.

## 7. Evolution memory

- Call `encounter(area, detail, { url, page })` when the agent gets stuck.
  The fire-and-forget `attemptSelfHeal()` will try lightweight fixes automatically.
- Call `askLater(question, options)` **only** when `textAnswer()` and `choiceAnswer()`
  both return `null` for a required field.
- Call `recordAgentAnswer(question, answer, basis)` when the agent fills a field
  from profile context so the user can see and review it on the dashboard.
- Fuzzy threshold for "same question" is **0.75** — changing it affects how many
  duplicates appear on the dashboard.

## 8. Contribution loop

- `contributeRound()` always **syncs upstream first** (pulls new version) before staging.
- **Fork**  → `contributeViaPR()` opens a cross-fork PR to upstream.
- **Main**  → `reviewAndMergePRs()` reviews and merges open `self-evolve`-labelled PRs
  whose CI has passed, then syncs local branch.
- The `safeStage()` guard aborts if any DENY-listed path is staged. Never bypass it.

## 9. Pacing / politeness

- Every browser action is followed by a jittered sleep (`PACE` in `worker.js`).
- Daily caps and per-job attempt limits are enforced in `worker.js` and `tracker.js`.
- `learnedSkip()` auto-skips domains that failed ≥4 times with zero wins.

## 10. Adding a new dashboard section

1. Create `src/dashboard/partials/<name>.js` with pure render functions.
2. Import + call it in `src/dashboard/index.js`.
3. Add any new CSS to `src/dashboard/styles.js`.
4. Add any new client JS to `src/dashboard/partials/clientscripts.js`.
5. Do **not** modify `src/dashboard.js` (it is a thin re-export shim).

## 11. Adding a new ATS adapter

1. Add a handler in `src/mcp/forms.js` matching the ATS hostname.
2. Record failures with `encounter('form', detail, { url, page })`.
3. Write a test URL in `scripts/` and verify the CI boot-smoke test still passes.

---

*Last updated automatically — edit this file and open a PR if a convention changes.*
