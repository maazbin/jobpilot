// src/apply-sources.js — which job BOARDS the worker acts on / discovers.
// Three logical sources: linkedin, indeed, glassdoor. Default = all three (no behavior change).
// `linkedin` gates LinkedIn Easy Apply + LI post/job scout; `indeed` gates the indeed_easy
// applier channel + Indeed PK scout; `glassdoor` gates Glassdoor discovery (external-routed).
// The form/email/connect channels and HN/boards/web discovery are NOT gated here.
//
// LIVE-RESOLUTION CONTRACT: activeSources() reads env + profile AT CALL TIME and never caches at
// module load. Each lane calls it inside its loop iteration, so a live set_profile/env change is
// honored on the lane's NEXT iteration without a restart.
// Precedence high→low: env JOBPILOT_APPLY_SOURCES, profile.preferences.applySources, default-all.
import { getProfile } from './profile.js';

export const ALL_SOURCES = ['linkedin', 'indeed', 'glassdoor'];

function tokens(input) {
  if (input == null) return [];
  const arr = Array.isArray(input) ? input : String(input).split(',');
  return arr.map(t => String(t).trim().toLowerCase()).filter(Boolean);
}

/**
 * Pure. Resolve the active board set from an env value and a profile value.
 * @returns {{ sources: string[], emptyInput: boolean }}
 *   sources: normalized subset of ALL_SOURCES (always non-empty).
 *   emptyInput: true when a NON-empty input parsed to zero known tokens (caller should log once).
 */
export function parseApplySources(input, profileVal) {
  for (const candidate of [input, profileVal]) {
    const toks = tokens(candidate);
    if (!toks.length) continue;                     // empty/absent → fall through
    if (toks.includes('all') || toks.includes('*')) return { sources: [...ALL_SOURCES], emptyInput: false };
    const known = ALL_SOURCES.filter(s => toks.includes(s));
    if (known.length) return { sources: known, emptyInput: false };
    // non-empty but all tokens unknown → never disable everything; flag for a log line
    return { sources: [...ALL_SOURCES], emptyInput: true };
  }
  return { sources: [...ALL_SOURCES], emptyInput: false };   // default: all three
}

let warnedEmpty = false;
/**
 * Live resolver — reads env + profile AT CALL TIME (not a boot snapshot).
 * @param {(line:string)=>void} [log] optional logger for the parsed-to-empty warning (once).
 * @returns {Set<string>} normalized active sources (always non-empty).
 */
export function activeSources(log) {
  const env = process.env.JOBPILOT_APPLY_SOURCES;
  const profileVal = getProfile().preferences?.applySources;
  const { sources, emptyInput } = parseApplySources(env, profileVal);
  if (emptyInput && !warnedEmpty) {
    warnedEmpty = true;
    if (typeof log === 'function') log(`apply sources input parsed to empty (unknown tokens) — defaulting to all: ${sources.join(', ')}`);
  }
  return new Set(sources);
}
