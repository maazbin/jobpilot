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

/** Queries for one profile. An empty role list returns nothing — no default persona. */
export function queriesFromProfile(p, { limit = 30 } = {}) {
  const roles = selectedRoles(p);
  if (!roles.length) return [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const country = String(p.country || '').trim();
  const isCountryScope = p.preferences?.locationScope === 'country' && country;
  const locationVariants = isCountryScope ? [` ${country}`, ''] : [''];
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim()).filter(Boolean).slice(0, 8);
  const wantsRelo = p.workAuth?.willingToRelocate === true && prefLocs.length > 0;

  const out = new Set();
  for (const role of roles) {
    for (const loc of locationVariants) {
      out.add(`hiring ${role}${loc}${remote}`);
      out.add(`we are hiring ${role}${loc}${remote}`);
    }
    out.add(`looking for ${role}${remote} email your cv`);
    if (wantsRelo) {
      for (const loc of prefLocs) {
        out.add(`hiring ${role} ${loc}`);
        out.add(`${role} ${loc} visa sponsorship`);
      }
    }
  }
  return [...out].slice(0, limit);
}

export function buildQueries({ limit = 30 } = {}) {
  return queriesFromProfile(getProfile(), { limit });
}

/** Queries for LinkedIn JOB LISTINGS (jobs/search), roles + skills + freelance.
 *  New strategy: skill-based + location-specific + remote variants for more coverage.
 */
export function listingQueriesFromProfile(p, { limit = 30 } = {}) {
  const roles = selectedRoles(p);
  if (!roles.length) return [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const prefLocs = (p.preferences?.locations || []).map(s => String(s).trim()).filter(Boolean).slice(0, 6);
  const country = String(p.country || '').trim();
  const isCountryScope = p.preferences?.locationScope === 'country' && country;
  const wantsRelo = p.workAuth?.willingToRelocate === true && prefLocs.length > 0;

  // Extract key skills to build skill-paired queries
  const skills = (p.skills || p.preferences?.keywords || [])
    .map(s => String(s).trim().toLowerCase())
    .filter(s => s.length > 2 && !/aws|ec2|s3|sqs|sns|ses|ecs|lambda/.test(s)) // skip pure infra
    .slice(0, 6);

  const out = new Set();
  for (const r of roles) {
    out.add(`${r}${remote}`);
    // Skill-paired variants (e.g. "React developer", "Next.js developer")
    for (const sk of skills.slice(0, 3)) out.add(`${sk} developer`);
    // Location-specific
    if (isCountryScope) out.add(`${r} ${country}${remote}`);
    if (wantsRelo) {
      for (const loc of prefLocs.slice(0, 3)) out.add(`${r} ${loc}`);
      out.add(`${r} visa sponsorship`);
    }
    // Remote variants
    out.add(`${r} remote`);
  }
  return [...out].slice(0, limit);
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
