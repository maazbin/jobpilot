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

  // Context the answer engine uses so it rarely has to ask you
  headline: '',          // e.g. "Senior Software Engineer"
  currentTitle: '',
  currentCompany: '',
  yearsExperience: 0,    // number
  education: '',         // e.g. "Bachelor"
  skills: [],            // ["Python","FastAPI","AWS",…]
  summary: '',           // short professional summary
  extra: '',             // FREE-FORM: anything else useful for the agent (context, preferences, notes)
  salary: {},            // { amount, currency, period }  e.g. {amount:500000,currency:"PKR",period:"month"}
  workAuth: {},          // { needsSponsorship:bool, authorizedIn:["Pakistan"], willingToRelocate:bool }

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
    maxAppliesPerRun: 15,
    maxAttemptsPerJob: 3,
    requestTimeoutMs: 30000,
    cooldownBetweenActionsMs: 4000,
  },

  // Self-improvement is ON by default — JobPilot contributes code/doc fixes + files blocker
  // issues back to the public repo automatically. It is HARD-GUARDED to never push data/creds.
  // You can still toggle it off from the dashboard.
  consent: {
    autoContribute: true,   // push code/doc improvements + file issues to the public repo automatically
    selfEvolveShare: true,  // share anonymized evolution insights upstream
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
  return load();
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
    workAuth:    { ...p.workAuth,    ...(patch.workAuth || {}) },
  };
  if (Array.isArray(patch.skills)) merged.skills = patch.skills;
  if (Array.isArray(patch.projects)) merged.projects = patch.projects;
  if (Array.isArray(patch.loggedInSources)) merged.loggedInSources = patch.loggedInSources;
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
