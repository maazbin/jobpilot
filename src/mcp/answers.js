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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Approximate USD exchange rates for salary conversion. */
const FX = { usd: 1, eur: 0.92, gbp: 0.79, pkr: 280, inr: 84, aed: 3.67, sar: 3.75, qar: 3.64, cad: 1.37 };

const CURRENT_SALARY_RE = /\b(current|present|existing|currently\s+(earn|make)|current\s+(pay|salary|compensation))\b|were you (making|earning|paid)|previous (role|job).*(salary|pay|making)|last drawn|present ctc/;

// Detect the currency a salary question asks for. DEFAULT is PKR (the user's home market) —
// only switch to another currency when the question explicitly names it (USD/$/dollar, etc.).
// This is why a bare "What is your desired salary?" must map to PKR, not USD.
function requestedCurrency(q, fallback = 'pkr') {
  if (/\busd\b|us ?dollar|u\.s\. ?dollar|\$/.test(q)) return 'usd';
  if (/€|\beur\b|euro/.test(q)) return 'eur';
  if (/£|\bgbp\b|pound/.test(q)) return 'gbp';
  if (/\binr\b|\brupees? \(india\)|indian rupee/.test(q)) return 'inr';
  if (/\baed\b|dirham/.test(q)) return 'aed';
  if (/\bsar\b|saudi riyal/.test(q)) return 'sar';
  if (/\bqar\b|qatari riyal/.test(q)) return 'qar';
  if (/\bcad\b|canadian/.test(q)) return 'cad';
  const named = Object.keys(FX).find(c => new RegExp(`\\b${c}\\b`).test(q));
  if (named) return named;
  if (/\bpkr\b|rupee|\brs\b|pakistan/.test(q)) return 'pkr';
  return fallback; // PKR by default
}

function requestedPeriod(q, fallback = 'month') {
  return /annual|yearly|per year|per annum|\/yr|\blpa\b|\bctc\b/.test(q) ? 'year'
    : /hour|hourly|\/hr/.test(q) ? 'hour' : fallback;
}

// Pick the salaryExpectations entry matching the requested currency; fall back to the PKR
// entry, then any entry, then the legacy single salary. Returns the entry plus the resolved
// currency so the caller never guesses.
function salaryExpectation(p, q) {
  const wantCurrent = CURRENT_SALARY_RE.test(q);
  const cur = requestedCurrency(q, 'pkr');
  const entries = Array.isArray(p.salaryExpectations)
    ? p.salaryExpectations.filter(x => x && (+x.min || +x.max || +x.current || +x.amount)) : [];

  // Prefer an entry whose currency matches the question's currency.
  let selected = entries.find(x => String(x.currency || '').toLowerCase() === cur)
    || entries.find(x => String(x.currency || '').toLowerCase() === 'pkr')
    || entries[0];

  // Fall back to the legacy single salary / currentSalary objects.
  if (!selected) {
    const legacy = p.salary || {};
    const current = p.currentSalary || {};
    const base = wantCurrent && current.amount ? current : legacy;
    if (!base || !(base.amount || base.min)) return null;
    selected = { currency: base.currency || 'pkr', period: base.period || 'month', min: +base.amount || +base.min || 0, max: +base.max || +base.amount || 0, current: +current.amount || +base.amount || 0 };
  }

  const period = selected.period || 'month';
  const min = +selected.min || +selected.max || +selected.amount || 0;
  const max = +selected.max || +selected.min || +selected.amount || 0;
  const currentVal = +selected.current || +((p.currentSalary || {}).amount) || 0;
  return {
    currency: String(selected.currency || cur || 'pkr').toLowerCase(),
    period,
    min, max,
    // When the question asks for CURRENT pay, surface the current figure as the value.
    value: wantCurrent ? (currentVal || min) : (min || currentVal),
    isCurrent: wantCurrent,
  };
}

function formatSalaryValue(value, currency, period) {
  return currency === 'pkr' || currency === 'inr'
    ? Math.round(value / 1000) * 1000
    : period === 'hour' ? Math.round(value) : Math.round(value / 100) * 100;
}

/**
 * Convert profile.salary to the currency/period implied by the question.
 * @param {string} q   - lowercased question text
 * @param {object} p   - profile
 * @param {boolean} numeric - true = return only the number string
 * @returns {string|null}
 */
export function salaryFor(q, p, numeric = false) {
  q = String(q || '').toLowerCase();
  const s = salaryExpectation(p, q);
  if (!s) return numeric ? null : 'Negotiable';

  const baseCur = s.currency;                 // currency the stored figure is in
  const cur = requestedCurrency(q, baseCur);   // currency the QUESTION wants (stored currency default)
  const period = requestedPeriod(q, s.period || 'month');
  const basePeriod = s.period || 'month';
  const toMonthly = v => basePeriod === 'year' ? v / 12 : basePeriod === 'hour' ? v * 160 : v;
  const fromMonthly = v => period === 'year' ? v * 12 : period === 'hour' ? v / 160 : v;
  // Convert from the stored currency to the requested currency via the USD table. When the
  // question does not name a different currency, baseCur === cur and the factor is exactly 1 —
  // so a PKR-stored / PKR-asked figure is NEVER multiplied (that FX hop produced the 56,000,000
  // garbage: 200000 / FX.usd * FX.pkr). Real cross-currency questions keep the same ratio.
  const fxFactor = baseCur === cur ? 1 : (FX[cur] || 1) / (FX[baseCur] || 1);
  const convert = v => formatSalaryValue(fromMonthly(toMonthly(v) * fxFactor), cur, period);

  // Guardrail: a salary answer can never exceed ~50× the stored monthly-equivalent expectation
  // (converted to the same currency/period). If a stray FX hop ever yields an implausible
  // magnitude, fall back to the direct no-FX figure instead of emitting an 8-digit number.
  const expected = s.value || s.min || s.max || 0;
  const sane = v => {
    const band = formatSalaryValue(fromMonthly(toMonthly(expected)) * fxFactor, cur, period);
    return band > 0 && v > band * 50 ? band : v;
  };

  // Current-pay questions → single current figure. Expected → min (numeric) or min-max range.
  if (s.isCurrent) return String(sane(convert(s.value || s.min || 0)));
  const min = sane(convert(s.min || s.value || 0));
  const max = sane(convert(s.max || s.min || 0));
  return numeric ? String(min) : (min === max ? String(min) : `${min}-${max}`);
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

  // 0. GENERIC "how many years of experience" questions: always answer from the profile's
  //    yearsExperience, BEFORE any fuzzy learned-answer lookup. Fuzzy matching across the
  //    many harvested "how many years of X" entries (some 0/1/2 for techs the user hasn't
  //    used) was leaking a wrong low number into unrelated role-experience questions.
  //    Only skip this shortcut when the question names a SPECIFIC technology that the user
  //    has an explicit per-tech answer for (those are handled by the normal learned lookup).
  const yrsProfile = p.yearsExperience ? String(p.yearsExperience) : '';
  const isGenericYears = /\bhow many years?\b|\byears? of (hands-on |professional |work |commercial |relevant |overall |total )*(experience|exp)\b/i.test(q)
    && !/\b(with|in)\s+[a-z]/i.test(q.replace(/years? of (hands-on|professional|work|commercial|relevant|overall|total)/gi, ''));
  if (yrsProfile && isGenericYears) {
    recordAgentAnswer(question, yrsProfile, 'yearsExperience from profile (generic years question)');
    return yrsProfile;
  }

  // 0b. SALARY/compensation questions: route straight to the deterministic, currency-aware
  //     salaryFor() — the single source of truth — before any learned/profile-answer override
  //     (those were storing verbose strings like "280,000 PKR/month (negotiable)" that don't
  //     fit numeric fields or respect the question's currency).
  if (/salary|compensation|\bctc\b|expected pay|pay expectation|financial expectations?|monthly gross|gross monthly|remuneration|were you making|desired (pay|salary)|current (pay|salary)/.test(q)) {
    const sal = salaryFor(question, p, numeric);
    if (sal != null && sal !== '') { recordAgentAnswer(question, sal, 'currency-aware salaryFor'); return sal; }
  }

  // LinkedIn sometimes asks for notice period as a numeric day count. Do this before
  // evolution memory so an older human-readable answer like "2 weeks" cannot leak into
  // a numeric-only field.
  if (/notice period[^?]*\bdays?\b/.test(q)) {
    const days = String(parseInt(ans(p, 'notice period', '14')) || 14);
    recordAgentAnswer(question, days, 'notice period from profile (days)');
    return days;
  }

  // 1. Evolution memory (user-taught or harvested) — highest trust.
  //    Guard: never accept a numeric '0' from a HARVESTED answer for a years question — that is
  //    almost always a different tech harvested as 0 that fuzzy-matched. User-set 0 is kept.
  const learned = learnedAnswer(question);
  if (learned != null && !(numeric && isNaN(parseFloat(learned)))) {
    const badHarvestedZero = numeric && /year/i.test(q) && parseFloat(learned) === 0;
    if (!badHarvestedZero) { usedAnswer(question); return learned; }
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
  } else if (/salary|compensation|expected pay|pay expectation|financial expectations?|monthly gross|gross monthly|\bctc\b|remuneration|\brate\b|expectation/.test(q)) {
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
    const daysOnly = /notice period[^?]*\bdays?\b/.test(q);
    derived = numeric || daysOnly
      ? String(parseInt(ans(p, 'notice period', '14')) || 14)
      : ans(p, 'notice period', '2 weeks');
    basis = daysOnly ? 'notice period from profile (days)' : 'notice period from profile';
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

  // Last resort for OPEN-ENDED free-text screening questions (non-numeric only).
  // Rather than parking a genuine, relevant application as needs_answers because the
  // question is open-ended ("how have you...", "describe...", "list the tools...",
  // "experience with..."), generate a concise, profile-grounded answer. This is the
  // single biggest reason target-role Easy Applies stalled instead of submitting.
  if (!numeric && q.length > 10) {
    // Yes/No-phrased questions rendered as FREE TEXT ("Have you built ...?", "Do you have
    // experience ...?"): a plain "Yes" is correct and fits tight character limits. Checked
    // BEFORE the open-ended gate so phrasings like "have you built" aren't missed.
    if (/^(do|have|are|can|did|were|is|was) (you|your)\b/.test(q) && /\?|experience|worked|built|familiar|comfortable|able|ever/.test(q)) {
      recordAgentAnswer(question, 'Yes', 'standard yes for yes/no-phrased free-text question');
      return 'Yes';
    }
    const openEnded = /\b(describe|explain|how (have|did|do|would|many) you|tell us|list( all)?|what (other )?(tools|languages?|technologies|frameworks|platforms|software)|which (tools|languages?|technologies)|experience (with|in|building|scaling)|walk us through|give an example|elaborate|briefly|what is your|what are your|why )/.test(q);
    if (openEnded) {
      let v = null; let b = 'profile-grounded open-ended answer';
      if (/\b(language|languages)\b/.test(q) && /proficien|speak|business|fluent|other/.test(q)) {
        // Spoken/business languages, not programming.
        v = ans(p, 'languages', '') || ans(p, 'spoken languages', '') || 'English (professional/fluent) and Urdu (native).';
        b = 'spoken languages';
      } else if (/\b(tools|software|platforms|technologies|frameworks|stack|tech)\b/.test(q)) {
        v = `${(p.skills || []).join(', ')}.`.trim();
        b = 'skills list from profile';
      } else {
        // General technical/behavioral prose grounded in skills + projects + summary.
        v = coverText(p);
        b = 'generated from CV/projects/summary';
      }
      if (v && String(v).trim()) {
        v = String(v).slice(0, 1400);
        recordAgentAnswer(question, v, b);
        return v;
      }
    }
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
    } else if (/background check|drug test|agree|consent|acknowledge|comfortable|willing|able to|can you|do you have|have you|did you|are you|familiar|experience|worked (with|on|in)|built|shipped|proficient|startup|fast.?paced|agile|environment/.test(q)) {
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
  } else if (/gender|race|ethnic|veteran|disab|pronoun|sexual|non.?binary|prefer to self.?describe/.test(q)) {
    const profileGender = ans(p, 'gender', p.gender || '');
    derived = profileGender
      ? find(new RegExp(`^${escapeRegExp(profileGender)}$`, 'i')) || find(new RegExp(escapeRegExp(profileGender), 'i'))
      : find(/decline|prefer not|don.?t wish|not to|rather not/);
    basis = profileGender ? 'gender from profile' : 'prefer-not-to-say for demographic questions';
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
