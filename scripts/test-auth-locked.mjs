// Citizenship skip. No profile.json and no browser.
import { authLocked, leadKeep } from '../src/mcp/sources.js';

let fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}: ${JSON.stringify(actual)}`);
  if (!ok) fail++;
};

const outsider = { workAuth: { authorizedIn: ['Canada'] } };
const citizen = { workAuth: { authorizedIn: ['United States'] } };
check('US citizens only is locked', authLocked('Remote. US citizens only.', outsider), true);
check('US citizens only is open for a US-authorized profile', authLocked('Remote. US citizens only.', citizen), false);
check('timezone overlap is not a citizenship lock', authLocked('Remote, US timezones, overlap is fine.', outsider), false);
check('leadKeep skips a citizenship lock', leadKeep('Remote role. US citizens only.', outsider).keep, false);
check('a visa offer still keeps the lead', leadKeep('Remote. US citizens only. We offer visa sponsorship.', outsider).keep, true);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
