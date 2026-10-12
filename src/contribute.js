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
    await git('commit', '-m', message);
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
    // Enable auto-merge so the PR self-merges once CI passes
    await gh('pr', 'merge', '--auto', '--squash', url).catch(() => {});
    return { pr: url, pushed: true, files };
  } catch (e) {
    return { pushed: false, reason: e.message };
  } finally {
    await git('checkout', startBranch).catch(() => {});
  }
}

/**
 * Main-repo-only: review all open self-evolve PRs and merge the ones that have passed CI.
 * Safe — only merges PRs labelled 'self-evolve' whose status checks all pass.
 * Skips PRs that have failing or pending checks.
 * @returns {Promise<{merged: string[], skipped: string[], reason?}>}
 */
export async function reviewAndMergePRs() {
  try {
    const info = await repoInfo();
    if (info.isFork) return { merged: [], skipped: [], reason: 'this is a fork — PRs are reviewed on the upstream repo' };

    const raw = await gh(
      'pr', 'list',
      '--repo', info.upstream,
      '--label', 'self-evolve',
      '--state', 'open',
      '--json', 'number,title,statusCheckRollup,url',
      '--limit', '20',
    );
    const prs = JSON.parse(raw || '[]');
    const merged = [], skipped = [];

    for (const pr of prs) {
      // statusCheckRollup: null means no CI yet; array means checks ran
      const checks = pr.statusCheckRollup;
      const allPassed = Array.isArray(checks) && checks.length > 0
        && checks.every(c => c.state === 'SUCCESS' || c.conclusion === 'success' || c.status === 'COMPLETED' && c.conclusion === 'SUCCESS');

      if (!allPassed) {
        skipped.push(pr.url);
        continue;
      }
      try {
        await gh('pr', 'merge', '--squash', '--auto', String(pr.number), '--repo', info.upstream);
        merged.push(pr.url);
      } catch {
        skipped.push(pr.url);
      }
    }

    // After merging PRs, pull the new commits into our local branch
    if (merged.length) {
      await syncBranch().catch(() => {});
    }
    return { merged, skipped };
  } catch (e) {
    return { merged: [], skipped: [], reason: e.message };
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
