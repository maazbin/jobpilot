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

// Treat any country-name scope (e.g. 'pakistan') as country-scope — mirrors worker.js
// isCountryScoped, inlined here to avoid importing the worker into query generation.
function isCountryScope(p) {
  const scope = String(p.preferences?.locationScope || '').toLowerCase().trim();
  const country = String(p.country || '').toLowerCase().trim();
  if (!scope) return false;
  if (scope === 'country') return true;
  if (scope === country) return true;
  return !['worldwide', 'continent', 'all'].includes(scope);
}

// Drop any query naming an excluded country (India by default), word-bounded so "in"
// never matches inside another word. Keeps India/Bharat queries from ever being emitted.
function excludeFilter(p) {
  const ex = (p.preferences?.excludeCountries || ['india'])
    .map(s => String(s).toLowerCase().trim()).filter(Boolean);
  const res = ex.map(tok => new RegExp(`(?:^|[^a-z0-9])${tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i'));
  return q => !res.some(re => re.test(q));
}

/** Queries for one profile. An empty role list returns nothing — no default persona.
 *  Country-scoped profiles emit PK-city queries FIRST, then UAE/Saudi/US fallback queries. */
export function queriesFromProfile(p, { limit = 30 } = {}) {
  const roles = selectedRoles(p);
  if (!roles.length) return [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const country = String(p.country || '').trim();
  const countryScoped = isCountryScope(p);
  // PK cities to target first (strip the generic "Remote" entry — it is not a city query).
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim())
    .filter(s => s && !/^remote$/i.test(s)).slice(0, 8);
  // Fallback regions (UAE/Saudi first, then US) in their stored order.
  const fallback = (p.preferences?.fallbackRegions || []).map(s => String(s).trim()).filter(Boolean);

  const out = new Set();
  // 1) PK-city queries FIRST so they occupy the front of the limit slice.
  if (countryScoped && prefLocs.length) {
    for (const role of roles) {
      for (const city of prefLocs) {
        out.add(`hiring ${role} ${city}`);
        out.add(`we are hiring ${role} ${city}`);
      }
    }
  }
  // 2) Generic role phrasings (with the country term when country-scoped).
  const locationVariants = countryScoped && country ? [` ${country}`, ''] : [''];
  for (const role of roles) {
    for (const loc of locationVariants) {
      out.add(`hiring ${role}${loc}${remote}`);
      out.add(`we are hiring ${role}${loc}${remote}`);
    }
    out.add(`looking for ${role}${remote} email your cv`);
  }
  // 3) Fallback-region remote queries — UAE/Saudi ahead of US (stored order).
  for (const role of roles) {
    for (const region of fallback) {
      out.add(`${role} ${region} remote`);
      out.add(`hiring ${role} ${region}`);
    }
  }
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
  const countryScoped = isCountryScope(p);
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim())
    .filter(s => s && !/^remote$/i.test(s)).slice(0, 6);
  const fallback = (p.preferences?.fallbackRegions || []).map(s => String(s).trim()).filter(Boolean);
  const out = new Set();
  // PK-city listings first when country-scoped.
  if (countryScoped && prefLocs.length) for (const r of roles) for (const loc of prefLocs) out.add(`${r} ${loc}`);
  for (const r of roles) out.add(`${r}${remote}`);
  // Fallback regions (UAE/Saudi then US) after local.
  for (const r of roles) for (const region of fallback) out.add(`${r} ${region} remote`);
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
