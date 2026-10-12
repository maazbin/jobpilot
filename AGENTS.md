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

## The moment you connect, in order

1. **`onboard_status`** — Chrome debug up? which sites logged in? profile gaps? Everything branches here.
2. **Chrome launches itself.** The server (and the always-on worker) auto-launch the debug Chrome
   on boot, and any browser action self-heals by relaunching Chrome if the port is down — you do
   **not** need to ask the user to start Chrome, and you rarely need `launch_chrome` (it exists only
   as a manual override). After it's up, if **LinkedIn** or **Gmail** isn't logged in, tell the user
   in ONE line to log into them in that window; the worker shows a one-click "log in" banner and
   **pauses that site (backing off) instead of retrying in a loop** until the user is back in.
3. **If `profileGaps` is non-empty → `open_onboarding`** and give the user the URL
   (`http://127.0.0.1:7788/onboard`). The form is **pre-filled and editable** — they upload/replace
   their CV by drag-and-drop and paste links, roles, skills, salary, work-authorization, and a
   **free-form "anything else useful"** box the answer engine reads. They can reopen `/onboard`
   anytime to change what they gave. Never ask for a file path in chat. Poll `get_profile` until
   gaps clear. Setup is automatic: `start.js` / `npm run worker` install dependencies on first run.
4. **Run the loop (or just start `npm run worker` for them).** Priority order, newest-posted first:
   - **LinkedIn hiring posts** are the primary source. `scrape_fresh source=li_posts` → leads with
     a `channel` (email / easy_apply / form / connect) + everything needed to act.
   - **Emails found anywhere** (posts, HN "Who is hiring", Reddit, boards) are top priority — act via
     `send_email` (sends through the user's Gmail, CV auto-attached).
   - **Easy Apply** (`apply_linkedin_easy`) and **external forms** (`apply_portal`, which resolves
     job-board pages to the real Greenhouse/Lever/Ashby/Workable ATS) for the freshest listings.
   - **Connect + note** (`linkedin_connect`) to the poster when there's no email/form.
   - `scrape_fresh source=hn|reddit|boards|li_jobs` for breadth. `web_research` to chase links.
5. **Report** with `get_stats` + `open_dashboard`.

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
     **sync again** so the fork tracks the newest version. Never let the fork drift.
   - **If this is the MAIN repo:** keep **reviewing and merging open `self-evolve` PRs** that have
     passed CI, then fast-forward local `main`. Do this on a loop — new PRs should not sit unmerged.
   - **Every change the agent makes to code/docs must land on GitHub** via this flow — call
     `contribute_improvements` after `resolve_encounter`, or let the worker's ~20-min loop do it.
     Do not consider a code change complete until it is pushed / PR-opened.
   - `contribute_improvements` (→ `contributeRound()` in `src/contribute.js`): **syncs upstream
     first** (pulls the newest version), files GitHub issues for recurring blockers, then —
     fork → opens a cross-fork PR to upstream; main → reviews + merges open self-evolve PRs.
   - It is **hard-guarded** — aborts if anything under `data/`, `.env*`, drafts, logs, screenshots,
     or the DB is ever staged. A CI **security gate** (`scripts/ci-security-scan.mjs`) re-checks this
     on every PR, and branch protection won't merge until it passes. Clean `self-evolve` PRs
     auto-merge. Commits are attributed to the repo owner. The worker runs this every ~20 min.
   - When you fix an encounter in code, `resolve_encounter` it, then let the contribute step open
     the PR. File an issue for anything you can't fix so it's tracked.

## Rules

- **🔁 EVERY code/doc change MUST be reflected on GitHub — no exceptions.** This is a hard rule,
  not a nice-to-have:
  - **Fork** → stay in sync with `upstream/main` (rebase) at all times, and open a **PR to the
    main repo** for every change. When your PR (or any PR) merges upstream, **sync again** to the
    newest version. The fork must never fall behind main.
  - **Main repo** → continuously **review and merge** open `self-evolve` PRs that passed CI, then
    fast-forward `main`. Don't let PRs pile up.
  - A change is only "done" once it's pushed / its PR is opened. After any `resolve_encounter` or
    code edit, call `contribute_improvements` (or rely on the worker's ~20-min loop). It always
    **pulls the newest upstream version first**, then contributes. Hard-guarded against ever
    committing `data/`, `.env*`, or credentials.
- **Never re-email / re-apply / re-connect.** `check_already_actioned` before outreach; the DB in
  `data/jobs.db` preserves history across runs and across different agents.
- **Freshest first.** Prefer leads posted in the last 24h; the queues are already ordered that way.
- **Respect limits** in the profile (daily caps, max attempts, timeouts). The worker enforces them.
- **Everything is the user's real browser** — email is their Gmail, applies use their sessions. No
  API keys, no SMTP.
- **Never put the user's personal data in code or commits.** It lives only in `data/` (gitignored):
  `profile.json`, `jobs.db`, `uploads/`, `evolution/`. Keep it there.
- **One manual step, at most:** the user logging into LinkedIn + Gmail once in the debug Chrome.

## The always-on worker

`npm run worker` runs four concurrent lanes (scout · mailer · applier · connector), each in its own
tab, feeding and draining the queues continuously, self-recording into the evolution memory. It is
the hands-free way to run everything step 4 describes. `DRY=1` scrapes only; `RUN_MS=<ms>` time-boxes.

## Tools (31)

Setup: `launch_chrome` · `onboard_status` · `open_onboarding` · `get_profile` · `set_profile`
Search: `generate_queries` · `scrape_fresh` (li_posts/li_jobs/hn/reddit/boards) · `scrape_linkedin_posts` · `scrape_logged_in_site` · `scrape_public_source` · `web_research`
Act: `process_lead` · `send_email` · `apply_portal` · `apply_linkedin_easy` · `linkedin_connect` · `linkedin_dm`
Memory: `save_jobs` · `check_already_actioned` · `list_jobs` · `set_job_status`
Evolve: `evolution_report` · `list_questions` · `learn_answer` · `list_encounters` · `resolve_encounter`
Runtime: `run_script` · `list_scripts`
Report: `get_stats` · `open_dashboard` · `find_jobs`
