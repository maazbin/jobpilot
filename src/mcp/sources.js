// src/mcp/sources.js — Lead sources, FRESHEST FIRST. Every lead carries posted_at (ISO) so
// queues can be sorted newest-first, and a `channel` (email > easy_apply > form > connect).
//   liPosts      — LinkedIn hiring posts (past-24h, date-sorted) → emails / forms / poster
//   liJobs       — LinkedIn job listings (past-24h, remote, worldwide + PK), Easy Apply flag
//   hnHiring     — latest HN "Who is hiring?" thread, comments with emails, newest first
//   redditHiring — r/forhire, r/remotejs, r/jobbit … [Hiring] posts with emails
//   publicBoards — remoteok / remotive / himalayas / jobicy (email in description if any)
import fetch from 'node-fetch';
import { getContext } from '../agent/browser.js';
import { getProfile, excludedCompanyMatch } from '../profile.js';
import { isBadEmail } from '../tracker.js';

// Which leads stay in the queue.
// Keep a remote role with no country allow-list (a timezone overlap is fine),
// or a role that offers visa sponsorship or relocation in a place this profile lists.
// Onsite and hybrid need that offer. "No sponsorship" is not an offer.
// Missing preferences.keepRemoteOrVisa means the filter is on.
const REFUSAL = /\b(?:no (?:visa )?sponsorship|not able to offer relocation|unable to (?:provide |offer )?(?:visa )?sponsorship|(?:do not|don't|cannot|can't|will not|won't) (?:offer |provide )?(?:visa )?sponsor(?:ship)?|sponsorship (?:is )?(?:not|isn't) (?:available|provided|offered))\b/i;
const OFFER = /\b(?:visa sponsorship|sponsorship (?:available|provided|offered)|will sponsor|we sponsor|relocation (?:assistance|package|support|provided|offered)|able to offer relocation|work permit (?:provided|sponsored))\b/i;
const REMOTE = /\b(?:remote|work from anywhere|anywhere in the world|worldwide|fully remote|100%\s*remote)\b/i;
const ONSITE = /\b(?:onsite|on-site|hybrid|in[- ]office|work from (?:the )?office)\b/i;
const TZ = /\b(?:time\s*zones?|timezones?|hours|overlap|cet|cest|est|edt|pst|pdt|gmt|utc)\b/i;
const LOCK_REGION = /\b(?:u\.?s\.?a?|united states|uk|u\.k\.|united kingdom|eu|europe|european union|emea|latam|latin america|canada|india|brazil|australia|germany|france|spain|singapore|hong kong)\b/i;
const OPEN_WORDS = /\b(?:worldwide|anywhere|global|any country)\b/i;

export function keepRemoteOrVisaEnabled(profile = {}) {
  return profile?.preferences?.keepRemoteOrVisa !== false;
}

function placeHit(text, place) {
  const escaped = String(place).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i').test(text);
}

// Indian cities that imply the lead is in India even when "India" isn't spelled out.
const INDIA_CITIES = /\b(bengaluru|bangalore|mumbai|delhi|new delhi|hyderabad|pune|chennai|noida|gurgaon|gurugram|kolkata|ahmedabad|jaipur)\b/i;

/** True when a lead is in a HARD-EXCLUDED country (India by default). Data-driven via
 *  preferences.excludeCountries, with an India-city safety net so it fires even if the
 *  profile key is absent. Country tokens are word-bounded (placeHit) so the 2-letter
 *  token "in" never matches inside "infrastructure"/"linkedin"/company names. */
export function indiaBlocked(text = '', profile = {}) {
  const slice = String(text || '');
  if (!slice) return false;
  const ex = (profile?.preferences?.excludeCountries || ['india'])
    .map(s => String(s).toLowerCase().trim()).filter(Boolean);
  if (INDIA_CITIES.test(slice)) return true;
  if (/\bindia only\b/i.test(slice)) return true;
  return ex.some(token => placeHit(slice, token));
}

function listedOffer(text, profile) {
  if (!OFFER.test(text) || REFUSAL.test(text)) return false;
  const places = (profile?.preferences?.locations || []).map(s => String(s).trim()).filter(s => s.length >= 2);
  if (!places.length) return true;
  return places.some(place => placeHit(text, place));
}

export function countryLocked(text = '') {
  const lc = String(text).toLowerCase();
  if (/\b(?:us|u\.s\.|usa|uk|eu|emea|latam)[-\s]+only\b/.test(lc)) return true;
  if (/\b(?:citizens?|residents?)\s+only\b/.test(lc) && LOCK_REGION.test(lc)) return true;
  if (/\bmust (?:be |already )?(?:located|based|reside|live)[^.]{0,40}\b(?:us|usa|uk|eu|canada|india|europe)\b/.test(lc)) return true;
  if (/\bremote\s+(?:in|from|within)\s+(?:the\s+)?(?:us|usa|uk|eu|emea|latam|canada|india)\b/.test(lc)) return true;
  // "Remote - US" is a country list. "Remote, US timezones" is an overlap, not a list.
  if (/\bremote\s*[-–—:,]\s*(?:the\s+)?(?:us|u\.s\.|usa|united states|uk|u\.k\.|eu|europe|canada|india)\b(?!\s*(?:time\s*zones?|timezones?|hours|overlap))/.test(lc)) return true;
  const parens = [...lc.matchAll(/\bremote\b[^.\n]{0,40}\(([^)]{1,60})\)/g)].map(m => m[1]);
  for (const inside of parens) {
    if (OPEN_WORDS.test(inside)) continue;
    if (TZ.test(inside)) continue;
    if (LOCK_REGION.test(inside)) return true;
  }
  return false;
}

// A role that REQUIRES US citizenship / clearance / US work authorization — expressed as prose,
// not a "US-only" location tag — must be skipped when the profile has no matching work auth.
// This is separate from countryLocked() (a geographic allow-list) so the two concerns stay
// readable. It never fires on timezone-overlap wording, so worldwide-remote roles are safe.
const CITIZENSHIP_REQ = /\b(?:u\.?s\.?|united states)\s+citizens?(?:hip)?\s+(?:required|only|is required|a requirement)\b|\ball employees?\s+(?:are|must be)\s+u\.?s\.?\s+citizens?\b|\b(?:must be|be)\s+a\s+u\.?s\.?\s+citizen\b|\bcitizenship\s+(?:is\s+)?required\b|\bfederal contractor\b|\bsecurity clearance\b|\bmust (?:be )?(?:able to )?(?:legally )?(?:work|authorized to work) (?:in|within) (?:the )?(?:us|u\.s\.|usa|united states)\b|\bmust have work authorization\b|\brequires? (?:us|u\.s\.|united states) work authorization\b/i;

// Fallback-region tokens, matched word-bounded via placeHit, used only for ORDERING (never
// keep/skip). UAE/Saudi rank above US; PK (from preferences.locations) ranks above both.
const UAE_SAUDI = /\b(?:uae|united arab emirates|dubai|abu dhabi|saudi|ksa|riyadh|jeddah)\b/i;
const US_TOKENS = /\b(?:united states|usa|us)\b/i;

/** Small additive relevance bonus so PK leads rank first, then UAE/Saudi, then US.
 *  Purely a tie-breaker — it never flips keep/skip. */
function geoPriority(text = '', profile = {}) {
  const slice = String(text || '');
  const locs = (profile?.preferences?.locations || []).map(s => String(s).trim()).filter(s => s.length >= 2);
  if (locs.some(loc => placeHit(slice, loc))) return 0.15;
  if (UAE_SAUDI.test(slice)) return 0.10;
  if (US_TOKENS.test(slice)) return 0.05;
  return 0;
}

/** True when the text requires citizenship/work-authorization the profile does not hold. */
export function authLocked(text = '', profile = {}) {
  if (!CITIZENSHIP_REQ.test(String(text))) return false;
  const authIn = (profile?.workAuth?.authorizedIn || []).map(s => String(s).toLowerCase());
  // The detector is US-focused; keep the lead only if the profile is US-authorized.
  return !authIn.some(c => /\b(?:us|u\.s\.|usa|united states)\b/.test(c));
}

/** @returns {{ keep: boolean, why: string }} */
export function leadKeep(text = '', profile = {}) {
  // Hard country-exclusion runs FIRST — before the keepRemoteOrVisa shortcut — so an
  // excluded-country lead (India by default) is dropped regardless of the keep switch.
  if (indiaBlocked(String(text || ''), profile)) return { keep: false, why: 'excluded: India' };
  if (!keepRemoteOrVisaEnabled(profile)) return { keep: true, why: '' };
  const slice = String(text || '').slice(0, 2500);
  const remote = REMOTE.test(slice);
  const locked = countryLocked(slice);
  const offer = listedOffer(slice, profile);
  const authReq = authLocked(slice, profile);
  // A citizenship / work-authorization requirement the profile cannot meet is a hard skip,
  // even when the post says "remote" — unless a genuine visa/relocation OFFER in a listed place
  // overrides it. Checked before the remote shortcut so "Remote. US citizens only." is rejected.
  if (authReq && !offer) return { keep: false, why: 'requires citizenship/work authorization the profile does not have' };
  if (remote && !locked) return { keep: true, why: '' };
  if (offer) return { keep: true, why: '' };
  if (locked) return { keep: false, why: 'remote is limited to a country list' };
  if (ONSITE.test(slice)) return { keep: false, why: 'onsite or hybrid without visa or relocation in a listed place' };
  return { keep: true, why: '' };
}

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36';
const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
// 2-letter ccTLDs + common gTLDs; rejects "name@first.last" false positives
const TLD_OK = /\.([a-z]{2}|com|net|org|io|ai|dev|app|tech|xyz|run|info|biz|cloud|group|studio|energy|health|works|agency|systems|digital|solutions|global|ventures|careers|jobs|team|today|software|email|codes|inc|llc|company|network|labs|finance|capital|world|media|design|tools|games|space|site|online|pro|so|sh|gg|me)$/;

export function emailsIn(text = '', { needContext = false } = {}) {
  const deob = text.replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, '@').replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, '.');
  const found = [...new Set((deob.match(EMAIL_RE) || []).map(e => e.replace(/\.$/, '').toLowerCase()))].filter(e => !isBadEmail(e) && TLD_OK.test(e));
  if (!needContext) return found;
  // boards: only addresses that sit next to an apply instruction (not HR/legal boilerplate)
  return found.filter(e => { const i = deob.toLowerCase().indexOf(e); const ctx = deob.slice(Math.max(0, i - 160), i).toLowerCase(); return /apply|cv|resume|send|email (us|me)|reach out|interested|application|to:|contact/.test(ctx) && !/accommodat|disabilit|privacy|eeo|equal opportunity|questions about/.test(ctx); });
}

/** "3h", "20 minutes ago", "1 day ago", "2w", "1mo" → ISO */
export function relToIso(s = '') {
  const m = String(s).toLowerCase().match(/(\d+)\s*(s|sec|m(?!o)|min|minute|h|hr|hour|d|day|w|wk|week|mo|month|y|yr|year)s?\b/);
  if (!m) return '';
  const n = +m[1], u = m[2];
  const sec = /^s/.test(u) ? 1 : /^(m|min|minute)$/.test(u) ? 60 : /^h/.test(u) ? 3600 : /^d/.test(u) ? 86400 : /^w/.test(u) ? 604800 : /^mo/.test(u) ? 2592000 : 31536000;
  return new Date(Date.now() - n * sec * 1000).toISOString();
}

export function detectPortal(url = '') {
  const u = url.toLowerCase();
  for (const k of ['greenhouse', 'lever.co', 'ashbyhq', 'workable', 'workday', 'smartrecruiters', 'breezy', 'recruitee', 'bamboohr', 'jobvite', 'teamtailor', 'rippling', 'personio', 'linkedin', 'google.com/forms', 'forms.gle', 'typeform', 'tally.so'])
    if (u.includes(k)) return k.replace('.co', '').replace('google.com/forms', 'gform').replace('forms.gle', 'gform');
  return 'other';
}
const FORM_RE = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|breezy|recruitee|bamboohr|jobvite|teamtailor|rippling|personio|forms\.gle|docs\.google\.com\/forms|typeform|tally\.so|\/careers?\/|\/jobs?\//i;

/** Relevance 0..1 + hard skip. Title drives it (the full text has every buzzword).
 *  Returns {rel, skip, why}. Optional profile is for tests; callers use the saved profile. */
const CV_TITLE = /\b(devops|site reliability|sre|cloud|platform|infrastructure|solutions? architect|cloud architect|kubernetes|terraform)\b/i;
const NON_CV_TITLE = /\b(ai|a\.i\.|ml|machine learning|llm|gen ?ai|generative|nlp|rag|agent(ic)?|data scientist|data engineer|analytics|backend|back[- ]end|full[- ]?stack|software engineer|frontend|front[- ]end|developer|application engineer|product engineer|project manager|manager|director|vp|head of|chief|course|training|certification|tutorial|bootcamp|class)\b/i;
const OFF_STACK = /\b(java(?!script)|\.net|c#|ruby|rails|rust|golang|ios|android|swift|kotlin|flutter|php|wordpress|shopify|salesforce|sap|servicenow|qa|test(er|ing)?|quality|sdet|manager|director|vp|head of|chief|designer|sales|marketing|support|analyst|embedded|firmware|hardware|mechanical|electrical|civil|network engineer|security engineer|unity|game|blockchain|solidity|mainframe|cobol|angular|react native|frontend|front[- ]end)\b/i;
const GEO_LOCK = /\b(us|u\.s\.|usa|united states|uk|eu|europe|canada|india|brazil|br|latam|germany|australia)[- ]?(only|based only|residents? only|citizens? only)\b|\bmust (be|reside|live) (located |based )?in (the )?(us|usa|united states|uk|eu|canada|india)\b|\b(remote|hybrid)\s*\([^)]*\b(tx|md|in|ca|ny|wa|ma|va|fl|nj|il|ga|co|az|or|ut|dc)\b[^)]*\)|\b(remote|hybrid)\s*\(?(?:u\.?s\.?|usa|united states)\)?|\b100%\s+remote\s*\(?(?:u\.?s\.?|usa|united states)\)?|\b(onsite|on-site|work from office|wfo|hybrid)\b(?![^.]{0,40}remote)|\bus citizen|security clearance|\bh1b\b|\bvisa sponsorship\b|\bsponsorship required\b|\bmust have work authorization\b|(?:us|u\.s\.|united states)\s+(?:citizens?|nationals?|permanent residents?|green card holders?|ead holders?)|\bgreen card holders?\b|\bead holders?\b|\b(?:unable|cannot|can\'t) sponsor\b|\bno sponsorship\b|\bsponsorship (?:is )?(?:not|isn\'t) (?:available|provided|offered)\b|\bw-?2\b/i;
export function score(text = '', title = '', profile) {
  const p = profile || getProfile();
  const t = text.toLowerCase();
  // Hard country-exclusion first — India (or any excludeCountries token) is rejected
  // regardless of keepRemoteOrVisa, before any relevance/keep logic runs.
  if (indiaBlocked(`${title || ''}\n${text || ''}`, p)) return { rel: 0, skip: true, why: 'excluded: India' };
  const excluded = excludedCompanyMatch(text, p);
  // CRITICAL: skip-term and off-stack checks must ONLY fire on the job TITLE, never the
  // description. "Backend Engineer" was being skipped because the post body mentioned
  // "sales team" or "QA process" in an unrelated context.
  const titleOnly = (title || '').toLowerCase().trim();
  const head = titleOnly || text.slice(0, 100).split('\n')[0].toLowerCase(); // first line as fallback
  const skipHit = titleOnly
    ? (p.preferences?.skip || []).find(s => new RegExp(`\\b${s}\\b`, 'i').test(titleOnly))
    : null; // no clean title → never skip based on description content
  const terms = new Set([...(p.skills || []), ...(p.preferences?.keywords || [])].map(s => s.toLowerCase()));
  // A configured target role (Backend Engineer, AI Engineer, …) is aligned. The old rule
  // required a DevOps-only title and treated "software engineer" / "AI" as not-the-CV,
  // so those emails were skipped before anyone could send them.
  const headGlued = head.replace(/[^a-z0-9]+/g, '');
  const roleHit = (p.preferences?.roles || []).some(role => {
    const key = String(role || '').toLowerCase().trim();
    if (key.length < 3) return false;
    const glued = key.replace(/[^a-z0-9]+/g, '');
    return head.includes(key) || (glued.length > 3 && headGlued.includes(glued));
  });
  const core = roleHit || (CV_TITLE.test(head) && !NON_CV_TITLE.test(head));
  const offStack = OFF_STACK.test(head) && !/\b(python|ai|ml|llm|fastapi|django)\b/.test(head);
  let hit = 0; for (const s of terms) if (t.includes(s)) hit++;
  const rel = Math.min(1, (core ? 0.45 : 0) + 0.55 * Math.min(1, hit / 6) + geoPriority(`${title}\n${text}`, p));
  // Junior check: title + first 120 chars of body only — not the full description.
  const tooJunior = /\b(freshers?|0\s*[-–]\s*[12]\s*(years|yrs)|entry[- ]level|internship|interns?\b|trainee|graduate program)\b/.test(titleOnly + ' ' + t.slice(0, 120));
  const equityOnly = /\b(co-?founder|cofondat|equity[- ]only|unpaid|sweat equity|no salary)\b/.test(t.slice(0, 700));
  // Relocation / visa-sponsorship preference: if the user is open to relocating (profile), then
  // "visa sponsorship" / "relocation" / a preferred region (Middle East, EU, …) is a POSITIVE
  // signal, not a geo-lock to skip. Only treat geo as a hard skip when the role is locked to a
  // region the user is NOT targeting AND no relocation/sponsorship is offered.
  let geoWhy = '';
  if (keepRemoteOrVisaEnabled(p)) {
    const decision = leadKeep(`${title || ''}\n${text || ''}`, p);
    geoWhy = decision.keep ? '' : decision.why;
  } else {
    // Switch off: previous rule. A preferred place or any visa/relocation line clears the lock.
    const prefLocs = (p.preferences?.locations || []).map(s => String(s).toLowerCase());
    const wantsRelo = p.workAuth?.willingToRelocate === true || prefLocs.length > 0;
    const head2500 = text.slice(0, 2500).toLowerCase();
    const offersReloOrSponsor = /\b(visa sponsorship|sponsorship (available|provided|offered)|relocation (assistance|package|support|provided|offered)|will sponsor|we sponsor|work permit (provided|sponsored))\b/.test(head2500);
    const inPrefRegion = prefLocs.some(loc => loc && head2500.includes(loc));
    const geoRaw = GEO_LOCK.test(text.slice(0, 2500));
    if (geoRaw && !(wantsRelo && (offersReloOrSponsor || inPrefRegion))) geoWhy = 'location-restricted / authorization';
  }
  const why = excluded ? `excluded company "${excluded}"` : skipHit ? `skip term "${skipHit}"` : !core ? 'title not aligned with CV target roles' : offStack ? 'off-stack title' : tooJunior ? 'junior/fresher' : equityOnly ? 'co-founder / equity-only' : geoWhy;
  return { rel: +rel.toFixed(2), skip: !!why, why };
}

function guessRole(text) {
  const m = text.match(/(?:hiring|looking for|seeking|need(?:ed)?|opening for|position[:\s]+|role[:\s]+)\s*(?:an?\s+|our\s+next\s+)?((?:senior|sr\.?|lead|staff|principal|mid[- ]level|founding)?\s*[A-Za-z/+.#\- ]{2,40}?(?:engineer|developer|architect|scientist|lead|specialist|manager))/i);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
function guessCompany(text) {
  const m = text.match(/(?:\bat|\@|join)\s+([A-Z][A-Za-z0-9&.\- ]{1,30}?)(?=\s+(?:is|are|we|as|to|in|for)\b|[,.!\n(|])/) || text.match(/^([A-Z][A-Za-z0-9&. ]{1,30}?) (?:is|are) hiring/m);
  return m ? m[1].trim() : '';
}

// ── LinkedIn hiring posts ─────────────────────────────────────────────────────
export async function liPosts(query, { maxScroll = 6, datePosted = 'past-24h' } = {}) {
  console.error('[scrape] liPosts: starting, query=' + query);
  let ctx;
  try { ctx = await getContext(); } catch (e) {
    console.error('[scrape] liPosts: getContext() failed:', e.message);
    return { ok: false, leads: [], detail: `browser error: ${e.message}` };
  }
  let page;
  try { page = await ctx.newPage(); } catch (e) {
    console.error('[scrape] liPosts: newPage() failed:', e.message);
    return { ok: false, leads: [], detail: `new page error: ${e.message}` };
  }
  page.setDefaultTimeout(30000);
  // LinkedIn's SDUI content-search strips the post's activity URN from the hydrated DOM, so the
  // only reliable source for each post's permalink is the raw search response. Collect the
  // distinct activity URNs in first-appearance order from every /search/results/content payload;
  // the posts render in that same order, so post[i] → netUrns[i] gives the real permalink.
  const netUrns = [];
  const seenUrn = new Set();
  page.on('response', async resp => {
    try {
      if (!/\/search\/results\/content/.test(resp.url())) return;
      const body = await resp.text().catch(() => '');
      if (!body || !/urn:li:activity:\d+/.test(body)) return;
      // Prefer fsd_update wrappers (one per rendered update); fall back to bare activity URNs.
      const re = /urn:li:fsd_update:\(urn:li:activity:(\d+),/g;
      let m, any = false;
      while ((m = re.exec(body))) { any = true; if (!seenUrn.has(m[1])) { seenUrn.add(m[1]); netUrns.push(m[1]); } }
      if (!any) for (const id of body.match(/urn:li:activity:(\d+)/g) || []) {
        const num = id.split(':').pop(); if (!seenUrn.has(num)) { seenUrn.add(num); netUrns.push(num); }
      }
    } catch { /* ignore */ }
  });
  try {
    const url = `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=%22date_posted%22&datePosted=%22${datePosted}%22`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(4000);
    if (/login|authwall|\/signup/.test(page.url())) {
      console.error('[scrape] liPosts: hit login/authwall — session not logged in (landed on ' + page.url().slice(0, 80) + ')');
      return { ok: false, leads: [], detail: 'LinkedIn not logged in (authwall) — log into LinkedIn in the debug Chrome window' };
    }
    for (let i = 0; i < maxScroll; i++) { await page.mouse.wheel(0, 2500); await SLEEP(900); }
    // expand truncated posts so hidden emails become visible
    await page.evaluate(() => [...document.querySelectorAll('button, span[role=button]')].filter(b => /^…?\s*more$|see more/i.test(b.innerText.trim())).forEach(b => b.click())).catch(() => {});
    await SLEEP(800);
    const raw = await page.evaluate(() => {
      const posts = [...document.querySelectorAll('div[componentkey*="FeedType"]')].filter(p => !p.parentElement.closest('div[componentkey*="FeedType"]'));
      return posts.map(p => {
        const actor = [...p.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find(a => a.innerText.trim());
        const txt = p.innerText.replace(/[ \t]+/g, ' ');
        const links = [...p.querySelectorAll('a[href]')].map(a => a.href);
        // Best-effort DOM activity id. SDUI search usually strips this (→ ''); when present it
        // comes from a /feed/update/ timestamp link, a data-urn/data-id attr, or inline HTML.
        const permaLink = [...p.querySelectorAll('a[href*="/feed/update/urn:li:activity:"], a[href*="/posts/"]')].map(a => a.href).find(Boolean) || '';
        const attrUrn = [p, ...p.querySelectorAll('[data-urn],[data-id]')].map(n => n.getAttribute?.('data-urn') || n.getAttribute?.('data-id') || '').find(v => /urn:li:activity:\d+/.test(v)) || '';
        const urn = (permaLink.match(/urn:li:activity:(\d+)/) || attrUrn.match(/urn:li:activity:(\d+)/) || p.innerHTML.match(/urn:li:activity:(\d+)/) || [])[1] || '';
        return { actorUrl: actor ? actor.href.split('?')[0] : '', actorName: actor ? actor.innerText.split('•')[0].split('\n')[0].trim() : '', txt: txt.slice(0, 4000), links, urn, key: p.getAttribute('componentkey') };
      });
    });
    // The hydrated DOM rarely carries the post's activity id, so backfill each post positionally
    // from the activity URNs captured off the raw search response (same render order as the cards).
    raw.forEach((r, i) => { if (!r.urn && netUrns[i]) r.urn = netUrns[i]; });
    console.error(`[scrape] liPosts: ${netUrns.length} activity URNs captured from network, ${raw.filter(r => r.urn).length}/${raw.length} posts have a permalink`);
    console.error(`[scrape] liPosts: ${raw.length} post containers found on page`);
    if (!raw.length) console.error('[scrape] liPosts: 0 posts — LinkedIn markup may have changed, the session is cold, or no results for this query/date window');
    const leads = [];
    let notHiring = 0, skipped = 0; // drop diagnostics
    for (const r of raw) {
      const text = r.txt;
      const time = (text.match(/\n\s*(\d+\s*(?:m|h|d|w|mo|yr))\s*[•·\n]/) || text.match(/\b(\d+\s*(?:m|h|d|w|mo))\s*•/) || [])[1] || '';
      const mailto = r.links.filter(h => h.startsWith('mailto:')).map(h => decodeURIComponent(h.slice(7).split('?')[0]).toLowerCase());
      const emails = [...new Set([...mailto, ...emailsIn(text)])].filter(e => !isBadEmail(e));
      const ext = r.links.map(h => { try { const u = new URL(h); return u.pathname.startsWith('/safety/go') ? decodeURIComponent(u.searchParams.get('url') || '') : h; } catch { return ''; } })
        .filter(h => h && !/linkedin\.com\/(in|company|feed|search|posts|safety)|^mailto:/.test(h));
      const jobUrl = (ext.find(h => /linkedin\.com\/jobs\/view\/\d+/.test(h)) || '').split('?')[0];
      const formUrl = ext.find(h => FORM_RE.test(h) && !/linkedin\.com/.test(h)) || ext.find(h => /lnkd\.in\//.test(h)) || '';
      const hiring = /hiring|looking for|we.?re seeking|open (role|position)|join (our|the) team|send (your )?(cv|resume)|apply|vacanc|opening/i.test(text);
      if (!hiring) { notHiring++; continue; }
      // body = post content after the author header ("… 3h • Follow/Connect")
      const cut = text.search(/\n\s*(Follow|Connect|Subscribe)\s*\n/);
      const bodyTxt = cut > 0 ? text.slice(cut).replace(/^\s*(Follow|Connect|Subscribe)\s*/, '') : text;
      const role = guessRole(bodyTxt);
      const s = score(bodyTxt, role);
      if (s.skip) skipped++;
      // postUrl = the FEED POST's own permalink (canonical /feed/update/urn:li:activity:<id>/).
      // Distinct from posterUrl (the author profile). comment_interested needs this URL to find
      // the comment box; a profile URL would fail with 'no_comment_box'.
      const postUrl = r.urn ? `https://www.linkedin.com/feed/update/urn:li:activity:${r.urn}/` : '';
      console.error(`[scrape] liPosts: post "${(role || query).slice(0, 40)}" — permalink ${postUrl ? `found (urn:li:activity:${r.urn})` : 'NOT found (no activity URN)'}`);
      const channel = emails[0] ? 'email' : jobUrl ? 'easy_apply' : formUrl ? 'form' : r.actorUrl.includes('/in/') ? 'connect' : 'none';
      leads.push({
        source: 'linkedin_post', company: guessCompany(bodyTxt), role: role || query.replace(/hiring|remote|email|send|share|cv|resume|dm me|urgent|we are/gi, '').replace(/\s+/g, ' ').trim(),
        url: postUrl || (emails[0] ? `email:${emails[0]}` : r.actorUrl + '#' + (r.key || '').slice(-12)),
        email: emails[0] || '', emails, applyUrl: jobUrl || formUrl, postUrl, posterUrl: r.actorUrl.includes('/in/') ? r.actorUrl : '', posterName: r.actorName,
        postedAt: relToIso(time), postedRaw: time, description: text.slice(0, 2000), channel,
        portal: emails[0] ? 'email' : jobUrl ? 'linkedin' : formUrl ? detectPortal(formUrl) : 'linkedin', relevance: s.rel, skip: s.skip, skipWhy: s.why, remote: /remote/i.test(text),
      });
    }
    const withEmail = leads.filter(l => l.email).length;
    const actionable = leads.filter(l => !l.skip).length;
    console.error(`[scrape] liPosts: ${raw.length} posts → ${leads.length} hiring leads (${notHiring} non-hiring dropped, ${skipped} flagged skip, ${actionable} actionable, ${withEmail} with email)`);
    return { ok: true, leads, detail: `${raw.length} posts → ${leads.length} hiring leads (${withEmail} with email, ${skipped} flagged skip)` };
  } catch (e) {
    console.error('[scrape] liPosts: error:', e.message);
    return { ok: false, leads: [], detail: e.message.slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}

// ── LinkedIn job listings (freshest) ─────────────────────────────────────────
// geo 92000000 = Worldwide. tpr seconds: 86400 = 24h.
export async function liJobs(query, { easyOnly = true, tpr = 86400, geoId = '92000000', pages = 2 } = {}) {
  console.error('[scrape] liJobs: starting, query=' + query);
  let ctx;
  try { ctx = await getContext(); } catch (e) {
    console.error('[scrape] liJobs: getContext() failed:', e.message);
    return { ok: false, leads: [], detail: `browser error: ${e.message}` };
  }
  let page;
  try { page = await ctx.newPage(); } catch (e) {
    console.error('[scrape] liJobs: newPage() failed:', e.message);
    return { ok: false, leads: [], detail: `new page error: ${e.message}` };
  }
  page.setDefaultTimeout(30000);
  const out = [];
  try {
    for (let pg = 0; pg < pages; pg++) {
      const u = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(query)}&f_WT=2${easyOnly ? '&f_AL=true' : ''}&f_TPR=r${tpr}&sortBy=DD${geoId ? '&geoId=' + geoId : ''}&start=${pg * 25}`;
      await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 40000 });
      await SLEEP(3500);
      // scroll the results list so all 25 cards render
      for (let i = 0; i < 8; i++) {
        await page.evaluate(() => { const li = document.querySelector('li[data-occludable-job-id]'); let s = li?.parentElement; while (s && s.scrollHeight <= s.clientHeight + 5) s = s.parentElement; (s || window).scrollBy?.(0, 900); }).catch(() => {});
        await SLEEP(500);
      }
      const cards = await page.$$eval('li[data-occludable-job-id]', ls => ls.map(l => {
        const t = l.innerText.split('\n').map(s => s.trim()).filter(Boolean);
        return { id: l.getAttribute('data-occludable-job-id'), lines: t, text: t.join(' | ') };
      })).catch(() => []);
      if (!cards.length) break;
      for (const c of cards) {
        const [title, company, location] = [c.lines[0], c.lines[1] === c.lines[0] ? c.lines[2] : c.lines[1], c.lines.find(l => /remote|\(|,/i.test(l)) || ''];
        const ago = (c.text.match(/(\d+\s+(?:minute|hour|day|week|month)s?\s+ago)/) || [])[1] || '';
        const s = score(`${title} ${company} ${location}`, title);
        out.push({
          source: easyOnly ? 'linkedin_easy' : 'linkedin_jobs', role: title, company, location, url: `https://www.linkedin.com/jobs/view/${c.id}/`, applyUrl: `https://www.linkedin.com/jobs/view/${c.id}/`,
          postedAt: relToIso(ago) || (/within the past 24/i.test(c.text) ? new Date(Date.now() - 12 * 3600e3).toISOString() : ''), postedRaw: ago,
          channel: /easy apply/i.test(c.text) ? 'easy_apply' : 'form', portal: 'linkedin', relevance: s.rel, skip: s.skip, skipWhy: s.why,
          alreadyApplied: /\bApplied\b/.test(c.text), remote: true,
        });
      }
      if (cards.length < 20) break;
    }
    const seen = new Set();
    const uniq = out.filter(j => !seen.has(j.url) && seen.add(j.url));
    console.error(`[scrape] liJobs: ${uniq.length} unique listings`);
    return { ok: true, leads: uniq, detail: `${uniq.length} listings` };
  } catch (e) {
    console.error('[scrape] liJobs: error:', e.message);
    return { ok: false, leads: out, detail: e.message.slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}

// ── Hacker News "Who is hiring?" (newest comments first, emails extracted) ───
export async function hnHiring({ maxAgeHours = 24 * 10 } = {}) {
  console.error('[scrape] hnHiring: fetching latest thread list');
  let s;
  try {
    const resp = await fetch('https://hn.algolia.com/api/v1/search_by_date?query=%22who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=3', { headers: { 'User-Agent': UA } });
    s = await resp.json();
  } catch (e) {
    console.error('[scrape] hnHiring: thread fetch failed:', e.message);
    return { ok: false, leads: [], detail: `thread fetch error: ${e.message}` };
  }
  const story = (s.hits || []).find(h => /who is hiring/i.test(h.title));
  if (!story) return { ok: false, leads: [], detail: 'no thread' };
  console.error(`[scrape] hnHiring: found "${story.title}" (id ${story.objectID})`);
  const since = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;
  const leads = [];
  let totalComments = 0, topLevel = 0, passedGeo = 0;
  for (let page = 0; page < 5; page++) {
    // BUG FIX: URL-encode the '>' in numericFilters — unencoded '>' broke Algolia filter parsing
    const apiUrl = `https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_${story.objectID}&numericFilters=created_at_i%3E${since}&hitsPerPage=200&page=${page}`;
    let r;
    try {
      r = await (await fetch(apiUrl, { headers: { 'User-Agent': UA } })).json();
    } catch (e) {
      console.error(`[scrape] hnHiring: page ${page} fetch failed:`, e.message);
      break;
    }
    const hits = r.hits || [];
    totalComments += hits.length;
    for (const c of hits) {
      if (c.parent_id != +story.objectID) continue; // top-level only = one company per comment
      topLevel++;
      const html = c.comment_text || '';
      const text = html.replace(/<p>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&#x2F;/g, '/').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
      // BUG FIX: removed hard "remote" requirement — many good HN posts don't say "remote"
      // but still accept worldwide applicants. Keep all top-level comments; only skip
      // geo-locked ones that explicitly restrict to US/EU/etc without worldwide/anywhere.
      const geoLocked = /\b(on[- ]?site|in[- ]?office)\s*only\b/i.test(text) && !/remote|worldwide|anywhere|global/i.test(text);
      const usOnly = /remote\s*\(?\s*(us|usa|u\.s\.|united states|us[- ]only|north america|eu only|uk only|canada)\b[^\n]{0,20}(only)?/i.test(text) && !/worldwide|anywhere|global/i.test(text);
      if (geoLocked || usOnly) continue;
      passedGeo++;
      const emails = emailsIn(text);
      const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&#x2F;/g, '/').replace(/&amp;/g, '&'));
      const form = links.find(l => FORM_RE.test(l)) || '';
      const head = text.split('\n')[0];
      const sc = score(text, head);
      leads.push({
        source: 'hn_hiring', company: head.split('|')[0].trim().slice(0, 60), role: (head.split('|').find(x => /engineer|developer|scientist/i.test(x)) || guessRole(text) || 'Software Engineer').trim().slice(0, 90),
        url: `https://news.ycombinator.com/item?id=${c.objectID}`, email: emails[0] || '', emails, applyUrl: form, description: text.slice(0, 2000),
        postedAt: new Date(c.created_at_i * 1000).toISOString(), channel: emails[0] ? 'email' : form ? 'form' : 'none', portal: emails[0] ? 'email' : detectPortal(form),
        relevance: sc.rel, skip: sc.skip, skipWhy: sc.why, remote: /remote/i.test(text),
      });
    }
    if ((r.nbPages || 0) <= page + 1) break;
  }
  console.error(`[scrape] hnHiring: ${totalComments} comments fetched, ${topLevel} top-level, ${passedGeo} passed geo filter, ${leads.length} leads (${leads.filter(l => l.email).length} email, ${leads.filter(l => l.applyUrl).length} form)`);
  return { ok: true, leads, detail: `HN "${story.title}": ${leads.length} leads (${leads.filter(l => l.email).length} email)` };
}

// ── Reddit hiring posts (public JSON, newest first) ──────────────────────────
export async function redditHiring({ subs = ['forhire', 'remotejs', 'jobbit', 'PythonJobs', 'MachineLearningJobs', 'hiring', 'RemoteJobs'], maxAgeHours = 72 } = {}) {
  console.error('[scrape] redditHiring: starting');
  const leads = []; const since = Date.now() / 1000 - maxAgeHours * 3600;
  // Reddit 403s non-browser clients → fetch the JSON from inside the user's Chrome.
  let ctx;
  try { ctx = await getContext(); } catch (e) {
    console.error('[scrape] redditHiring: getContext() failed:', e.message);
    return { ok: false, leads: [], detail: `browser error: ${e.message}` };
  }
  let page;
  try { page = await ctx.newPage(); } catch (e) {
    console.error('[scrape] redditHiring: newPage() failed:', e.message);
    return { ok: false, leads: [], detail: `new page error: ${e.message}` };
  }
  try {
  await page.goto('https://www.reddit.com/r/forhire/new/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await SLEEP(6000); // reddit does a client-side redirect/bot check before same-origin fetch works
  for (const sub of subs) {
    try {
      const j = await page.evaluate(async s => { const r = await fetch(`/r/${s}/new.json?limit=50&raw_json=1`); return r.ok ? r.json() : null; }, sub).catch(() => null);
      if (!j) { console.error(`[scrape] redditHiring: r/${sub} returned null`); continue; }
      let subCount = 0;
      for (const { data: d } of j.data?.children || []) {
        if (d.created_utc < since) continue;
        const title = d.title || '';
        if (!/\bhiring\b/i.test(title)) continue;
        if (/\[for hire\]/i.test(title)) continue;
        const text = `${title}\n${d.selftext || ''}`;
        const sc = score(text, title);
        const emails = emailsIn(text);
        const form = (text.match(/https?:\/\/[^\s)\]]+/g) || []).find(l => FORM_RE.test(l)) || '';
        leads.push({
          source: `reddit_${sub}`, company: guessCompany(text) || `r/${sub}`, role: guessRole(title) || title.replace(/\[[^\]]*\]/g, '').trim().slice(0, 90),
          url: `https://www.reddit.com${d.permalink}`, email: emails[0] || '', emails, applyUrl: form, description: text.slice(0, 2000),
          postedAt: new Date(d.created_utc * 1000).toISOString(), channel: emails[0] ? 'email' : form ? 'form' : 'none', portal: emails[0] ? 'email' : detectPortal(form),
          relevance: sc.rel, skip: sc.skip, skipWhy: sc.why, remote: true,
        });
        subCount++;
      }
      console.error(`[scrape] redditHiring: r/${sub} → ${subCount} leads`);
    } catch (e) { console.error(`[scrape] redditHiring: r/${sub} error:`, e.message); }
    await SLEEP(1200);
  }
  } finally {
    await page.close().catch(() => {});
  }
  console.error(`[scrape] redditHiring: total ${leads.length} leads (${leads.filter(l => l.email).length} email)`);
  return { ok: true, leads, detail: `${leads.length} reddit leads (${leads.filter(l => l.email).length} email)` };
}

// ── Public remote boards (fresh, filtered) ───────────────────────────────────
export async function publicBoards({ maxAgeHours = 72 } = {}) {
  console.error('[scrape] publicBoards: starting');
  const since = Date.now() - maxAgeHours * 3600e3;
  const leads = [];
  const counts = {}; // per-board counts for diagnostics
  const push = (src, title, company, url, desc, dateMs, applyUrl = '') => {
    if (!title || !url || (dateMs && dateMs < since)) return;
    const text = `${title} ${company} ${desc}`; const sc = score(text, title); const emails = emailsIn(desc, { needContext: true });
    leads.push({ source: src, role: title, company, url, email: emails[0] || '', emails, applyUrl: applyUrl || url, description: desc.slice(0, 2000),
      postedAt: dateMs ? new Date(dateMs).toISOString() : '', channel: emails[0] ? 'email' : 'form', portal: emails[0] ? 'email' : detectPortal(applyUrl || url), relevance: sc.rel, skip: sc.skip, skipWhy: sc.why, remote: true });
    counts[src] = (counts[src] || 0) + 1;
  };
  const get = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 20000 }); if (!r.ok) { console.error(`[scrape] publicBoards: GET ${u} → ${r.status}`); return null; } return r.json(); } catch (e) { console.error(`[scrape] publicBoards: GET ${u} error: ${e.message}`); return null; } };
  const strip = h => (h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&amp;/g, ' ').replace(/\s+/g, ' ');
  for (const tag of ['devops', 'kubernetes', 'terraform', 'cloud', 'sre']) {
    const j = await get(`https://remoteok.com/api?tag=${tag}`);
    for (const x of (j || []).slice(1)) push('remoteok', x.position, x.company, x.url, strip(x.description), Date.parse(x.date), x.apply_url);
  }
  const rm = await get('https://remotive.com/api/remote-jobs?category=software-dev&limit=150');
  for (const x of rm?.jobs || []) push('remotive', x.title, x.company_name, x.url, strip(x.description), Date.parse(x.publication_date));
  const jb = await get('https://jobicy.com/api/v2/remote-jobs?count=50&industry=engineering');
  for (const x of jb?.jobs || []) push('jobicy', x.jobTitle, x.companyName, x.url, strip(x.jobDescription), Date.parse(x.pubDate));
  const hm = await get('https://himalayas.app/jobs/api?limit=100');
  for (const x of hm?.jobs || []) push('himalayas', x.title, x.companyName, x.applicationLink || x.guid, strip(x.description || x.excerpt), (x.pubDate || 0) * 1000);

  // ── Pakistani job boards ──────────────────────────────────────────────────
  // Helper to fetch XML/text (not JSON)
  const getText = async u => { try { const r = await fetch(u, { headers: { 'User-Agent': UA }, timeout: 20000 }); if (!r.ok) { console.error(`[scrape] publicBoards: GET ${u} → ${r.status}`); return null; } return r.text(); } catch (e) { console.error(`[scrape] publicBoards: GET ${u} error: ${e.message}`); return null; } };
  const parseRssItems = xml => (String(xml || '')).match(/<item>[\s\S]*?<\/item>/gi) || [];
  // tag match is case-insensitive — Mustakbil uses lowercase <pubdate>, <company>, <city> …
  const rssField = (item, tag) => (item.match(new RegExp(`<${tag}[^>]*><\\!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i')) || []).slice(1).find(v => v != null && v !== '') || '';
  const PK_TECH = /\b(python|django|flask|fastapi|ai|a\.i\.|ml|machine learning|deep learning|data (scien|engineer|analyst)|llm|gen ?ai|nlp|backend|back[- ]end|full[- ]?stack|software (engineer|developer)|web developer|node|react|devops|cloud|sre|mern|mlops)\b/i;

  // Mustakbil.com — Pakistan's #1 job board. Old /jobs/rss/?q= path is 410 (gone); the
  // live feed is the aggregate RSS at rss.mustakbil.com (500 freshest PK jobs, all cats,
  // with <company>/<city>/<country>). We filter to tech roles via PK_TECH. Apply pages
  // (mustakbil.com/jobs/job/<id>) resolve through apply_portal; emails rarely appear in the
  // description, so most leads carry a `form` channel.
  try {
    const xml = await getText('https://rss.mustakbil.com/jobs-rss?c=162');
    const items = parseRssItems(xml);
    console.error(`[scrape] publicBoards: mustakbil RSS → ${items.length} items`);
    let kept = 0;
    for (const item of items) {
      const title = rssField(item, 'title').replace(/\s+jobs?\s+in\s+[^,]+,\s*pakistan\s*$/i, '').trim();
      const link = rssField(item, 'link') || rssField(item, 'guid');
      const desc = strip(rssField(item, 'description'));
      const pubDate = rssField(item, 'pubdate') || rssField(item, 'pubDate');
      const company = rssField(item, 'company').trim();
      const city = rssField(item, 'city').trim();
      const country = rssField(item, 'country').trim() || 'Pakistan';
      // keep tech roles only — match the TITLE so sales/CSR posts (whose body happens to
      // mention "software"/"AI") don't slip in; score() still re-filters off-stack titles.
      if (!title || !link || !PK_TECH.test(title)) continue;
      const loc = [city, country].filter(Boolean).join(', ');
      // carry city/country into the description so the Pakistan filter + score() see the geo
      push('mustakbil', title, company, link, `${desc} — ${loc}`.trim(), pubDate ? Date.parse(pubDate) : Date.now() - 12 * 3600e3, link);
      kept++;
    }
    console.error(`[scrape] publicBoards: mustakbil → ${kept} tech leads kept`);
  } catch (e) { console.error(`[scrape] publicBoards: mustakbil error: ${e.message}`); }

  // NOTE: rozee.pk and paperpk.com no longer expose a plain-fetch public feed —
  //   rozee /job/rss/q/ → 404 and its /job/jsearch/ results are rendered client-side (JS only),
  //   paperpk category RSS → 404. Both dead endpoints were removed so logs aren't noisy.
  //   LinkedIn hiring posts (liPosts, Pakistan queries) remain the primary PK email source.

  const seen = new Set();
  const all = leads.filter(l => !seen.has(l.url) && seen.add(l.url));
  console.error('[scrape] publicBoards: per-board counts', JSON.stringify(counts), `→ ${all.length} unique (${all.filter(l => l.email).length} email)`);
  return { ok: true, leads: all, detail: `${all.length} fresh board jobs (${all.filter(l => l.email).length} email) — ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ')}` };
}
