// src/mcp/queries.js — Generate diverse search queries from the user profile.
// Search only the roles explicitly selected during onboarding.  The worker must
// not broaden a DevOps/cloud profile into generic software, AI, or freelance work.
import { getProfile } from '../profile.js';

// Phrasings that surface HIRING POSTS (not just listings) on LinkedIn content search.
const HIRING_PHRASES = ['hiring', 'we are hiring', 'looking for', 'join our team', 'open role', 'now hiring'];
const APPLY_SIGNALS = ['email your cv', 'dm me', 'apply', 'remote'];

/**
 * Build a deduped list of search queries from the profile's roles + keywords.
 * Each role gets a few phrasings; country-scoped profiles also inject location terms
 * so LinkedIn content search surfaces local hiring posts.
 */
function selectedRoles(p) {
  return (p.preferences?.roles || []).map(r => String(r).trim()).filter(Boolean);
}

// Treat a country-name scope (e.g. 'pakistan') as country-scope, like worker.js's isCountryScoped.
// Inlined here (no worker import) to avoid a heavy/circular dependency.
function isCountryScope(p) {
  const s = String(p.preferences?.locationScope || '').toLowerCase().trim();
  const country = String(p.country || '').toLowerCase().trim();
  if (!s) return false;
  if (s === 'country') return true;
  if (country && s === country) return true;
  return !['worldwide', 'continent', 'all'].includes(s);
}

// Drop any query that names an excluded country. A 2-letter token is treated as a country CODE
// (uppercase, word-bounded), so "in" never trips on the English preposition. 'india'/'bharat'
// are always excluded as a safety net.
function excludeFilter(p) {
  const tokens = [...new Set([...(p.preferences?.excludeCountries || ['india']), 'india', 'bharat'])]
    .map(s => String(s).trim()).filter(Boolean);
  return q => !tokens.some(tok => {
    if (tok.length === 2) {
      const esc = tok.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^A-Za-z0-9])${esc}(?:[^A-Za-z0-9]|$)`).test(q);
    }
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${esc}\\b`, 'i').test(q);
  });
}

// Remote fallback-region queries (UAE/Saudi first, then US — iterated in the profile's stored order).
function fallbackQueries(p, roles) {
  const regions = (p.preferences?.fallbackRegions || []).map(s => String(s).trim()).filter(Boolean);
  const out = [];
  for (const role of roles) for (const region of regions) {
    out.push(`${role} ${region} remote`);
    out.push(`hiring ${role} ${region}`);
  }
  return out;
}

/** Queries for one profile. An empty role list returns nothing — no default persona. */
export function queriesFromProfile(p, { limit = 30 } = {}) {
  const roles = selectedRoles(p);
  if (!roles.length) return [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const country = String(p.country || '').trim();
  const countryScope = isCountryScope(p);
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim())
    .filter(s => s && !/^remote$/i.test(s)).slice(0, 8);

  const out = new Set();
  // PK city/country queries FIRST, so local hiring posts lead the list before the slice trims it.
  for (const role of roles) {
    if (countryScope) {
      out.add(`hiring ${role} ${country}`);
      out.add(`we are hiring ${role} ${country}`);
      for (const loc of prefLocs) {
        out.add(`hiring ${role} ${loc}`);
        out.add(`we are hiring ${role} ${loc}`);
      }
    }
    // Generic role phrasings next.
    out.add(`hiring ${role}${remote}`);
    out.add(`we are hiring ${role}${remote}`);
    out.add(`looking for ${role}${remote} email your cv`);
  }
  // Fallback regions (UAE/Saudi → US) last.
  for (const q of fallbackQueries(p, roles)) out.add(q);
  return [...out].filter(excludeFilter(p)).slice(0, limit);
}

export function buildQueries({ limit = 30 } = {}) {
  return queriesFromProfile(getProfile(), { limit });
}

/** Queries for LinkedIn JOB LISTINGS (jobs/search), roles + skills + freelance. */
export function listingQueriesFromProfile(p, { limit = 18 } = {}) {
  const roles = selectedRoles(p);
  if (!roles.length) return [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const country = String(p.country || '').trim();
  const countryScope = isCountryScope(p);
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim())
    .filter(s => s && !/^remote$/i.test(s)).slice(0, 6);
  const out = new Set();
  for (const r of roles) {
    // PK city/country listings first.
    if (countryScope) {
      if (country) out.add(`${r} ${country}`);
      for (const loc of prefLocs) out.add(`${r} ${loc}`);
    }
    out.add(`${r}${remote}`);
  }
  for (const q of fallbackQueries(p, roles)) out.add(q);
  return [...out].filter(excludeFilter(p)).slice(0, limit);
}

export function buildListingQueries({ limit = 18 } = {}) {
  return listingQueriesFromProfile(getProfile(), { limit });
}

/** Freelance/marketplace listing queries (login-free boards too). */
export function buildFreelanceQueries() {
  const roles = selectedRoles(getProfile());
  return [...new Set(roles.map(r => `freelance ${r}`))];
}

/**
 * Relevance by SKILLS + EXPERIENCE, not fixed role titles (steering).
 * Returns a 0..1 score: fraction of the user's skills/keywords/role-words that
 * appear in the job text. The AGENT sets its own threshold; this is a signal.
 */
export function relevantBySkills(text = '') {
  const p = getProfile();
  const t = (text || '').toLowerCase();
  if (!t) return 0;
  const terms = new Set();
  for (const s of (p.skills || p.preferences?.skills || [])) terms.add(s.toLowerCase());
  for (const k of (p.preferences?.keywords || [])) terms.add(k.toLowerCase());
  for (const r of (p.preferences?.roles || [])) r.toLowerCase().split(/\s+/).forEach(w => w.length > 2 && terms.add(w));
  if (!terms.size) return 0;
  let hit = 0;
  for (const term of terms) if (t.includes(term)) hit++;
  return hit / terms.size;
}
