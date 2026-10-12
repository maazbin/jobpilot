// src/mcp/answers.js — Answer engine for application questions (Easy Apply + external forms).
//
// Resolution order (first hit wins):
//   1. evolution memory — answers the user taught, or harvested from LinkedIn prefilled forms
//   2. profile.answers  — keyword overrides the user pasted in the onboarding form
//   3. rules derived from the profile (years, salary, links, identity, work auth, CV context)
//   4. null             — caller parks it as "question for you" (asked once, remembered forever)
//
// When the agent derives an answer from the profile (step 2–3) it calls recordAgentAnswer()
// so the dashboard shows it in the "Agent answered" section.  The user can override any of
// those from the dashboard without being asked again mid-application.
//
// Everything personal comes from data/profile.json — nothing about the user is hardcoded here.
import { getProfile } from '../profile.js';
import { learnedAnswer, usedAnswer, recordAgentAnswer } from '../evolve.js';

/** Safe getter for profile.answers key. */
function ans(p, key, dflt = '') {
  const a = p.answers || {};
  return a[key] != null && a[key] !== '' ? String(a[key]) : dflt;
}

/** Approximate USD exchange rates for salary conversion. */
const FX = { usd: 1, eur: 0.92, gbp: 0.79, pkr: 280, inr: 84, aed: 3.67, cad: 1.37 };

/**
 * Convert profile.salary to the currency/period implied by the question.
 * @param {string} q   - lowercased question text
 * @param {object} p   - profile
 * @param {boolean} numeric - true = return only the number string
 * @returns {string|null}
 */
function salaryFor(q, p, numeric) {
  const s = p.salary || {};
  const base    = +s.amount || +ans(p, 'salary pkr monthly', 0) || 0;
  const baseCur = (s.currency || (ans(p, 'salary pkr monthly') ? 'pkr' : 'usd')).toLowerCase();
  const basePeriod = s.period || 'month';
  if (!base) return ans(p, 'salary', null) || (numeric ? null : 'Negotiable');

  const cur = Object.keys(FX).find(c => q.includes(c))
    || (/\$|dollar/.test(q) ? 'usd' : /€/.test(q) ? 'eur' : /£/.test(q) ? 'gbp'
      : /rupee|\brs\b/.test(q) ? (baseCur === 'inr' ? 'inr' : 'pkr') : baseCur);
  const period = /annual|yearly|per year|per annum|\/yr|\blpa\b|\bctc\b/.test(q) ? 'year'
    : /hour|hourly|\/hr/.test(q) ? 'hour' : 'month';

  let monthly = basePeriod === 'year' ? base / 12 : basePeriod === 'hour' ? base * 160 : base;
  monthly = monthly / FX[baseCur] * FX[cur];
  const v = period === 'year' ? monthly * 12 : period === 'hour' ? monthly / 160 : monthly;
  const r = cur === 'pkr' || cur === 'inr'
    ? Math.round(v / 1000) * 1000
    : period === 'hour' ? Math.round(v) : Math.round(v / 100) * 100;
  return String(r);
}

/**
 * Return the answer string for a free-text / numeric question, or null if unknown.
 * When a non-null answer is derived from the profile (not from evolution memory), it is
 * recorded via recordAgentAnswer() so the dashboard shows it in the "Agent answered" list.
 * @param {string} question
 * @param {object} [opts]
 * @param {boolean} [opts.numeric] - true = only return a parseable number string
 * @returns {string|null}
 */
export function textAnswer(question, { numeric = false } = {}) {
  const p = getProfile();
  const q = (question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const L = p.links || {};
  const [first, ...rest] = (p.name || '').split(' ');

  // 1. Evolution memory (user-taught or harvested) — highest trust
  const learned = learnedAnswer(question);
  if (learned != null && !(numeric && isNaN(parseFloat(learned)))) {
    usedAnswer(question);
    return learned;
  }

  // 2. profile.answers key overrides (multi-word fuzzy match)
  for (const [key, val] of Object.entries(p.answers || {})) {
    const words = key.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.every(w => q.includes(w)) && !/^(cover hook|hook)$/.test(key)) {
      const v = String(val);
      recordAgentAnswer(question, v, 'profile.answers override');
      return v;
    }
  }

  // 3. Rules derived from profile fields
  const years = ans(p, 'years of experience', p.yearsExperience ? String(p.yearsExperience) : '');
  let derived = null;
  let basis = '';

  if (/how many years|years of (work |professional )?experience|years experience|experience (do you have|in years)/.test(q)) {
    derived = years || null; basis = 'yearsExperience from profile';
  } else if (/salary|compensation|expected pay|pay expectation|\bctc\b|remuneration|\brate\b|expectation/.test(q)) {
    derived = salaryFor(q, p, numeric); basis = 'salary from profile';
  } else if (/first name|given name/.test(q)) {
    derived = p.firstName || first || null; basis = 'name from profile';
  } else if (/last name|surname|family name/.test(q)) {
    derived = p.lastName || rest.join(' ') || null; basis = 'name from profile';
  } else if (/full name|^name\b|your name|legal name/.test(q)) {
    derived = p.name || null; basis = 'name from profile';
  } else if (/e-?mail/.test(q)) {
    derived = p.email || null; basis = 'email from profile';
  } else if (/phone|mobile|contact number|whatsapp/.test(q)) {
    derived = numeric ? (p.phone || '').replace(/\D/g, '') : (p.phone || null);
    basis = 'phone from profile';
  } else if (/linkedin/.test(q)) {
    derived = L.linkedin || null; basis = 'linkedin from profile';
  } else if (/github/.test(q)) {
    derived = L.github || null; basis = 'github from profile';
  } else if (/portfolio|personal site|website|\burl\b/.test(q)) {
    derived = L.portfolio || L.website || L.github || null; basis = 'portfolio/links from profile';
  } else if (/\bcity\b|location|where.*(based|located)|address|country of residence/.test(q)) {
    derived = p.location || null; basis = 'location from profile';
  } else if (/country/.test(q)) {
    derived = p.country || (p.location || '').split(',').pop().trim() || null; basis = 'country from profile';
  } else if (/notice period|how soon|start date|when can you start|availability to start/.test(q)) {
    derived = numeric
      ? String(parseInt(ans(p, 'notice period', '14')) || 14)
      : ans(p, 'notice period', '2 weeks');
    basis = 'notice period from profile';
  } else if (/hours.*(week|per)/.test(q)) {
    derived = '40'; basis = 'standard 40h/week';
  } else if (/headline|current (title|role|position)|job title/.test(q)) {
    derived = p.headline || p.currentTitle || null; basis = 'headline from profile';
  } else if (/current (company|employer)|employer/.test(q)) {
    derived = p.currentCompany || null; basis = 'currentCompany from profile';
  } else if (/cover letter|why .*(apply|interested|join|us)|motivation|tell us|about yourself|summary|additional information|anything else/.test(q)) {
    derived = coverText(p); basis = 'generated from CV/projects/summary';
  } else if (numeric && /how many|number of|years/.test(q)) {
    derived = years || null; basis = 'yearsExperience from profile';
  }

  if (derived != null && String(derived).trim() !== '') {
    // Record that the agent answered this from profile context so user can see it
    recordAgentAnswer(question, derived, basis);
    return derived;
  }

  return null;
}

/**
 * Choose among options (radio/select). Returns the option text to pick, or null if unknown.
 * @param {string} question
 * @param {string[]} options
 * @returns {string|null}
 */
export function choiceAnswer(question, options) {
  const p = getProfile();
  const q = (question || '').toLowerCase();
  const opts = options.map(o => (o || '').trim()).filter(o => o && !/^select/i.test(o));
  if (!opts.length) return null;
  const find = re => opts.find(o => re.test(o.toLowerCase()));

  // 1. Evolution memory
  const learned = learnedAnswer(question);
  if (learned) {
    const m = opts.find(o => o.toLowerCase() === learned.toLowerCase())
      || opts.find(o => o.toLowerCase().startsWith(learned.toLowerCase()));
    if (m) { usedAnswer(question); return m; }
  }

  const yes = find(/^yes\b/), no = find(/^no\b/);
  const wa = (p.workAuth || {});
  const authIn = (wa.authorizedIn || [(p.location || '').split(',').pop().trim()])
    .map(s => s.toLowerCase()).filter(Boolean);

  let derived = null;
  let basis = '';

  if (yes && no) {
    if (/sponsor|visa/.test(q)) {
      derived = wa.needsSponsorship ? yes : no; basis = 'workAuth.needsSponsorship from profile';
    } else if (/relocat/.test(q)) {
      derived = wa.willingToRelocate ? yes : no; basis = 'workAuth.willingToRelocate from profile';
    } else if (/legally|authori[sz]ed|right to work|eligible to work|work permit/.test(q)) {
      derived = (authIn.some(c => q.includes(c)) || /remote|anywhere/.test(q) && !/(us|united states|uk|eu|canada)\b/.test(q))
        ? yes : no;
      basis = 'workAuth.authorizedIn from profile';
    } else if (/convicted|criminal|felony|non-?compete|related to anyone|previously (worked|employed)|currently employed by|been employed by/.test(q)) {
      derived = no; basis = 'standard no for legal screening questions';
    } else if (/background check|drug test|agree|consent|acknowledge|comfortable|willing|able to|can you|do you have|have you|did you|are you|familiar|experience|worked (with|on|in)|built|shipped|proficient/.test(q)) {
      derived = yes; basis = 'standard yes for consent/agreement questions';
    }
  } else if (/years/.test(q)) {
    const y = parseFloat(textAnswer('years of experience') || '0');
    derived = opts.find(o => { const m = o.match(/(\d+)\s*[-–to]+\s*(\d+)/); return m && y >= +m[1] && y <= +m[2]; })
      || opts.find(o => { const m = o.match(/(\d+)\s*\+/); return m && y >= +m[1]; })
      || opts[opts.length - 1];
    basis = 'yearsExperience from profile';
  } else if (/english|proficien/.test(q)) {
    derived = find(/native|bilingual|fluent|professional/) || opts[opts.length - 1];
    basis = 'default English proficiency';
  } else if (/gender|race|ethnic|veteran|disab|pronoun|sexual/.test(q)) {
    derived = find(/decline|prefer not|don.?t wish|not to|rather not/) || null;
    basis = 'prefer-not-to-say for demographic questions';
  } else if (/country|code/.test(q)) {
    const c = (p.country || (p.location || '').split(',').pop() || '').trim().toLowerCase();
    derived = c ? opts.find(o => o.toLowerCase().includes(c)) || null : null;
    basis = 'country from profile';
  } else if (/remote|work (type|arrangement)|workplace/.test(q)) {
    derived = find(/remote/) || null; basis = 'remote preference from profile';
  } else if (/hear about|source|how did you find/.test(q)) {
    derived = find(/linkedin/) || find(/job board|online|other/) || opts[0];
    basis = 'LinkedIn as application source';
  } else if (/notice/.test(q)) {
    derived = find(/2 weeks|two weeks|immediate|less than|1 month/) || opts[0];
    basis = 'notice period from profile';
  } else if (/degree|education|qualification/.test(q)) {
    derived = find(new RegExp((p.education || 'bachelor').split(' ')[0], 'i')) || find(/bachelor/) || null;
    basis = 'education from profile';
  }

  if (derived) {
    recordAgentAnswer(question, derived, basis);
    return derived;
  }
  return null;
}

/**
 * Generate a personalised cover text from profile fields and projects.
 * @param {object} [p] - profile (defaults to current)
 * @returns {string}
 */
export function coverText(p = getProfile()) {
  const hook = (p.answers || {})['cover hook'] || p.summary || p.extra || 'I build and ship production software end to end.';
  const proj = (p.projects || []).slice(0, 3).map(x => `${x.name} (${x.blurb})`).join('; ');
  const yrs   = textAnswer('years of experience');
  const skills = (p.skills || []).slice(0, 6).join(', ');
  return [
    hook,
    proj && `Recent work: ${proj}.`,
    (yrs || skills) && `${yrs ? yrs + '+ years' : 'Experience'}${skills ? ' across ' + skills : ''}.`,
    p.links?.portfolio && `Portfolio: ${p.links.portfolio}`,
    p.links?.github   && `GitHub: ${p.links.github}`,
  ].filter(Boolean).join(' ').slice(0, 1400);
}

/**
 * Suggest an answer for a pending question so the dashboard can pre-fill it.
 * Uses the same resolution chain as the agent, then falls back to free-form context.
 * @param {string} question
 * @param {string[]} [options]
 * @returns {{ value: string, basis: string }}
 */
export function recommendAnswer(question, options = []) {
  const p = getProfile();
  const q = (question || '').toLowerCase();

  if (Array.isArray(options) && options.length) {
    const c = choiceAnswer(question, options);
    return c ? { value: c, basis: 'suggested from your profile' } : { value: '', basis: '' };
  }

  const t = textAnswer(question);
  if (t != null && t !== '') return { value: String(t), basis: 'from your profile' };

  if (/why|motivat|interest|about yourself|cover|summary|tell us|describe|experience with|how would/i.test(q)) {
    return { value: coverText(p), basis: 'drafted from your projects + summary (edit before sending)' };
  }
  if (p.extra) return { value: p.extra.slice(0, 300), basis: 'from the free-form info you provided' };
  return { value: '', basis: '' };
}
