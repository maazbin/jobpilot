// src/profile.js — User personalization store.
// Holds CV path, contact info, links, portfolios, and custom Q&A answers.
// The agent reads this to personalize emails and fill application forms.
// Persisted as JSON so it survives restarts and is easy to hand-edit.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const PROFILE_FILE = path.join(ROOT, 'data', 'profile.json');

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

// ── Default shape — everything the agent might need to personalize ────────────
const DEFAULT_PROFILE = {
  // Identity
  name: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',
  country: '',
  gender: '',

  // Context the answer engine uses so it rarely has to ask you
  headline: '',          // e.g. "Senior Software Engineer"
  currentTitle: '',
  currentCompany: '',
  yearsExperience: 0,    // number
  education: '',         // e.g. "Bachelor"
  skills: [],            // ["Python","FastAPI","AWS",…]
  summary: '',           // short professional summary
  extra: '',             // FREE-FORM: anything else useful for the agent (context, preferences, notes)
  salary: {},            // legacy/default expected salary: { amount, currency, period }
  currentSalary: {},     // current compensation: { amount, currency, period }
  salaryExpectations: [], // [{ country, min, max, currency, period }]
  workAuth: {},          // { needsSponsorship:bool, authorizedIn:["<country>"], willingToRelocate:bool }

  // Files
  cvPath: '',            // absolute path to CV/resume PDF
  coverLetterPath: '',   // optional default cover letter

  // Links (free-form — add as many as you like)
  links: {
    linkedin: '',
    github: '',
    portfolio: '',
    website: '',
    // user can add any: twitter, youtube, calendly, dribbble, etc.
  },

  // Projects to mention in outreach (headline achievements)
  projects: [],          // [{ name, url, blurb }]

  // What the agent looks for
  preferences: {
    roles: [],           // ["AI Engineer", "ML Engineer", "Backend Engineer"]
    skip: [],            // ["sales", "junior", "intern"]
    avoidCompanies: [],  // employer/company names to never apply to (current employer is also excluded)
    remoteOnly: true,
    minSalary: 0,
    locations: [],       // acceptable locations, empty = anywhere
    keywords: [],        // skill keywords for relevance
    // Location scope for job search:
    //   'worldwide' — open to any country (default)
    //   'continent' — same continent as your location
    //   'country'   — same country as your location only
    //   'all'       — alias for worldwide (no filtering)
    locationScope: 'worldwide',
    // Off by default. When enabled, a job-specific draft may be generated from
    // canonical CV/profile facts after the dashboard explicitly records approval.
    allowTailoredCv: false,
    // Outreach policy. `email_first` drains cold-email leads before Easy Apply.
    outreachPriority: 'balanced',
    // Optional local CV variants. Each entry is { id, label, path, focuses, keywords }.
    // Paths are per-user data and must never be committed or shared upstream.
    cvVariants: [],
    // Countries to HARD-EXCLUDE from search/keep/score (word-bounded match). Default blocks India.
    excludeCountries: ['india'],
    // Ordered remote-fallback regions used when few/no local leads: earlier = higher priority.
    fallbackRegions: [],
  },

  // Answers to common application questions (agent uses semantically)
  answers: {},           // free-form key -> value, agent matches by meaning

  // Sources the user is logged into (drives which scrapers run)
  loggedInSources: [],   // ["linkedin","indeed","glassdoor","x","gmail","wellfound"]

  // Email sending mode: "gmail_web" (via logged-in Chrome) or "smtp"
  emailMode: 'gmail_web',
  smtp: { user: '', pass: '', fromName: '' },

  // Safety caps
  limits: {
    maxEmailsPerRun: 25,
    // Email daily cap: 0 = UNLIMITED (default). Set a positive number to put a ceiling on how many
    // application emails the agent sends per rolling 24h. Email via the user's Gmail carries no
    // LinkedIn-restriction risk, so it is intentionally uncapped unless the user chooses otherwise.
    maxEmailsPerDay: 0,
    maxAppliesPerRun: 15,
    maxAttemptsPerJob: 3,
    requestTimeoutMs: 30000,
    cooldownBetweenActionsMs: 4000,
    // Which logged-in Gmail account tab to drive: mail/u/<N>/. 0 = first/default account.
    gmailAccountIndex: 0,
    // Email (mailer) pacing [min,max] ms between sends. Email carries NO LinkedIn-restriction
    // risk — only Gmail throttling, which is generous — so it is deliberately brisk and is NOT
    // the heavy Easy-Apply cooldown. Tune here if Gmail ever complains.
    emailPaceMs: [4000, 9000],
    // Easy Apply account-safety: stop at this fraction of the (daily-refreshed) LinkedIn limit,
    // and wait a randomized [min,max] ms AFTER each successful Easy Apply so submissions never
    // burst. See src/limits.js for the researched daily limit.
    easyApplySafetyBuffer: 0.8,
    easyApplyCooldownMs: [90000, 240000],
  },

  // Self-improvement is ON by default — JobPilot contributes code/doc fixes + files blocker
  // issues back to the public repo automatically. It is HARD-GUARDED to never push data/creds.
  // You can still toggle it off from the dashboard.
  consent: {
    autoContribute: true,   // push code/doc improvements + file issues to the public repo automatically
    selfEvolveShare: true,  // share anonymized evolution insights upstream
    // NOTE: brain control is NOT consent-gated — the brain driving the pipeline is always-on core
    // behavior (see scripts/brain-loop.mjs), like self-evolution. This field is retained only for
    // backward-compat and is no longer read as a gate. The only real consent is autoContribute
    // (whether code/doc fixes are pushed to GitHub); the brain can never push data/credentials.
    autoBrainLoop: true,
  },

  _onboarded: false,
  _updatedAt: '',
};

function load() {
  if (!fs.existsSync(PROFILE_FILE)) return { ...DEFAULT_PROFILE };
  try {
    const saved = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    return {
      ...DEFAULT_PROFILE, ...saved,
      links: { ...DEFAULT_PROFILE.links, ...(saved.links || {}) },
      preferences: { ...DEFAULT_PROFILE.preferences, ...(saved.preferences || {}) },
      answers: { ...(saved.answers || {}) },
      limits: { ...DEFAULT_PROFILE.limits, ...(saved.limits || {}) },
      consent: { ...DEFAULT_PROFILE.consent, ...(saved.consent || {}) },
      salary: { ...DEFAULT_PROFILE.salary, ...(saved.salary || {}) },
      currentSalary: { ...DEFAULT_PROFILE.currentSalary, ...(saved.currentSalary || {}) },
      salaryExpectations: Array.isArray(saved.salaryExpectations) ? saved.salaryExpectations : [],
      workAuth: { ...DEFAULT_PROFILE.workAuth, ...(saved.workAuth || {}) },
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function persist(p) {
  p._updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8');
  return p;
}

export function getProfile() {
  const p = load();
  // Auto-derive key fields from `answers` when the top-level fields weren't set directly,
  // so the answer engine (answers.js) can use them without asking the user to re-enter data.
  const a = p.answers || {};
  if (!p.yearsExperience && a['years of experience']) p.yearsExperience = parseFloat(a['years of experience']) || 0;
  if (!p.headline && a['cover letter summary']) p.headline = a['cover letter summary'].split('.')[0].trim().slice(0, 120);
  if (!p.skills || !p.skills.length) {
    // derive skills from preferences.keywords if available
    const kw = (p.preferences && p.preferences.keywords) || [];
    if (kw.length) p.skills = kw.slice(0, 15);
  }
  if (!p.workAuth || !p.workAuth.authorizedIn) {
    const loc = (p.location || '').split(',').pop().trim() || '';
    p.workAuth = {
      ...p.workAuth,
      authorizedIn: loc ? [loc] : [],
      needsSponsorship: a['do you require visa sponsorship'] ? /yes/i.test(a['do you require visa sponsorship']) : undefined,
      willingToRelocate: a['willing to relocate'] ? /yes|open/i.test(a['willing to relocate']) : undefined,
    };
  }
  if (!p.summary && a['cover letter summary']) p.summary = a['cover letter summary'];
  if (!p.education && a['highest education level']) p.education = a['highest education level'];
  if (!p.country) p.country = (p.location || '').split(',').pop().trim();
  return p;
}

function normalizeCompany(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Return the configured current/avoided company name found in text, or ''. */
export function excludedCompanyMatch(text = '', profile = getProfile()) {
  const hay = normalizeCompany(text);
  if (!hay) return '';
  const names = [profile.currentCompany, ...(profile.preferences?.avoidCompanies || [])]
    .map(v => String(v || '').trim())
    .filter(v => normalizeCompany(v).length >= 3);
  return names.find(name => hay.includes(normalizeCompany(name))) || '';
}

/** Whether a lead mentions the current employer or an explicitly avoided company. */
export function isExcludedCompany(text = '', profile = getProfile()) {
  return Boolean(excludedCompanyMatch(text, profile));
}

/** Deep patch. Pass nested objects to merge them. */
export function updateProfile(patch = {}) {
  const p = load();
  const merged = {
    ...p, ...patch,
    links:       { ...p.links,       ...(patch.links || {}) },
    preferences: { ...p.preferences, ...(patch.preferences || {}) },
    answers:     { ...p.answers,     ...(patch.answers || {}) },
    limits:      { ...p.limits,      ...(patch.limits || {}) },
    smtp:        { ...p.smtp,        ...(patch.smtp || {}) },
    consent:     { ...p.consent,     ...(patch.consent || {}) },
    salary:      { ...p.salary,      ...(patch.salary || {}) },
    currentSalary: { ...p.currentSalary, ...(patch.currentSalary || {}) },
    workAuth:    { ...p.workAuth,    ...(patch.workAuth || {}) },
  };
  if (Array.isArray(patch.skills)) merged.skills = patch.skills;
  if (Array.isArray(patch.projects)) merged.projects = patch.projects;
  if (Array.isArray(patch.loggedInSources)) merged.loggedInSources = patch.loggedInSources;
  if (Array.isArray(patch.salaryExpectations)) merged.salaryExpectations = patch.salaryExpectations;
  return persist(merged);
}

/** What's still missing before the agent can run well. */
export function profileGaps() {
  const p = load();
  const gaps = [];
  if (!p.name)                       gaps.push('name');
  if (!p.email)                      gaps.push('email');
  if (!p.cvPath)                     gaps.push('cvPath (path to your CV/resume PDF)');
  else if (!fs.existsSync(p.cvPath)) gaps.push(`cvPath points to a missing file: ${p.cvPath}`);
  if (!p.links.linkedin)             gaps.push('links.linkedin');
  if (!p.preferences.roles.length)   gaps.push('preferences.roles (what jobs to look for)');
  if (!p.loggedInSources.length)     gaps.push('loggedInSources (which sites you logged into in Chrome)');
  return gaps;
}

export function isOnboarded() {
  return profileGaps().length === 0;
}
