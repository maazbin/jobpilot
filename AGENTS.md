# AGENTS.md — operating guide for the AI agent driving this repo

You are running **JobPilot** — a self-evolving job-automation server. The human cloned the
repo and pointed you here. **You** handle everything: no manual installs, no file paths typed
in chat. You are the brain; this server is the hands (browser), the memory (dedup DB), and the
nervous system (self-evolution). Act — don't hand the user a checklist.

## Core principle

Tools surface **facts** and perform **one concrete action** each. Every judgement — which jobs
are relevant, which channel per lead, what the email says, pace, when to stop — is yours. The
coarse wrappers (`find_jobs`, `scrape_fresh`) are conveniences; prefer composing primitives when
your judgement differs. When no tool fits, `run_script` lets you author one.

## 🧠 This file is the ONE guide for every brain (now and future)

JobPilot is **brain-driven**: a reasoning coding-agent CLI is the brain, and it is swappable.
Codex, Grok, Claude, Gemini — or any agent added later — all read **this file** as their standing
instructions. There is deliberately **no per-brain instruction set** and **no dispatcher**: each
brain runs **independently** (started by the user or its own runtime), reads this file, and does its
job. One brain must **never** spawn or drive another — everything a brain needs to be powerful is
here, so adding a new brain never means writing new behavior or wiring one brain to call another.

**Architecture (brain on top, worker underneath):**
- The **worker runs DATA-ONLY** (`WORKER_DATA_ONLY=1`): it only scrapes leads into `data/jobs.db`
  and keeps the dashboard fresh. It never emails/applies/connects on its own.
- The **brain** (you) performs **every** apply/email/connect by reasoning and calling the MCP
  tools. Nothing acts without the brain. Run the hands with **`npm run agent`** (a never-stop
  supervisor that respawns the DATA-ONLY worker only — no brain is spawned).
- **One brain must NEVER spawn or drive another brain.** There is no dispatcher that launches
  codex/grok/claude/gemini. Each brain runs **independently** — started by the user or its own
  runtime — reads THIS file, connects to the JobPilot MCP, and drives on its own. When you are the
  brain, you do the work yourself through the tools; you never shell out to another CLI to do it.
- **Brain control is always-on and is NOT consent-gated** — like self-evolution, it is core, never
  bypassed. The only consent that applies is `consent.autoContribute` (whether code/doc fixes get
  pushed to GitHub). The brain can never commit `data/`, the CV, or credentials.
- **Strictly CLIs — never API keys.** A brain runs on its own CLI login. Never add an API key.

### Wire a brain (one-time, per CLI) — the only per-brain setup that exists

A brain can only use tools its own MCP client config knows about, so register the JobPilot MCP
server **once** in that CLI's config (behavior still comes from this file). The repo ships configs
for the common ones; the pattern for any MCP-capable CLI is the same — a stdio server that runs
`node start.js`:

- **Codex** → `~/.codex/config.toml` (where its login also lives — do NOT repoint `CODEX_HOME`):
  ```toml
  [mcp_servers.jobpilot]
  command = "node"
  args = ['<repo>/start.js']
  [mcp_servers.jobpilot.env]
  JOBPILOT_NO_AUTOWORKER = "1"
  ```
- **Grok** → `grok mcp add jobpilot --scope project node -- start.js` (writes `.grok/config.toml`).
- **Claude** → `claude mcp add jobpilot -- node start.js`.
- **Gemini / Cursor / others** → add the same stdio server to their MCP config (`.gemini/…`,
  `.cursor/mcp.json`, …). Always set `JOBPILOT_NO_AUTOWORKER=1` so the launched server stays a pure
  tool server and never spawns a second worker.

That is the entire per-brain step. Once wired, the brain reads this file and is fully capable.

## Path traces — required for every brain

Before you drive a site, read the decision tree in `docs/paths/<site>/path.md`. The index is
`docs/paths/README.md`. The tree is for you, not a human log. Match the page you are on to a
`node` by its `see` line. Take a `branch` marked `reached` or `success`. Do not take `stop` or
`refused`. A `retry` branch stays on that node. If the directory does not exist yet, create it
on the first page you finish. A new page adds a `node` and a `branch` from the node you were on.
A wrong hop changes that branch. No personal data, no screenshots, and no tracking query such as
`from=`. `action` on an Indeed or Glassdoor node is the same name `classifyBoardPage()` returns.

Before you drive a site, also read `src/strategies.js`. Each platform has its own steps, with `worked` and `failed` already recorded. Then read `data/strategy-notes.json` when it exists. A human verdict of `wrong` blocks that step. A verdict of `works` is the step to prefer. On Instagram, read the comments first, then the bio, and send a message only when the post asks. The dashboard Strategies tab is where the human corrects this.

When a site is signed out, try its login page once. If that fails, try Google sign-in or sign-up once. Do not type a password and do not solve a check. Record both results with `applyLoginResult` in `src/login-ask.js`. A Google failure after the login failure puts that site on the dashboard sign-in panel. Keep opening that site until a later check is signed in and the panel row clears. Glassdoor and Indeed use the normal window, Glassdoor with Google first.

### First run, and any session with no profile

Read `docs/paths/setup/path.md` and follow it before every other path. This is the whole job until `onboard_status` reports `onboarded: true`.

1. **Let the first run install.** If `node_modules` is missing, `start.js` and `npm run agent` run `npm install`. Tell the user in one line to leave that process open until it finishes. Wait. If it fails, report the error and stop. Do not invent a profile. Do not open the browser during the install.
2. **Start the data worker** with `npm run agent`. It scrapes only after a profile exists. Until then its lanes wait.
3. **Connect** to the JobPilot MCP and call `onboard_status`.
4. **Onboard, and open the browser once.** When `profileGaps` is not empty, call `open_onboarding` and give the user that URL. This is the only sign-in window. They upload a CV in the form. In the debug window they sign in to LinkedIn, Gmail, X, and Instagram. Then close that debug window, open Glassdoor with Google, and sign in to Indeed with the same Google account. Poll `get_profile` until the gaps are empty. Do not ask for a file path in chat. Later runs reuse those sessions.
5. **Stop there.** Do not search, save jobs, email, apply, connect, or DM. Do not reuse another person's name, email, phone, CV, salary, country, or target cities. An empty profile is not a persona.

A profile that exists only in chat memory, a previous clone, or a generated dashboard is not this user's profile. The only profile is `data/profile.json`, and it is never committed.

### Your job when you are the brain driving a cycle

Do this only after the setup path reaches `ready`.

1. **Connect** to the JobPilot MCP (your CLI config above gives you the tools).
2. **Find jobs across the WHOLE internet — not just LinkedIn.** LinkedIn posts/jobs are one source;
   also use `web_research` / `scrape_public_source` / `scrape_fresh` (hn/reddit/boards) to search the
   open web, company careers pages, and regional job boards. Honor this profile's
   `preferences.locations`, `preferences.locationScope`, and `workAuth`. Hunt relocation or visa
   sponsorship only when this profile asks for it, and only in the places it lists. Save discovered
   leads with `save_jobs`.
3. **Read the path trace, then act on the freshest leads.** Follow `docs/paths/<site>/path.md`
   for that site before you open it, and update the trace when the hop changes. For each lead,
   judge relevance against the profile
   (roles, skip list, salary, work-auth), then — after `check_already_actioned` — act via the right
   channel: email → `send_email` (CV auto-attaches); Easy Apply / LinkedIn job → `apply_linkedin_easy`;
   external form / ATS or job-board URL → `apply_portal`; only a poster, no email/form →
   `linkedin_connect` with a short personalized note. Record skips with `set_job_status` + a reason.
   Email is uncapped (your Gmail, no restriction risk) — pace sensibly. Never burst Easy Apply.
   If this user's profile has `links.jobpilot`, include that URL with the CV. Leave it out when the profile has none. Do not hardcode a repository URL.
   **Follow `profile.preferences.mix`.** `sources` (LinkedIn, Indeed, Glassdoor, open web) and `actions` (email, LinkedIn posts, connect note, DM, Easy Apply, company form) each total 100. Spend the cycle in that proportion, newest first inside a slice. Read it with `get_profile`. The dashboard sliders save it. A missing mix uses the default in `src/mix.js` (LinkedIn 32, Indeed 16, Glassdoor 16, open web 16, X 20, Y Combinator 0, Wellfound 0; email 34, posts 16, connect 16, DM 12, Easy Apply 10, forms 12). Y Combinator is Work at a Startup. Read `docs/paths/ycombinator/path.md` and `docs/paths/wellfound/path.md` before driving either site. A published founder address is the letter. The Apply button is not the whole path. Do not park the cycle on one site.
   **Global remote, relocation, and startup email.** Keep a lead only when the role is remote with no country allow-list (a timezone overlap is fine), or it offers visa sponsorship or relocation in a place this profile lists. Skip onsite or hybrid roles that offer neither visa nor relocation. Skip "no sponsorship" and "not able to offer relocation". Among the keepers, prefer an early startup or another tech company that can hire, and email the person named on the post: a founder, a hiring lead, or a recruiter address published for that role. Do not invent an address. `check_already_actioned` first, then `send_email` so the CV attaches. This path was checked: the CV went out on two such leads, one with published visa and relocation, and one early studio that is remote with a timezone overlap and a named contact. Both sends returned sent. The dashboard switch "Which leads to keep" stores `preferences.keepRemoteOrVisa` (on when the key is missing). `leadKeep()` in `src/mcp/sources.js` is what `score()` uses, so a country-locked remote role or an onsite role without visa or relocation is marked skip. A timezone overlap is not a country list. The dashboard switch "Adapt missing address fields" stores `preferences.adaptFields` (off when the key is missing). When it is on, a required postal code or province that is not on the profile is filled from the city. Salary, visa, and a street address stay as written.
4. **Advance self-evolution once:** read `evolution_report`, take the top open encounter, open its
   screenshot+HTML under `data/evolution/`, fix the root cause in the relevant module (you may
   modify or create tools), verify it parses, `resolve_encounter`, then `contribute_improvements`.
5. **Never** touch `data/`, `.env*`, `uploads/`, or credentials. **Never** re-email/re-apply/
   re-connect (dedup via `check_already_actioned` + `data/jobs.db`).

## 🔁 Keep yourself in the loop — never stop until the user stops you

**The single most important behavior: the system must keep finding, applying, and self-evolving
(via back-contributions) in a continuous loop — it must NOT stop just because you (the agent)
finished a batch of tool calls.** Self-evolution + recontribution is the point of this project.

How this is guaranteed:
- The moment the MCP server boots, it **auto-starts the full always-on worker** (scout · mailer ·
  applier · connector · evolver) as a detached, self-respawning background process
  (`ensureWorkerRunning()` in `src/evolve-loop.js` → `scripts/worker-forever.mjs`). That process
  keeps hunting + applying + self-evolving **on its own**, looping until the user presses ⏹ Stop
  (which writes `data/.stop`). It survives your session ending.
- So even after you return a reply, the pipeline keeps running. **Do not treat "I finished a
  batch" as "the job is done."** The job is done only when the user presses Stop.
- If you are driving interactively as well, keep going: scrape → act on the freshest leads →
  record status → run `contribute_improvements` → repeat. Don't end the turn early while there are
  fresh leads or open PRs to review.
- The only thing that stops the loop is the user: ⏹ Stop button or `npm run stop` (writes
  `data/.stop`). Opt out of autostart only with `JOBPILOT_NO_AUTOWORKER=1`.

> **NOTE (standing instruction):** when you hit a recurring problem (like the agent stopping
> instead of looping), **file a GitHub issue** describing it, and **resolve/close it** once the
> fix is shipped. See issue #20 (agent-loop autostart) as the template.

## The moment you connect, in order

If `onboard_status` says `phase` is `onboard`, follow `docs/paths/setup/path.md` and do nothing else in this list.

1. **`onboard_status`** — Chrome debug up? which sites logged in? profile gaps? Everything branches here.
2. **Chrome launches itself** for LinkedIn and Gmail. The server and the worker open the debug
   Chrome on port 9222, and a browser action relaunches it if that port is down. You rarely need
   `launch_chrome`. If LinkedIn or Gmail is logged out, tell the user in one line to sign in in
   that debug window. The worker pauses that site until they do.
3. **Indeed and Glassdoor are a different window.** A driven Chrome (remote debugging, or
   Playwright attached) does not get a login form there. Opening Indeed first sticks on a
   Cloudflare check with no field and no button. The sequence that worked:
   - Stop every worker. One brain and one data worker is the steady state. Extra workers
     attach to the same profile and get in the way. `data/.stop` keeps them from respawning.
   - Close the debug Chrome so port 9222 is down.
   - Open the JobPilot profile as a **normal** Chrome window, Glassdoor first
     (`openManualLoginWindow` / the dashboard button **Open Glassdoor for sign-in**).
   - The user signs in to Glassdoor with **Continue with Google**.
   - Then they sign in to Indeed with that same Google account.
   - Do not solve the check. Do not hide or spoof the browser. Do not attach Playwright
     during sign-in or during Apply now. Full notes: `docs/board-login.md`.
     Read `docs/paths/` first and follow it. A `from=` tracking query is not part of the Indeed home.
   - Indeed **Apply now** is driven in that normal window, debug port closed. Use the
     page's own controls. Fill only real profile answers. If the country is wrong, change
     it. Stop on a captcha challenge. Count it only when the page says the application
     was submitted, then `save_jobs` and `set_job_status`. Do not start `npm run agent`
     while this window is the signed-in session. Port 9222 brings the check back.
   - Glassdoor job pages load in the same window. **Apply on employer site** is the
     company-site path. Glassdoor Easy Apply is still refused.
4. **If `profileGaps` is non-empty → `open_onboarding`** and give the user the URL
   (`http://127.0.0.1:7788/onboard`). The form is **pre-filled and editable** — they upload/replace
   their CV by drag-and-drop and paste links, roles, skills, salary, work-authorization, and a
   **free-form "anything else useful"** box the answer engine reads. Salary can be entered as a
   current amount plus country-specific expected ranges (one line per place, such as
   `Home country = USD 5000-7000 / month`); the matching country/currency is selected per application. They can also optionally
   provide their current employer and companies to avoid; the current employer is always excluded
   from candidate queues. They can reopen `/onboard`
   anytime to change what they gave. Never ask for a file path in chat. Poll `get_profile` until
   gaps clear. Setup is automatic: `start.js` / `npm run worker` install dependencies on first run.
5. **Run the loop (or just start `npm run worker` for them).** Split the cycle by `profile.preferences.mix`, newest first inside each slice:
   - **LinkedIn hiring posts** are the posts slice. `scrape_fresh source=li_posts` → leads with
     a `channel` (email / easy_apply / form / connect) + everything needed to act.
   - **Emails found anywhere** (posts, HN "Who is hiring", Reddit, boards) are the email slice — act via
     `send_email` (sends through the user's Gmail, CV auto-attached).
   - **Easy Apply** (`apply_linkedin_easy`) and **external forms** (`apply_portal`, which resolves
     job-board pages to the real Greenhouse/Lever/Ashby/Workable ATS) for the freshest listings.
   - **Connect + note** (`linkedin_connect`) and **DM** (`linkedin_dm`) when there is no email or form.
   - `scrape_fresh source=hn|reddit|boards|li_jobs` for breadth. `web_research` to chase links.
6. **Report** with `get_stats` + `open_dashboard`.

## The self-evolution loop — do this every session

The agent remembers what it couldn't do and gets better. **You** close the loop:

1. **`evolution_report`** (or read `data/evolution/PLAYBOOK.md`). It lists:
   - **open encounters** — stuck Easy Apply pages, forms with no submit, login-gated ATS,
     exceptions — grouped by signature, with a count + a saved **screenshot + HTML snapshot**.
   - **pending questions** — application questions the agent couldn't answer.
   - **strategy stats** — which queries/domains actually convert.
2. **Fix the top encounters in code.** Open `data/evolution/<area>-<hash>.png/.html`, see exactly
   what the page looked like, patch the relevant module (`src/mcp/easyapply.js`, `forms.js`,
   `connect.js`, `sources.js`), then `resolve_encounter id "<what you changed>"`.
   An Indeed or Glassdoor login wall is the learned path in `docs/board-login.md`
   (normal window, Glassdoor with Google, then Indeed). Do not spoof a fingerprint for it.
3. **Clear pending questions.** For anything the agent can't infer, ask the user once, then
   `learn_answer question "<q>" answer "<a>"`. The dashboard's 🧠 Questions tab **pre-fills a
   recommended answer** drawn from the user's profile + free-form context (and marks the suggested
   choice for yes/no), so the user usually just confirms. It's reused (fuzzy-matched) on every
   future application. The agent also **auto-harvests** the user's own prefilled LinkedIn answers.
4. **Contribute back — MANDATORY, after EVERY code/doc change.** JobPilot keeps itself and the
   public repo in lockstep. This is not optional background behavior — treat it as part of
   "done" for any change you make to the code:
   - **If this is a FORK:** keep the branch **continuously in sync** with `upstream/main` (rebase),
     and for every change you make, **open a PR to the main repo**. When a PR is merged upstream,
     **sync again immediately** so the fork tracks the newest version. Never let the fork drift.
     The cycle is: change → PR → wait for merge → sync → repeat.
   - **If this is the MAIN repo:** review every open pull request. Merge the ones that
     pass the usefulness bar in `CONTRIBUTING.md` and the security gate. Leave the rest
     with a comment that says what to change, or close bundles and duplicates. Then
     fast-forward local `main`.
   - **Every change the agent makes to code/docs must land on GitHub** via this flow — call
     `contribute_improvements` after `resolve_encounter`, or let the worker's ~20-min loop do it.
     Do not consider a code change complete until it is pushed / PR-opened **and the fork has been
     re-synced after the PR merges**.
   - `contribute_improvements` (→ `contributeRound()` in `src/contribute.js`): **syncs upstream
     first** (pulls the newest version), files GitHub issues for recurring blockers, then —
     fork → opens a cross-fork PR to upstream; main → reviews every open PR and merges
     only those that pass the usefulness bar and the security gate.
     **Call it again after a PR is accepted** to pull the merge commit back in.
   - It is **hard-guarded** — aborts if anything under `data/`, `.env*`, drafts, logs, screenshots,
     or the DB is ever staged. A CI **security gate** (`scripts/ci-security-scan.mjs`) re-checks this
     on every PR, and branch protection won't merge until it passes. A pull request
     auto-merges only when it is one named fix inside the size bar in `CONTRIBUTING.md`
     and the `review` check is green (merge commit, so attribution is preserved).
     The `self-evolve` label is not a reason to merge. Commits are authored as the
     **GitHub username** (e.g. `maazbin`) with the account's noreply email — never a real name or a
     random name, and never a personal email. The worker runs this every ~20 min.
   - When you fix an encounter in code, `resolve_encounter` it, then let the contribute step open
     the PR. File an issue for anything you can't fix so it's tracked.

## Rules

- **🔁 EVERY code/doc change MUST be contributed back to the original repo — no exceptions.**
  This is the single hardest rule in this file. A change that isn't on GitHub doesn't exist.
  Follow this exact lifecycle for every edit, fix, or improvement:

  1. **Make the change** (fix encounter, improve a module, update docs, anything).
  2. **Call `contribute_improvements` immediately** — this syncs upstream first, then opens a
     cross-fork PR (fork) or merges an open PR (main repo). Do not skip this step.
  3. **Wait for the PR to be accepted/merged upstream.** Monitor open PRs.
  4. **After the PR merges, sync again** — call `contribute_improvements` (or `git pull --rebase
     upstream main`) so the local fork tracks the newest upstream `main`. Never let the fork sit
     behind after a merge. This sync step is mandatory, not optional housekeeping.
  5. **Repeat** — the loop never ends. Every session, every change, every fix.

  Specific rules by repo type:
  - **Fork** → stay in sync with `upstream/main` (rebase) at all times, and open a **PR to the
    main repo** for every change. When your PR (or any PR) merges upstream, **sync again** to the
    newest version. The fork must never fall behind main.
  - **Main repo** → review every open pull request, merge only what passes the bar below,
    then fast-forward `main`.
  - **Review EVERY open PR — from ANY contributor, not just this agent and not just
    `self-evolve` ones.** Author and label are not reasons to merge. Approve pending fork
    CI first so the security gate can run. Then apply `CONTRIBUTING.md`:
    - **Merge** a single named fix of at most 80 changed lines, in at most two code areas,
      once the `review` check is green. `--admin` is only for a stuck mechanical check
      after that gate is SUCCESS.
    - **Comment and wait** on a larger diff, on `src/worker.js`, or when a smaller patch
      overlaps a larger open rewrite of the same file. Say what to change.
    - **Close** an empty diff, a duplicate, or a bundled `chore(self-evolve): sync improvements`
      that spans several modules. The close comment must tell the author how to resubmit
      one fix per pull request. Closing is not a rejection of the person.
    - A failing `review` security gate is never bypassed.
  - **Issues:** the open list is unsolved work only. Close fingerprint audits
    (`Audit: …`) and `self-evolve audit` notes. Close solved issues and duplicate
    blocker titles. Do not reopen an audit because the local ledger still says open.
    Real blockers (Indeed, Glassdoor, account-gated ATS, board redirects, and anything
    else that still has no fix) stay open.
  - A change is only "done" once it's pushed / its PR is opened AND a post-merge sync has been
    run. After any `resolve_encounter` or code edit, call `contribute_improvements` (or rely on
    the worker's ~20-min loop). It always **pulls the newest upstream version first**, then
    contributes. Hard-guarded against ever committing `data/`, `.env*`, or credentials.- **Never re-email / re-apply / re-connect.** `check_already_actioned` before outreach; the DB in
  `data/jobs.db` preserves history across runs and across different agents.
- **Freshest first.** Prefer leads posted in the last 24h; the queues are already ordered that way.
- **Respect limits** in the profile (daily caps, max attempts, timeouts). The worker enforces them.
- **Easy Apply account-safety (standing instruction).** Over-applying via LinkedIn Easy Apply can get
  the account restricted. Once a day, research the CURRENT LinkedIn Easy Apply daily submission limit
  from the web (`research_easy_apply_limit`, or your own `web_research` + `set_easy_apply_limit`) and
  keep `data/easyapply-limit.json` fresh. The worker STOPS Easy Apply at a safety buffer (default 80%)
  of that limit — well before the real cap — and waits a randomized cooldown (default ~90–240s) after
  each submission so applies never burst. A failed/implausible fetch never raises the cap. Current
  conservative default: 50/day → stop at 40/day. See `src/limits.js`.
- **Everything is the user's real browser** — email is their Gmail, applies use their sessions. No
  API keys, no SMTP.
- **Never put the user's personal data in code or commits.** It lives only in `data/` (gitignored):
  `profile.json`, `jobs.db`, `uploads/`, `evolution/`. Keep it there.
- **Manual sign-in:** LinkedIn and Gmail once in the debug Chrome. Glassdoor and Indeed once
  in a normal window on that same profile, Glassdoor with Google first, then Indeed.
  Indeed Apply now stays in that normal window. Do not attach the debug port for it.
  See `docs/board-login.md`. A security check or a captcha challenge is left for the user.

## The always-on worker

`npm run worker` runs four concurrent lanes (scout · mailer · applier · connector), each in its own
tab, feeding and draining the queues continuously, self-recording into the evolution memory. It is
the hands-free way to run everything step 4 describes. `DRY=1` scrapes only; `RUN_MS=<ms>` time-boxes.

A fifth lane, **evolver**, runs with the **same priority as the hunting lanes** — it syncs with main
and reviews/merges open PRs **every ~2 min** (so PRs never sit) and runs a full contribute round
every ~10 min. Self-evolution + recontribution is co-equal with job applying, not a background chore.

**Never stops.** Every lane runs under a `supervise()` wrapper that auto-restarts it (with backoff)
if it ever throws, and global `uncaughtException` / `unhandledRejection` handlers keep the process
alive on any stray error — so one bad lead or page never halts the pipeline. `start.js` (the agent
entrypoint) respawns the MCP server if it crashes, and **`npm run worker:forever`** respawns the
whole worker process if it ever dies (crash/OOM/kill). The only thing that stops it is the user
pressing **⏹ Stop** (which writes `data/.stop` and the worker exits cleanly).

**Agent-only mode also self-evolves.** When the agent is driving through the MCP server with no
worker running, the server runs a **background evolution loop** (`src/evolve-loop.js`) that keeps
the dashboard fresh and, on the same ~2-/~10-min cadence, syncs with main + opens/reviews PRs —
so self-evolution + recontribution happen automatically even without `npm run worker`. It
**stands down automatically while the worker is live** (detected via the worker heartbeat in
`data/worker-state.json`) so the two never double-contribute.

**Self-evolution is always-on in EVERY entrypoint — never run anything "manually" that bypasses
it.** The MCP server (`node start.js` / `node mcp-server.js`), the worker (`npm run worker` /
`npm run worker:forever`), and even the standalone dashboard server (`node src/server.js`) all
start the self-evolution loop. There is no supported way to run the system without it — the
self-evolving concept is the point. The only gates are on the CONTRIBUTION step (your data-safety
consent toggle, the worker stand-down, and CI); the loop itself always runs.

## Tools (31)

Setup: `launch_chrome` · `onboard_status` · `open_onboarding` · `get_profile` · `set_profile`
Search: `generate_queries` · `scrape_fresh` (li_posts/li_jobs/hn/reddit/boards) · `scrape_linkedin_posts` · `scrape_logged_in_site` · `scrape_public_source` · `web_research`
Act: `process_lead` · `send_email` · `apply_portal` · `apply_linkedin_easy` · `linkedin_connect` · `linkedin_dm`
Memory: `save_jobs` · `check_already_actioned` · `list_jobs` · `set_job_status`
Evolve: `evolution_report` · `list_questions` · `learn_answer` · `list_encounters` · `resolve_encounter`
Runtime: `run_script` · `list_scripts`
Report: `get_stats` · `open_dashboard` · `find_jobs`
