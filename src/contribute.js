// src/contribute.js — the "self-improving repository" loop.
//
// Flow:
//   Fork  →  sync with upstream/main (rebase)  →  open a PR to upstream
//   Main  →  ff-merge origin/main              →  review + merge open self-evolve PRs
//
// Hard-guarded:
//   • Only allowlisted paths (src/, docs/, scripts/, *.md, mcp-server.js, etc.) may be staged.
//   • A DENY list aborts immediately if data/, .env*, drafts/, applied/, logs/, screenshots,
//     or the DB ever appear in the index.
//   • The CI security gate (scripts/ci-security-scan.mjs) re-checks on every PR.
//   • Commits are attributed to the repo owner; no personal email is ever committed.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { ROOT, DATA } from './config.js';
import { openEncounters } from './evolve.js';

const run = promisify(execFile);
const git = (...a) => run('git', a, { cwd: ROOT }).then(r => r.stdout.trim())
  .catch(e => { throw new Error((e.stderr || e.stdout || e.message).slice(0, 300)); });
const gh  = (...a) => run('gh',  a, { cwd: ROOT }).then(r => r.stdout.trim());

// ── Author identity ─────────────────────────────────────────────────────────
// Commits are attributed to the GitHub USERNAME (e.g. "maazbin"), NOT a real name or a
// random name, using the account's noreply email so no personal email is ever committed.
let _ident = null;
/**
 * Resolve the commit identity from the authenticated GitHub account.
 * Returns { name: <login>, email: <id>+<login>@users.noreply.github.com }.
 * Cached for the process. Falls back to the local git user if gh is unavailable.
 * @returns {Promise<{name:string, email:string}>}
 */
async function ghIdentity() {
  if (_ident) return _ident;
  try {
    const login = await gh('api', 'user', '--jq', '.login');
    const id    = await gh('api', 'user', '--jq', '.id');
    _ident = { name: login, email: `${id}+${login}@users.noreply.github.com` };
  } catch {
    const name  = await git('config', 'user.name').catch(() => 'jobpilot');
    const email = await git('config', 'user.email').catch(() => 'jobpilot@users.noreply.github.com');
    _ident = { name, email };
  }
  return _ident;
}

/**
 * Commit staged changes authored AND committed as the GitHub username (via -c overrides),
 * so attribution is the actual username regardless of local/global git config.
 * @param {string} message
 */
async function commitAs(message) {
  const id = await ghIdentity();
  await git(
    '-c', `user.name=${id.name}`,
    '-c', `user.email=${id.email}`,
    'commit', '--author', `${id.name} <${id.email}>`, '-m', message,
  );
}

// ── Allowlist / denylist ──────────────────────────────────────────────────────
const ALLOW = [
  /^src\//, /^docs\//, /^scripts\//, /^\.github\//, /^[^/]+\.md$/,
  /^mcp-server\.js$/, /^start\.js$/, /^package(-lock)?\.json$/,
  /^\.gitignore$/, /^\.env\.example$/, /^LICENSE$/,
];
const DENY = [
  /^data\//, /^\.env$/, /^\.env\.[^x]/, /\.env$/, /^drafts\//, /^applied\//, /^logs\//,
  /\.log$/, /jobs\.db$/, /profile\.json$/, /chrome-debug/, /\.png$/, /\.html$/, /uploads\//,
];

async function staged() {
  return (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
}

/**
 * Stage only allowlisted paths, then hard-abort if anything sensitive slipped in.
 * @returns {string[]} list of staged files
 */
async function safeStage() {
  await git('add', '--',
    'src', 'docs', 'scripts', '.github',
    'mcp-server.js', 'start.js', 'package.json', 'package-lock.json',
    '.gitignore', '.env.example', 'LICENSE',
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md',
  ).catch(() => {});
  const files = await staged();
  const bad = files.filter(f => DENY.some(re => re.test(f)) || !ALLOW.some(re => re.test(f)));
  if (bad.length) {
    await git('reset').catch(() => {});
    throw new Error('ABORT: sensitive/non-allowlisted paths staged: ' + bad.slice(0, 8).join(', '));
  }
  return files;
}

// ── Repo topology ─────────────────────────────────────────────────────────────

/**
 * Determine repo identity: is this a fork? who is upstream?
 * @returns {Promise<{origin, owner, upstream, base, isFork}>}
 */
export async function repoInfo() {
  try {
    const j = JSON.parse(await gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,parent'));
    const upstream = j.parent ? j.parent.nameWithOwner : j.nameWithOwner;
    return {
      origin:   j.nameWithOwner,
      owner:    j.nameWithOwner.split('/')[0],
      upstream,
      base:     j.defaultBranchRef?.name || 'main',
      isFork:   !!j.parent,
    };
  } catch {
    return { origin: '', owner: '', upstream: '', base: 'main', isFork: false };
  }
}

/**
 * Pull the latest code from upstream BEFORE doing anything:
 *   Fork  — fetch upstream/main and rebase. If rebase conflicts, abort cleanly (leave as-is).
 *            Then push the fork's base branch so the fork itself stays current.
 *   Main  — fetch origin/main and fast-forward merge.
 *
 * This is called at the top of every contributeRound() so we always work from the newest code.
 * @returns {Promise<{synced, advanced, reason?}>}
 */
export async function syncBranch() {
  const info = await repoInfo();
  const { base, upstream, isFork } = info;
  try {
    if (isFork && upstream) {
      // Ensure upstream remote exists
      const remotes = await git('remote').catch(() => '');
      if (!/\bupstream\b/.test(remotes)) {
        await git('remote', 'add', 'upstream', `https://github.com/${upstream}.git`).catch(() => {});
      }
      await git('fetch', 'upstream', base).catch(() => {});
      await git('checkout', base).catch(() => {});
      const before = await git('rev-parse', 'HEAD').catch(() => '');
      const result = await git('rebase', `upstream/${base}`)
        .catch(async () => { await git('rebase', '--abort').catch(() => {}); return 'conflict'; });
      if (result === 'conflict') {
        return { ...info, synced: false, reason: 'rebase conflict — left branch as-is, will retry next cycle' };
      }
      const after = await git('rev-parse', 'HEAD').catch(() => '');
      if (before !== after) {
        // Push updated fork branch so it stays current with upstream
        await git('push', 'origin', base).catch(() => {});
      }
      return { ...info, synced: true, advanced: before !== after };
    }

    // Main repo (not a fork): fast-forward merge from origin
    await git('fetch', 'origin', base).catch(() => {});
    await git('checkout', base).catch(() => {});
    await git('merge', '--ff-only', `origin/${base}`).catch(() => {});
    return { ...info, synced: true };
  } catch (e) {
    return { ...info, synced: false, reason: e.message };
  }
}

/**
 * Open a PR from a feature branch to upstream/main.
 * Works for both forks (cross-fork PR) and the main repo itself.
 * Returns to the original branch when done.
 * Hard-guarded — aborts if anything sensitive would be staged.
 * @param {string} message - commit/PR title
 * @returns {Promise<{pr?, pushed, files?, reason?}>}
 */
export async function contributeViaPR(message) {
  const info = await repoInfo();
  const { base, upstream, owner, isFork } = info;
  const startBranch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => base)) || base;
  const branch = `self-evolve/${Date.now()}`;
  try {
    // Stage on current branch first — if nothing changed, skip
    let files;
    try { files = await safeStage(); } catch (e) { return { pushed: false, reason: e.message }; }
    if (!files.length) return { pushed: false, reason: 'nothing to contribute' };
    await git('reset').catch(() => {});           // unstage; commit on a dedicated branch

    await git('checkout', '-b', branch);
    await safeStage();                             // re-stage + re-check on the new branch
    await commitAs(message);                       // author as the GitHub username
    await git('push', '-u', 'origin', branch);

    const head = isFork ? `${owner}:${branch}` : branch;
    const body = [
      'Automated self-evolution contribution from JobPilot.',
      '',
      '- Only allowlisted code/doc paths (never `data/`, `.env`, drafts, logs, screenshots, or the DB).',
      '- Gated by the security review workflow before merge.',
      '',
      `_Files changed: ${files.join(', ')}_`,
    ].join('\n');

    const url = await gh(
      'pr', 'create',
      '--repo', upstream,
      '--base', base,
      '--head', head,
      '--title', message,
      '--body', body,
      '--label', 'self-evolve',
    );
    // Enable auto-merge once CI passes. Use a MERGE commit (not squash) so the author line
    // we set — the GitHub username — is preserved verbatim (squash lets GitHub rewrite the
    // author to the account's profile display name).
    await gh('pr', 'merge', '--auto', '--merge', url).catch(() => {});
    return { pr: url, pushed: true, files };
  } catch (e) {
    return { pushed: false, reason: e.message };
  } finally {
    await git('checkout', startBranch).catch(() => {});
  }
}

/**
 * Approve pending CI for PRs from forks (first-time / external contributors). GitHub holds
 * their workflow runs in `action_required` until a maintainer approves — otherwise the `review`
 * security gate never runs and the PR can never be safely merged. As the repo owner we approve
 * those runs so the security gate executes. We NEVER merge on the strength of this approval alone —
 * the PR still only merges once the `review` gate actually concludes SUCCESS.
 * @param {string} repo - owner/name
 * @returns {Promise<string[]>} ids of runs approved
 */
async function approveForkCIRuns(repo) {
  const approved = [];
  try {
    const raw = await gh('api', `repos/${repo}/actions/runs?status=action_required&per_page=50`, '--jq', '.workflow_runs[].id');
    const ids = (raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      try { await gh('api', '--method', 'POST', `repos/${repo}/actions/runs/${id}/approve`); approved.push(id); } catch {}
    }
    // Also handle runs explicitly 'waiting' for approval
    const raw2 = await gh('api', `repos/${repo}/actions/runs?status=waiting&per_page=50`, '--jq', '.workflow_runs[].id').catch(() => '');
    for (const id of (raw2 || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      if (approved.includes(id)) continue;
      try { await gh('api', '--method', 'POST', `repos/${repo}/actions/runs/${id}/approve`); approved.push(id); } catch {}
    }
  } catch {}
  return approved;
}

/**
 * Main-repo-only: review EVERY open PR from EVERYONE — including PRs from OTHER contributors'
 * forks (there are several contributing agents out there, not just this one). Acts on each:
 *   • first approve any pending fork CI so the `review` security gate actually runs;
 *   • empty / redundant PR (0 changes)        → close with a note.
 *   • useful PR whose `review` gate passed      → merge (merge commit). Uses --admin to force
 *                                                 past a stuck/mechanical `automerge` required check.
 *   • useful PR whose `review` gate FAILED      → left open + flagged. The `review` job is the
 *                                                 data-safety + security gate; that one is NEVER
 *                                                 bypassed, even for a useful-looking PR from anyone.
 *   • useful PR with CI pending/absent          → CI (re)triggered via approval; retried next cycle.
 *
 * @returns {Promise<{merged: string[], closed: string[], skipped: string[], approvedCI?: string[], reason?}>}
 */
export async function reviewAndMergePRs() {
  try {
    const info = await repoInfo();
    if (info.isFork) return { merged: [], closed: [], skipped: [], reason: 'this is a fork — PRs are reviewed on the upstream repo' };

    // Let external contributors' CI run so their security gate can pass.
    const approvedCI = await approveForkCIRuns(info.upstream);

    const raw = await gh(
      'pr', 'list',
      '--repo', info.upstream,
      '--state', 'open',
      '--json', 'number,title,statusCheckRollup,url,additions,deletions,changedFiles,author,isCrossRepository,mergeable,mergeStateStatus',
      '--limit', '50',
    );
    const prs = JSON.parse(raw || '[]');
    const merged = [], closed = [], skipped = [], conflicts = [];

    for (const pr of prs) {
      const who = pr.author?.login ? `@${pr.author.login}` : 'unknown';
      const origin = pr.isCrossRepository ? 'fork' : 'branch';
      const useful = (pr.changedFiles || 0) > 0 && ((pr.additions || 0) + (pr.deletions || 0)) > 0;

      // Empty / redundant PR — nothing to merge, close it politely.
      if (!useful) {
        try {
          await gh('pr', 'close', String(pr.number), '--repo', info.upstream,
            '--comment', `Auto-closed by JobPilot: this PR has no changes against main (already merged / redundant). Thanks ${who}!`);
          closed.push(pr.url);
        } catch { skipped.push(pr.url); }
        continue;
      }

      // The `review` CI job is the data-safety + security gate. It must have concluded SUCCESS.
      const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
      const reviewCheck = checks.find(c => (c.name || c.workflowName || '').toLowerCase().includes('review'));
      const reviewPassed = reviewCheck
        ? (reviewCheck.conclusion === 'SUCCESS' || reviewCheck.conclusion === 'success')
        : false;
      const noChecksYet = checks.length === 0;

      if (!reviewPassed) {
        // Security/review gate not green → never bypass it (protects everyone's data safety).
        skipped.push(`${pr.url} (${origin} by ${who}${noChecksYet ? ' — awaiting CI' + (approvedCI.length ? ' (approved, will run)' : '') : ' — review gate not green, not bypassed'})`);
        continue;
      }

      // Security gate is green. Now handle mergeability.
      // CONFLICTING → cannot merge as-is; flag for conflict resolution (handled by resolveAndMergePR).
      if (pr.mergeable === 'CONFLICTING') {
        conflicts.push(`${pr.url} (${origin} by ${who} — useful + security-passed, needs conflict resolution)`);
        continue;
      }
      // BEHIND the base but not conflicting → update the branch (merge base in) so it can merge.
      if (/BEHIND/i.test(pr.mergeStateStatus || '')) {
        try { await gh('api', '--method', 'PUT', `repos/${info.upstream}/pulls/${pr.number}/update-branch`); } catch {}
      }

      // Useful + security gate green + mergeable → merge (works for fork PRs too), force past stuck automerge.
      try {
        await gh('pr', 'merge', '--merge', '--admin', String(pr.number), '--repo', info.upstream);
        merged.push(`${pr.url} (${origin} by ${who})`);
      } catch {
        try { await gh('pr', 'merge', '--merge', '--auto', String(pr.number), '--repo', info.upstream); merged.push(`${pr.url} (${origin} by ${who})`); }
        catch { skipped.push(`${pr.url} (${origin} by ${who} — merge blocked)`); }
      }
    }

    // After merging PRs, pull the new commits into our local branch
    if (merged.length) await syncBranch().catch(() => {});
    return { merged, closed, skipped, conflicts, approvedCI };
  } catch (e) {
    return { merged: [], closed: [], skipped: [], reason: e.message };
  }
}

// ── Blocker issue filing ──────────────────────────────────────────────────────

const BLOCKER_RULES = [
  { match: /indeed/i,                         title: "Blocker: Indeed anti-bot / login wall — can't auto-apply", labels: 'blocker', file: 'docs/issue-indeed.md' },
  { match: /glassdoor/i,                      title: "Blocker: Glassdoor login + anti-bot wall — can't auto-apply", labels: 'blocker', file: 'docs/issue-glassdoor.md' },
  { match: /workday|icims|taleo|successfactors|oraclecloud|brassring/i, title: 'Account-gated ATS adapters: Workday / iCIMS / Taleo / SuccessFactors', labels: 'ats-adapter', file: 'docs/issue-gated-ats.md' },
  { match: /arbeitnow|weworkremotely|himalayas|remoteok|lnkd\.in/i, title: 'Resolve job-board redirects to the real ATS (Arbeitnow, WeWorkRemotely, Himalayas, RemoteOK)', labels: 'ats-adapter', file: 'docs/issue-board-redirects.md' },
];

/**
 * File GitHub issues for recurring blockers discovered in the evolution memory.
 * Deduped by title — never files the same issue twice.
 * @param {object} opts
 * @param {number} [opts.minCount=3] - minimum encounter count before filing
 * @returns {Promise<{filed: string[], reason?}>}
 */
export async function fileBlockerIssues({ minCount = 3 } = {}) {
  let existing = [];
  try {
    existing = JSON.parse(
      await gh('issue', 'list', '--state', 'all', '--limit', '200', '--json', 'title')
    ).map(i => i.title);
  } catch {
    return { filed: [], reason: 'gh not available / not authed' };
  }

  const enc  = openEncounters(60);
  const want = new Map();
  for (const e of enc) {
    if ((e.count || 0) < minCount) continue;
    const rule = BLOCKER_RULES.find(r => r.match.test(`${e.domain} ${e.signature}`));
    if (rule && !want.has(rule.title)) want.set(rule.title, rule);
  }

  const filed = [];
  for (const [title, rule] of want) {
    if (existing.includes(title)) continue;
    const bodyFile = path.join(ROOT, rule.file);
    const args = ['issue', 'create', '--title', title, '--label', rule.labels];
    if (fs.existsSync(bodyFile)) args.push('--body-file', bodyFile);
    else args.push('--body', 'Auto-filed from JobPilot evolution memory.');
    try { const url = await gh(...args); filed.push(url); } catch {}
  }
  return { filed };
}

// ── Main contribution round ───────────────────────────────────────────────────

/**
 * One full self-contribution cycle (the heart of self-evolution + recontribution):
 *   1. Pull the latest code from upstream (sync first — never contribute stale code)
 *   2. File GitHub issues for recurring blockers
 *   3. Open a CI-gated `self-evolve` PR for any local code/doc changes
 *        Fork → cross-fork PR to upstream.  Main → PR to its own main (never a direct push).
 *   4. Main repo only: review + merge every open self-evolve PR that has passed CI.
 *
 * ON by default (profile.consent.autoContribute defaults true).
 * Toggle off from the dashboard. Pass force:true to override the consent flag.
 *
 * @param {string} [message] - commit/PR title
 * @param {object} [opts]
 * @param {boolean} [opts.force] - skip consent check
 * @returns {Promise<object>} { sync, issues, pr, review }
 */
export async function contributeRound(
  message = 'chore(self-evolve): sync improvements + file discovered blockers',
  { force = false } = {},
) {
  let enabled = force;
  if (!enabled) {
    try {
      const { getProfile } = await import('./profile.js');
      enabled = getProfile().consent?.autoContribute !== false;
    } catch {
      enabled = true;
    }
  }
  if (!enabled) return { skipped: true, reason: 'self-contribution is turned off in the dashboard' };

  const info = await repoInfo();

  // 1. Always sync first — pull new version before contributing
  const sync = await syncBranch().catch(e => ({ synced: false, reason: e.message }));

  // 2. File issues for recurring blockers
  const issues = await fileBlockerIssues().catch(e => ({ filed: [], reason: e.message }));

  // 3. Push local code/doc changes AS A PR (both fork and main repo).
  //    Every change must land on GitHub through a CI-gated self-evolve PR — never a direct push to
  //    main — so the security gate + boot smoke test always run first. For a fork this is a
  //    cross-fork PR to upstream; for the main repo it is a self-evolve PR to its own main.
  const pr = await contributeViaPR(message).catch(e => ({ pushed: false, reason: e.message }));

  // 4. Main repo ALSO acts as reviewer: merge every open self-evolve PR that has passed CI
  //    (including the one just opened, once its checks are green), then fast-forward main.
  let review = {};
  if (!info.isFork) {
    review = await reviewAndMergePRs().catch(e => ({ merged: [], skipped: [], reason: e.message }));
  }

  return { sync, issues, pr, review };
}
