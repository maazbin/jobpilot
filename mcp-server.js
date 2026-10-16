#!/usr/bin/env node
// mcp-server.js — Agent-agnostic job automation MCP server.
// Any MCP client (Claude Code, Codex, Kiro, Crew, Grok CLI) drives these tools.
// The CLIENT's LLM is the brain; this server is the hands + memory.
//
// Run:  node mcp-server.js   (stdio transport)
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { initDB, upsertJobs, allJobs, setStatus, counts, logEmail, alreadyEmailed, alreadyApplied, allEmailsSent, doneToday, isBadEmail, isFakeEmail } from './src/tracker.js';
import { initAttempts, recordStep, attemptCount, canAttempt, recentSteps, stepStats } from './src/attempts.js';
import { getProfile, updateProfile, profileGaps, isOnboarded } from './src/profile.js';
import { cdpStatus, listTabs, verifyLogins } from './src/agent/browser.js';
import { scrapePublicSource, scrapeBrowserSite, scrapeLinkedInPosts, PUBLIC_SOURCES, SITE_PRESETS } from './src/mcp/scrape.js';
import { fillAndSubmit, linkedinEasyApply, linkedinDM, linkedinConnect } from './src/mcp/apply.js';
import { easyApply, inspectEasyApply, applyEasyApplyWithAnswers } from './src/mcp/easyapply.js';
import { applyForm } from './src/mcp/forms.js';
import { connect as liConnect } from './src/mcp/connect.js';
import { commentInterested } from './src/mcp/comment.js';
import { liPosts, liJobs, hnHiring, redditHiring, publicBoards } from './src/mcp/sources.js';
import { indeedEasyApplyListings } from './src/mcp/indeed-easyapply.js';
import { initEvolve, pendingQuestions, allAnswers, learn, openEncounters, resolveEncounter, writePlaybook, strategyTable } from './src/evolve.js';
import { buildQueries, buildListingQueries } from './src/mcp/queries.js';
import { getEasyApplyLimit, setEasyApplyLimit, refreshEasyApplyLimitFromWeb } from './src/limits.js';
import { webResearch, runScript, listScripts } from './src/mcp/runtime.js';
import { sendViaGmail } from './src/mcp/gmail.js';
import { subject as buildSubject, body as buildBody } from './src/scraper/email_content.js';
import { launchChrome } from './src/mcp/chrome.js';
import { startServer } from './src/server.js';
import { writeDash } from './src/dashboard.js';

// ── timed wrapper: records every tool call with duration + outcome ────────────
async function timed(tool, target, args, maxAttempts, fn) {
  const start = Date.now();
  const attempt = attemptCount(tool, target) + 1;
  if (maxAttempts && !canAttempt(tool, target, maxAttempts)) {
    recordStep({ tool, target, args, outcome: 'skipped', detail: `max ${maxAttempts} attempts reached`, attempt });
    return { ok: false, skipped: true, detail: `max attempts (${maxAttempts}) reached for ${tool} on ${target}` };
  }
  try {
    const res = await fn();
    recordStep({ tool, target, args, outcome: res.ok === false ? 'fail' : 'ok', detail: res.detail || '', attempt, durationMs: Date.now() - start });
    return res;
  } catch (e) {
    const outcome = /timeout/i.test(e.message) ? 'timeout' : 'fail';
    recordStep({ tool, target, args, outcome, detail: e.message.slice(0, 200), attempt, durationMs: Date.now() - start });
    return { ok: false, detail: e.message };
  }
}

const ok  = obj => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

let PORT = Number(process.env.JOB_AGENT_PORT) || 7788;
let UI_STARTED = false;   // true once startServer() has actually bound the port

// Lazily start the dashboard/onboarding web server only when a tool actually needs it, so the
// MCP server doesn't auto-bind a port every time an agent (Kiro/Claude/Codex) loads the config.
async function ensureUI() {
  if (UI_STARTED) return;
  UI_STARTED = true;  // set before await to prevent concurrent double-starts
  try { const p = await startServer(); if (p) PORT = p; } catch { /* non-fatal */ }
}

// ── TOOL DEFINITIONS ──────────────────────────────────────────────────────────
const TOOLS = [
  // ───────── Onboarding / profile ─────────
  {
    name: 'launch_chrome',
    description: "Launch the user's real Chrome with the debug port so logged-in sites (LinkedIn/Indeed/Glassdoor/Gmail) become reachable. The AGENT calls this and the user does NOTHING — if Chrome is already open on any port without debugging, this force-closes it and relaunches with the debug port + session restore (tabs/logins come back). Returns state 'relaunched'/'already_up'/'no_chrome'/'timeout'.",
    inputSchema: { type: 'object', properties: { force: { type: 'boolean' } } },
    handler: async ({ force }) => ok(await launchChrome({ force })),
  },
  {
    name: 'onboard_status',
    description: 'Check setup: is Chrome debug running, which sites are logged in, what profile fields are missing (CV, links, roles). CALL THIS FIRST. Returns gaps the user must fill and whether the browser is ready.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const cdp = await cdpStatus();
      const tabs = cdp.ok ? await listTabs() : [];
      // Verify REAL logins by navigating + reading auth signals (a fresh dedicated
      // profile has no open tabs, so tab-sniffing falsely reported "not logged in").
      let logins = { linkedin: false, gmail: false, detail: { note: 'cdp down' } };
      if (cdp.ok) logins = await verifyLogins();
      const want = ['linkedin', 'gmail'];
      const loggedIn = want.filter(k => logins[k]);
      const needLogin = want.filter(k => !logins[k]);
      const loginHint = !cdp.ok
        ? 'Chrome debug not up — call launch_chrome.'
        : needLogin.length
          ? `Please log into: ${needLogin.join(' + ')} in the debug Chrome window (open linkedin.com / mail.google.com, sign in), then continue.`
          : 'LinkedIn + Gmail sessions verified live.';
      const LOGIN_URL = { linkedin: 'https://www.linkedin.com/login', gmail: 'https://mail.google.com/' };
      // Hand the user ONE-CLICK links for exactly the sites that need a login.
      const loginLinks = needLogin.map(s => ({ site: s, url: LOGIN_URL[s] }));
      return ok({ chrome: cdp, loggedIn, needLogin, loginLinks, loginDetail: logins.detail, loginHint, profileGaps: profileGaps(), onboarded: isOnboarded(), onboardingUrl: `http://127.0.0.1:${PORT}/onboard`, openTabs: tabs.slice(0, 15) });
    },
  },
  {
    name: 'get_profile',
    description: 'Read the user profile: name, email, phone, CV path, links (linkedin/github/portfolio), projects, job preferences, custom application answers, and safety limits.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok(getProfile()),
  },
  {
    name: 'set_profile',
    description: "Update the user profile. Pass any subset. Use this to add CV path, links, portfolio, projects, preferred roles, custom answers to application questions, and limits. Example: {cvPath:'C:/.../cv.pdf', links:{portfolio:'https://...'}, preferences:{roles:['AI Engineer']}, answers:{'years of python':'4'}}. ALWAYS ask the user for a CV path and any links/portfolios they want to personalize before applying.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' },
        email: { type: 'string' }, phone: { type: 'string' }, location: { type: 'string' },
        cvPath: { type: 'string', description: 'Absolute path to CV/resume PDF' },
        coverLetterPath: { type: 'string' },
        links: { type: 'object', description: 'e.g. {linkedin, github, portfolio, website, twitter}' },
        projects: { type: 'array', description: '[{name, url, blurb}]' },
        preferences: { type: 'object', description: '{roles[], skip[], remoteOnly, minSalary, locations[], keywords[]}' },
        answers: { type: 'object', description: 'free-form Q->A for application forms' },
        loggedInSources: { type: 'array', description: 'sites user is logged into: linkedin,indeed,glassdoor,x,gmail' },
        emailMode: { type: 'string', enum: ['gmail_web', 'smtp'] },
        limits: { type: 'object' },
      },
    },
    handler: async (args) => ok({ updated: true, profile: updateProfile(args) }),
  },

  // ───────── Scraping primitives ─────────
  {
    name: 'generate_queries',
    description: "Generate diverse search queries from the user's FULL profile (all roles: backend, python, system design, product eng, AI, etc. — not just AI). Returns 'post' queries (for scrape_linkedin_posts) and 'listing' queries (for scrape_logged_in_site). Call this to decide what to search for.",
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    handler: async ({ limit = 18 }) => ok({ post: buildQueries({ limit }), listing: buildListingQueries({ limit: Math.ceil(limit / 1.5) }) }),
  },
  {
    name: 'scrape_public_source',
    description: `Scrape one public job board API/RSS (no login). Returns raw jobs; YOU score relevance. Sources: ${Object.keys(PUBLIC_SOURCES).join(', ')}.`,
    inputSchema: { type: 'object', properties: { source: { type: 'string' } }, required: ['source'] },
    handler: async ({ source }) => timed('scrape_public_source', source, { source }, 0, async () => {
      const jobs = await scrapePublicSource(source);
      return { ok: true, count: jobs.length, jobs, detail: `${jobs.length} raw jobs` };
    }),
  },
  {
    name: 'scrape_logged_in_site',
    description: `Scrape a site using the user's LOGGED-IN Chrome tab. Supported: ${Object.keys(SITE_PRESETS).join(', ')}. Returns jobs or a login-required message. This is how LinkedIn/Indeed/Glassdoor work — through the user's real session, not a separate browser.`,
    inputSchema: { type: 'object', properties: { site: { type: 'string' }, query: { type: 'string' }, max: { type: 'number' } }, required: ['site', 'query'] },
    handler: async ({ site, query, max = 25 }) => timed('scrape_logged_in_site', `${site}:${query}`, { site, query }, 2, async () => {
      const r = await scrapeBrowserSite(site, query, { max });
      return { ok: r.ok, count: r.jobs.length, jobs: r.jobs, detail: r.detail };
    }),
  },

  // ───────── Dedup + storage primitives ─────────
  {
    name: 'scrape_linkedin_posts',
    description: "PRIMARY LEAD SOURCE. Scrape LinkedIn hiring POSTS and return rich LEADS, each classified by apply_method (email/form/easy_apply/dm/connect) with everything needed to act: email, formUrl, jobUrl, posterUrl, posterName, postText. Feed each lead to process_lead. Call generate_queries first to search across ALL the user's roles.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, max: { type: 'number' } }, required: ['query'] },
    handler: async ({ query, max = 25 }) => timed('scrape_linkedin_posts', query, { query }, 2, async () => {
      const r = await scrapeLinkedInPosts(query, { max });
      return { ok: r.ok, count: (r.leads || []).length, leads: r.leads, byMethod: r.byMethod, emails: r.emails, detail: r.detail };
    }),
  },

  // ───────── Dedup + storage primitives ─────────
  {
    name: 'save_jobs',
    description: 'Save scraped jobs to the DB. Dedups by URL automatically. Returns how many were NEW. Call after scraping so nothing is lost or double-counted.',
    inputSchema: { type: 'object', properties: { jobs: { type: 'array' } }, required: ['jobs'] },
    handler: async ({ jobs }) => { const n = upsertJobs(jobs); writeDash(); return ok({ saved: n, received: jobs.length, detail: `${n} new jobs added` }); },
  },
  {
    name: 'check_already_actioned',
    description: 'Before emailing/applying, check if this email address OR company+role was already contacted. Prevents over-emailing. Returns {alreadyEmailed, alreadyApplied}.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' } } },
    handler: async ({ email, company, role }) => ok({ alreadyEmailed: alreadyEmailed(email || ''), alreadyApplied: alreadyApplied(company || '', role || '') }),
  },
  {
    name: 'list_jobs',
    description: "Query the job bank. Filter by status (new/emailed/applied/draft), portal, hasEmail, noEmail. Use to decide what to work on next.",
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, portal: { type: 'string' }, hasEmail: { type: 'boolean' }, noEmail: { type: 'boolean' } } },
    handler: async (f) => ok({ jobs: allJobs(f) }),
  },
  {
    name: 'set_job_status',
    description: 'Update a job status after acting: emailed, applied, draft, connected, skipped. Keeps the dedup history accurate.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, status: { type: 'string' }, notes: { type: 'string' } }, required: ['url', 'status'] },
    handler: async ({ url, status, notes }) => { setStatus(url, status, notes || ''); writeDash(); return ok({ updated: true }); },
  },

  // ───────── Email primitive ─────────
  {
    name: 'send_email',
    description: "Send an application email through the user's LOGGED-IN Gmail (not SMTP). Auto-attaches the CV from profile. CHECK check_already_actioned first. Respects per-job max attempts. If you omit subject/body, a proven role-aware template is built from the profile (projects, links, signature) — just pass to + company + role. Pass subject/body to override.",
    inputSchema: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' }, jobUrl: { type: 'string' }, attachmentPath: { type: 'string' } }, required: ['to'] },
    handler: async ({ to, subject, body, company, role, jobUrl, attachmentPath }) => {
      const profile = getProfile();
      const limit = profile.limits.maxAttemptsPerJob;
      if (isFakeEmail(to)) {
        if (jobUrl) setStatus(jobUrl, 'fake', 'known fake address — not contacted');
        return ok({ skipped: true, reason: 'fake_email', detail: `${to} is on the fake-email list` });
      }
      if (isBadEmail(to)) return ok({ skipped: true, reason: 'bad_email', detail: `${to} is not a hiring contact` });
      if (alreadyEmailed(to)) return ok({ skipped: true, reason: 'already_emailed', detail: `${to} already contacted` });
      // Fall back to the proven profile-driven template when not supplied.
      const job = { company: company || '', role: role || 'the role', url: jobUrl || '' };
      const subj = subject || buildSubject(job, profile);
      const text = body || buildBody(job, profile);
      return ok(await timed('send_email', to, { to, subject: subj }, limit, async () => {
        const r = await sendViaGmail({ to, subject: subj, body: text, attachmentPath: attachmentPath || profile.cvPath });
        logEmail(to, company || '', role || '', subj, r.result, jobUrl || '');
        if (r.ok && jobUrl) setStatus(jobUrl, 'emailed');
        writeDash();
        return r;
      }));
    },
  },

  // ───────── Apply primitives ─────────
  {
    name: 'apply_portal',
    description: 'Fill + submit an external application form (Greenhouse/Lever/Ashby/Workable/generic). Resolves job-board pages (RemoteOK/Remotive/Jobicy/Himalayas) to the real ATS, fills every field via the self-evolving answer engine (incl. react-select, radios, consent), uploads the CV, refuses to submit while required answers are unknown (logs them as questions-for-you), and verifies the confirmation page. Set submit=false for a dry run. result: submitted|needs_manual|no_form|error.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, submit: { type: 'boolean' } }, required: ['url'] },
    handler: async ({ url, submit = true }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('apply_portal', url, { url, submit }, limit, async () => {
        const r = await applyForm({ url, submit });
        if (r.result === 'submitted') setStatus(url, 'applied', r.detail);
        else if (r.result === 'needs_manual') setStatus(url, 'needs_manual', r.detail);
        writeDash();
        return r;
      }));
    },
  },
  {
    name: 'apply_linkedin_easy',
    description: "LinkedIn Easy Apply (2026 UI) using the user's session + the self-evolving answer engine. Harvests the user's own prefilled answers into memory, answers radios/selects/numeric/text, verifies 'Application submitted', and records unknown questions as questions-for-you + stuck pages as encounters with screenshots. result: applied|already_applied|no_easy_apply|needs_answers|closed|error.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['url'] },
    handler: async ({ url, dryRun = false }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('apply_linkedin_easy', url, { url }, limit, async () => {
        const r = await easyApply({ url, dryRun });
        if (r.result === 'applied' || r.result === 'already_applied') setStatus(url, 'applied', r.detail);
        else if (r.result === 'needs_answers') setStatus(url, 'needs_manual', r.detail);
        writeDash();
        return r;
      }));
    },
  },
  {
    name: 'easyapply_inspect',
    description: "Open a LinkedIn Easy Apply and return the FULL ordered field list across ALL pages WITHOUT submitting — each {question, type (text|long-text|single-choice|multi-choice|select|file), options, maxlength, required, page}. Use this to READ an unfamiliar form so YOU reason over every question with the user's CV + profile, then answer via easyapply_apply_with_answers. Every form differs: inspect first, think, then fill.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: async ({ url }) => ok(await inspectEasyApply({ url })),
  },
  {
    name: 'easyapply_apply_with_answers',
    description: "Submit a LinkedIn Easy Apply using YOUR reasoned answers. `answers` maps each question's text (from easyapply_inspect) to your answer: a string for text/select/single-choice, an array (or comma string) for multi-choice (e.g. timezones — pick any; the user can work any). Omissions fall back to the built-in engine. Fills radios/checkboxes/selects/text robustly (handles 2026 empty-label 0x0 inputs), advances every page, submits, verifies. result: applied|stuck|already_applied|no_easy_apply|closed|error. On stuck it returns the blocking fields so you can refine and retry.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, answers: { type: 'object' }, dryRun: { type: 'boolean' } }, required: ['url', 'answers'] },
    handler: async ({ url, answers = {}, dryRun = false }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('easyapply_apply_with_answers', url, { url }, limit, async () => {
        const r = await applyEasyApplyWithAnswers({ url, answers, dryRun });
        if (r.result === 'applied' || r.result === 'already_applied') setStatus(url, 'applied', r.detail);
        writeDash();
        return r;
      }));
    },
  },

  {
    name: 'easyapply_inspect',
    description: "Open a LinkedIn Easy Apply and return the FULL ordered field list across ALL pages WITHOUT submitting — each {question, type (text|long-text|single-choice|multi-choice|select|file), options, maxlength, required, page}. Use this to READ an unfamiliar form so YOU reason over every question with the user's CV + profile, then answer via easyapply_apply_with_answers. Every form differs: inspect first, think, then fill.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: async ({ url }) => ok(await inspectEasyApply({ url })),
  },
  {
    name: 'easyapply_apply_with_answers',
    description: "Submit a LinkedIn Easy Apply using YOUR reasoned answers. `answers` maps each question's text (from easyapply_inspect) to your answer: a string for text/select/single-choice, an array (or comma string) for multi-choice (e.g. timezones — pick any; the user can work any). Omissions fall back to the built-in engine. Fills radios/checkboxes/selects/text robustly (handles 2026 empty-label 0x0 inputs), advances every page, submits, verifies. result: applied|stuck|already_applied|no_easy_apply|closed|error. On stuck it returns the blocking fields so you can refine and retry.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, answers: { type: 'object' }, dryRun: { type: 'boolean' } }, required: ['url', 'answers'] },
    handler: async ({ url, answers = {}, dryRun = false }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('easyapply_apply_with_answers', url, { url }, limit, async () => {
        const r = await applyEasyApplyWithAnswers({ url, answers, dryRun });
        if (r.result === 'applied' || r.result === 'already_applied') setStatus(url, 'applied', r.detail);
        writeDash();
        return r;
      }));
    },
  },

  {
    name: 'linkedin_dm',
    description: "Direct-message a LinkedIn post's author (recruiter/hiring manager). Works only if messaging is open (1st-degree or open profile); otherwise returns no_dm — then use linkedin_connect. Uses a profile-personalized note.",
    inputSchema: { type: 'object', properties: { profileUrl: { type: 'string' }, role: { type: 'string' }, company: { type: 'string' } }, required: ['profileUrl'] },
    handler: async ({ profileUrl, role, company }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('linkedin_dm', profileUrl, { profileUrl }, limit, async () => {
        const r = await linkedinDM({ profileUrl, role, company });
        return r;
      }));
    },
  },
  {
    name: 'linkedin_connect',
    description: "Send a LinkedIn connection request WITH a personalized note to a post's author (2026 UI; handles Connect being under the 'More' menu as a link, scopes to the main column so sidebar invites are never clicked, falls back to no-note send if the free note quota is exhausted). Use as the fallback when linkedin_dm returns no_dm. result: connected|connected_no_note|already_pending|already_connected|no_connect|limit|error.",
    inputSchema: { type: 'object', properties: { profileUrl: { type: 'string' }, posterName: { type: 'string' }, role: { type: 'string' }, company: { type: 'string' }, dryRun: { type: 'boolean' } }, required: ['profileUrl'] },
    handler: async ({ profileUrl, posterName, role, company, dryRun = false }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('linkedin_connect', profileUrl, { profileUrl }, limit, async () => {
        const r = await liConnect({ profileUrl, posterName, role, company, dryRun });
        return r;
      }));
    },
  },
  {
    name: 'comment_interested',
    description: "Comment 'Interested' (a short, profile-personalized note) on a LinkedIn hiring POST so the poster sees engagement. Pass the post URL (feed/update or /posts/). Verifies the comment landed. Use for hiring posts where you want an extra touchpoint alongside email/connect. result: commented|already_commented|no_comment_box|error.",
    inputSchema: { type: 'object', properties: { postUrl: { type: 'string' }, role: { type: 'string' }, company: { type: 'string' }, text: { type: 'string', description: 'optional custom comment; omit to auto-generate from profile' }, dryRun: { type: 'boolean' } }, required: ['postUrl'] },
    handler: async ({ postUrl, role, company, text, dryRun = false }) => {
      const limit = getProfile().limits.maxAttemptsPerJob;
      return ok(await timed('comment_interested', postUrl, { postUrl }, limit, async () => {
        return await commentInterested({ postUrl, role, company, text, dryRun });
      }));
    },
  },
  {
    name: 'process_lead',
    description: "OPTIONAL CONVENIENCE router — you are not required to use it. Given a lead, it acts on `apply_method` (email→send_email, form→apply_portal, easy_apply→apply_linkedin_easy, dm→linkedin_dm→connect fallback) and dedups first. You OWN the decision: a lead carries `availableChannels` (all facts) + `suggestedMethod` (a hint). When you want a different channel, custom email copy, or your own ordering, call the primitive tools directly instead of this.",
    inputSchema: { type: 'object', properties: { lead: { type: 'object', description: 'a lead object from scrape_linkedin_posts' } }, required: ['lead'] },
    handler: async ({ lead }) => {
      const profile = getProfile();
      const { apply_method, email, formUrl, jobUrl, posterUrl, role, company } = lead;
      // The post's own permalink (comment fallback). Accept camelCase (fresh scrape) or
      // snake_case (DB row). Must be a /feed/update/ or /posts/ URL — never a profile URL.
      const postUrlOf = l => { const u = l.postUrl || l.post_url || ''; return /linkedin\.com\/(feed\/update|posts\/)/i.test(u) ? u : ''; };
      const maybeComment = async (l, rl, co) => {
        const pu = postUrlOf(l);
        if (!pu) return null;
        return await timed('comment_interested', pu, { postUrl: pu }, profile.limits.maxAttemptsPerJob, async () => commentInterested({ postUrl: pu, role: rl, company: co })).catch(() => null);
      };
      // Dedup guards
      if (email && isFakeEmail(email)) return ok({ action: 'skip', reason: 'fake_email', detail: email });
      if (email && isBadEmail(email)) return ok({ action: 'skip', reason: 'bad_email', detail: email });
      if (email && alreadyEmailed(email)) return ok({ action: 'skip', reason: 'already_emailed', detail: email });
      if (alreadyApplied(company || '', role || '')) return ok({ action: 'skip', reason: 'already_applied', detail: `${company} ${role}` });

      // Prefer the email channel whenever a usable, not-already-emailed address is present — email
      // is the highest-priority outreach channel and must not lose out to an easy_apply/form hint.
      const method = (email && !alreadyEmailed(email)) ? 'email' : apply_method;

      if (method === 'email' && email) {
        const subj = buildSubject({ company, role }, profile);
        const text = buildBody({ company, role }, profile);
        const r = await timed('send_email', email, { email }, profile.limits.maxAttemptsPerJob, async () => {
          const res = await sendViaGmail({ to: email, subject: subj, body: text, attachmentPath: profile.cvPath });
          logEmail(email, company || '', role || '', subj, res.result, lead.url || '');
          return res;
        });
        return ok({ action: 'email', to: email, result: r });
      }
      if (method === 'form' && formUrl) {
        const r = await timed('apply_portal', formUrl, { formUrl }, profile.limits.maxAttemptsPerJob, async () => {
          const res = await fillAndSubmit({ url: formUrl }); if (res.submitted) setStatus(formUrl, 'applied'); return res;
        });
        return ok({ action: 'form', url: formUrl, result: r });
      }
      if (method === 'easy_apply' && jobUrl) {
        const r = await timed('apply_linkedin_easy', jobUrl, { jobUrl }, profile.limits.maxAttemptsPerJob, async () => {
          const res = await linkedinEasyApply({ url: jobUrl }); if (res.result === 'applied') setStatus(jobUrl, 'applied'); return res;
        });
        return ok({ action: 'easy_apply', url: jobUrl, result: r });
      }
      if ((method === 'dm' || method === 'connect') && posterUrl) {
        // Try DM first, fall back to connect+note
        let r = await timed('linkedin_dm', posterUrl, { posterUrl }, profile.limits.maxAttemptsPerJob, async () => linkedinDM({ profileUrl: posterUrl, role, company }));
        if (r.result === 'no_dm') {
          r = await timed('linkedin_connect', posterUrl, { posterUrl }, profile.limits.maxAttemptsPerJob, async () => linkedinConnect({ profileUrl: posterUrl, role, company }));
          await maybeComment(lead, role, company);
          return ok({ action: 'connect', url: posterUrl, result: r });
        }
        await maybeComment(lead, role, company);
        return ok({ action: 'dm', url: posterUrl, result: r });
      }
      // No poster to DM/connect, but we have the post permalink → comment "Interested".
      if ((method === 'connect' || method === 'none') && postUrlOf(lead)) {
        const r = await maybeComment(lead, role, company);
        if (r) return ok({ action: 'comment', url: postUrlOf(lead), result: r });
      }
      return ok({ action: 'skip', reason: 'no_actionable_method', detail: apply_method });
    },
  },

  // ───────── Account safety ─────────
  {
    name: 'research_easy_apply_limit',
    description: "Research the CURRENT LinkedIn Easy Apply daily submission limit from the public web and store it (data/easyapply-limit.json). Over-applying can get an account restricted, so JobPilot stops Easy Apply at a safety buffer (default 80%) of this number. Safe: a failed/implausible fetch never raises the cap. Call this once a day. Returns the stored dailyLimit, effectiveCap (the 80% stop point), source, and candidates seen.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok(await refreshEasyApplyLimitFromWeb()),
  },
  {
    name: 'set_easy_apply_limit',
    description: "Set the LinkedIn Easy Apply daily limit you discovered via your own web_research (e.g. the agent read that LinkedIn currently caps Easy Apply at ~50/day). JobPilot stops Easy Apply at safetyBuffer×dailyLimit. dailyLimit is sanity-bounded to [20,200] and the effective cap is capped at 80 regardless. Returns the stored limit + the 80% effectiveCap.",
    inputSchema: { type: 'object', properties: { dailyLimit: { type: 'number' }, safetyBuffer: { type: 'number', description: 'fraction in (0,1], default 0.8' }, source: { type: 'string' } }, required: ['dailyLimit'] },
    handler: async ({ dailyLimit, safetyBuffer, source }) => ok(setEasyApplyLimit({ dailyLimit, safetyBuffer, source: source || 'agent web_research' })),
  },

  // ───────── Observability ─────────
  {
    name: 'get_stats',
    description: 'Full dashboard data: job counts by status/source/portal, emails sent, applications, step history, attempt counts, timeouts, and the Easy Apply safety limit (daily limit, 80% safety cap, today\'s Easy Apply count). Use to report progress to the user.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const lim = getEasyApplyLimit();
      const easyToday = doneToday('li_easy_apply');
      return ok({
        jobs: counts(), steps: stepStats(), emailsSent: allEmailsSent().length, recentSteps: recentSteps(30),
        easyApply: {
          dailyLimit: lim.dailyLimit, safetyBuffer: lim.safetyBuffer, effectiveCap: lim.effectiveCap,
          usedToday: easyToday, remaining: Math.max(0, lim.effectiveCap - easyToday),
          source: lim.source, checkedAt: lim.checkedAt, stale: lim.stale,
          paused: easyToday >= lim.effectiveCap,
        },
      });
    },
  },
  {
    name: 'open_onboarding',
    description: "Return the local onboarding URL where the user UPLOADS their CV and PASTES their links/roles in a form (no typing paths in chat). Give this URL to the user to click. The form writes directly to the profile. Use this instead of asking for a CV path in chat.",
    inputSchema: { type: 'object', properties: {} },
    handler: async () => { await ensureUI(); return ok({ url: `http://127.0.0.1:${PORT}/onboard`, detail: 'Open this to upload CV + paste links' }); },
  },
  {
    name: 'open_dashboard',
    description: 'Regenerate the HTML dashboard and return the live local URL (scraped jobs, emails sent, applications, step timeline).',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => { await ensureUI(); writeDash(); return ok({ url: `http://127.0.0.1:${PORT}/dashboard`, detail: 'live dashboard' }); },
  },

  // ───────── Runtime extensibility — agent decides & extends on the fly ─────────
  {
    name: 'web_research',
    description: "Fetch ANY public URL from the open internet (a company careers page, a job board you have no preset for, a Google result, a hiring tweet's linked page) and extract emails + ATS apply links + readable text. Use this to chase leads anywhere, not just preset sources. The agent decides what to do with what it finds.",
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    handler: async ({ url }) => ok(await timed('web_research', url, { url }, 2, async () => webResearch(url))),
  },
  {
    name: 'run_script',
    description: "Author and run your OWN Node ESM helper when no existing tool fits — e.g. a scraper for a site with no preset, a custom parser, a batch action. The script runs from the project root so it can `import` the project's modules (./src/mcp/scrape.js, ./src/tracker.js, etc.). Returns stdout/stderr. Scripts persist under data/agent-scripts and can be reused. This is how you create new tools at runtime.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, code: { type: 'string', description: 'Node ESM source' }, args: { type: 'array' } }, required: ['code'] },
    handler: async ({ name, code, args }) => ok(await runScript({ name, code, args: args || [] })),
  },
  {
    name: 'list_scripts',
    description: 'List helper scripts you have already authored (under data/agent-scripts), so you reuse instead of recreating.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok({ scripts: listScripts() }),
  },

  // ───────── Coarse convenience wrapper ─────────
  {
    name: 'find_jobs',
    description: 'COARSE wrapper: scrape all public sources + any logged-in sites in the profile, save new jobs, return a summary. Good for a one-shot "find me jobs". For fine control use scrape_* primitives.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    handler: async ({ query }) => {
      const profile = getProfile();
      const q = query || (profile.preferences.roles[0] || 'AI engineer') + ' remote';
      let allNew = [], errors = [];
      // Public API sources (no login)
      for (const src of Object.keys(PUBLIC_SOURCES)) {
        try { const jobs = await scrapePublicSource(src); allNew.push(...jobs); recordStep({ tool: 'scrape_public_source', target: src, outcome: 'ok', detail: `${jobs.length}` }); }
        catch (e) { errors.push(`${src}: ${e.message.slice(0, 60)}`); recordStep({ tool: 'scrape_public_source', target: src, outcome: 'fail', detail: e.message.slice(0, 100) }); }
      }
      // LinkedIn job listings (logged-in)
      try { const r = await scrapeBrowserSite('linkedin', q); allNew.push(...r.jobs); recordStep({ tool: 'scrape_logged_in_site', target: 'linkedin', outcome: r.ok ? 'ok' : 'fail', detail: r.detail }); }
      catch (e) { errors.push(`linkedin: ${e.message.slice(0, 60)}`); }
      // LinkedIn hiring posts (email outreach)
      try { const r = await scrapeLinkedInPosts(q); allNew.push(...r.jobs); recordStep({ tool: 'scrape_linkedin_posts', target: q, outcome: r.ok ? 'ok' : 'fail', detail: r.detail }); }
      catch (e) { errors.push(`linkedin_posts: ${e.message.slice(0, 60)}`); }
      const saved = upsertJobs(allNew);
      writeDash();
      return ok({ scraped: allNew.length, newlySaved: saved, errors, detail: `${saved} new jobs from ${allNew.length} scraped` });
    },
  },

  // ───────── Fresh, dated lead sources (newest first) ─────────
  {
    name: 'scrape_fresh',
    description: "Pull the FRESHEST leads from a source, each stamped with posted_at so you can act newest-first. source: 'li_posts' (LinkedIn hiring posts, past 24h) | 'li_jobs' (LinkedIn Easy-Apply listings, 24h) | 'indeed' (Indeed Pakistan 'Easily apply' listings) | 'hn' (latest HN 'Who is hiring') | 'reddit' (r/forhire etc) | 'boards' (RemoteOK/Remotive/Jobicy/Himalayas). Returns leads with channel (email/easy_apply/indeed_easy/form/connect), relevance, skip flag. Save with save_jobs.",
    inputSchema: { type: 'object', properties: { source: { type: 'string' }, query: { type: 'string' } }, required: ['source'] },
    handler: async ({ source, query }) => timed('scrape_fresh', `${source}:${query || ''}`, { source, query }, 0, async () => {
      const r = source === 'li_posts' ? await liPosts(query || 'hiring remote email cv')
        : source === 'li_jobs' ? await liJobs(query || 'AI Engineer')
        : source === 'indeed' ? await indeedEasyApplyListings(query || 'AI Engineer')
        : source === 'hn' ? await hnHiring()
        : source === 'reddit' ? await redditHiring()
        : source === 'boards' ? await publicBoards()
        : { ok: false, leads: [], detail: 'unknown source' };
      return { ...r, count: (r.leads || []).length };
    }),
  },

  // ───────── Self-evolution memory ─────────
  {
    name: 'list_questions',
    description: 'List application questions the agent could NOT answer (asked once, waiting for the user). Each has the question text and any multiple-choice options. Answer them with learn_answer so the agent reuses the answer on every future application.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ok({ pending: pendingQuestions() }),
  },
  {
    name: 'learn_answer',
    description: "Teach the agent an answer to an application question. It is stored forever and reused (fuzzy-matched) on every future Easy Apply / form. Use source 'user' for human-provided answers (highest priority).",
    inputSchema: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' }, source: { type: 'string' } }, required: ['question', 'answer'] },
    handler: async ({ question, answer, source = 'user' }) => { learn(question, answer, source); writeDash(); return ok({ learned: true, question, answer }); },
  },
  {
    name: 'list_encounters',
    description: 'List OPEN encounters — things the agent hit that it could not handle (stuck Easy Apply pages, form layouts with no submit, login-gated ATS, exceptions), grouped by signature with a count, a sample URL, and a saved screenshot + HTML snapshot path under data/evolution/. This is your to-do list for improving the code.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
    handler: async ({ limit = 50 }) => ok({ encounters: openEncounters(limit) }),
  },
  {
    name: 'resolve_encounter',
    description: "Mark an encounter fixed after you patch the code (status 'fixed') or won't-fix ('wontfix'). Pass the encounter id and a short note describing the resolution.",
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, resolution: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'resolution'] },
    handler: async ({ id, resolution, status = 'fixed' }) => { resolveEncounter(id, resolution, status); return ok({ resolved: id }); },
  },
  {
    name: 'evolution_report',
    description: 'Full self-improvement snapshot: open encounters, pending questions, learned answers, and strategy stats (which queries/domains perform best). Also regenerates data/evolution/PLAYBOOK.md. Read this at the start of a session to decide what to fix or ask the user.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => { writePlaybook(); return ok({ encounters: openEncounters(40), questions: pendingQuestions(), learned: allAnswers().slice(0, 60), queries: strategyTable('post_query').slice(0, 20), formDomains: strategyTable('form_domain').slice(0, 20), playbook: 'data/evolution/PLAYBOOK.md' }); },
  },
  {
    name: 'contribute_improvements',
    description: "Self-improving repo loop: file GitHub issues for recurring blockers in the evolution memory, then commit + push ALLOWLISTED code/doc changes (src/, docs/, scripts/, *.md, mcp-server.js, start.js, package.json) to the public repo. HARD-GUARDED: aborts if anything under data/, .env*, drafts/, applied/, logs/, screenshots, or the DB is ever staged — so personal data and credentials are never pushed. Commits are attributed to the repo owner. Call after you fix an encounter in code (resolve_encounter first).",
    inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'commit message' } } },
    handler: async ({ message }) => { const { contributeRound } = await import('./src/contribute.js'); return ok(await contributeRound(message || undefined)); },
  },
];

// ── Server wiring ─────────────────────────────────────────────────────────────
const server = new Server({ name: 'job-agent-mcp', version: '3.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find(t => t.name === req.params.name);
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
  try {
    return await tool.handler(req.params.arguments || {});
  } catch (e) {
    return { content: [{ type: 'text', text: `Error in ${req.params.name}: ${e.message}` }], isError: true };
  }
});

async function main() {
  await initDB();
  await initAttempts();
  // Connect the MCP transport FIRST so the client handshake (initialize / tools/list) succeeds
  // immediately — Chrome launch and other boot work must never delay tool availability, or strict
  // MCP clients (e.g. codex) time out the server startup and see NO tools.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Auto-launch the debug Chrome in the BACKGROUND (not awaited) so logged-in sites become
  // reachable without blocking the handshake. Any browser tool self-heals Chrome if it's not up.
  Promise.resolve().then(() => launchChrome()).catch(e => console.error('[job-agent] Chrome auto-launch:', e.message));
  // Only auto-start the dashboard server at boot when explicitly requested (START_UI=1); otherwise
  // it starts lazily via ensureUI() when a UI tool is used. Prevents binding a port on every MCP load.
  if (process.env.START_UI === '1') {
    try { PORT = await startServer(); } catch (e) { console.error('[job-agent] web server failed:', e.message); }
  }
  if (PORT) process.env.JOB_AGENT_PORT = String(PORT);   // so writeDash() embeds the correct fallback port
  // Agent-only mode: keep self-evolution + recontribution running on a timer too (stands down
  // automatically while the always-on worker is live, so there's never double-contribution).
  try { const { startBackgroundEvolve } = await import('./src/evolve-loop.js'); startBackgroundEvolve(); } catch (e) { console.error('[job-agent] background evolve not started:', e.message); }
  // Log to stderr (stdout is the MCP channel)
  console.error(`[job-agent-mcp] ready — ${TOOLS.length} tools over stdio · UI at http://127.0.0.1:${PORT}`);

  // ── Clean shutdown: do NOT write data/.stop on disconnect/exit. ───────────────
  // The detached, self-respawning worker is designed to OUTLIVE the agent session (see AGENTS.md:
  // "never stop until the user stops you"). Writing the stop flag on exit/SIGINT/SIGTERM/stdin-end
  // killed the background worker on every MCP disconnect — the recurring "worker stops instead of
  // looping" bug (issues #20 / #109). Only an EXPLICIT user Stop (dashboard ⏹ / `npm run stop`)
  // should write data/.stop. We register no stop-on-disconnect hooks; just exit cleanly.
  process.on('SIGINT',  () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.on('end', () => { setTimeout(() => process.exit(0), 1500); });
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
