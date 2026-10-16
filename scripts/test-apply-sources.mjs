// scripts/test-apply-sources.mjs — pure parser tests for apply-source toggles.
import { parseApplySources, ALL_SOURCES } from '../src/apply-sources.js';

let fail = 0;
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fail++; };

const all = [...ALL_SOURCES];

// Default: both empty → all three
check('both empty → all', eq(parseApplySources(undefined, undefined).sources, all));
check('empty string → all', eq(parseApplySources('', '').sources, all));
check('empty array profile → all', eq(parseApplySources(undefined, []).sources, all));

// Env precedence over profile
check('env wins over profile', eq(parseApplySources('indeed', ['linkedin']).sources, ['indeed']));
check('profile used when env absent', eq(parseApplySources(undefined, ['indeed','glassdoor']).sources, ['indeed','glassdoor']));

// Case-insensitive + whitespace + comma string
check('case-insensitive + spaces', eq(parseApplySources(' LinkedIn , INDEED ', undefined).sources, ['linkedin','indeed']));

// all / * aliases
check('all alias', eq(parseApplySources('all', undefined).sources, all));
check('star alias', eq(parseApplySources('*', undefined).sources, all));
check('all in array', eq(parseApplySources(['glassdoor','all'], undefined).sources, all));

// Unknown tokens ignored (mixed)
check('unknown mixed ignored', eq(parseApplySources('indeed,facebook', undefined).sources, ['indeed']));

// Non-empty but all-unknown → all + emptyInput flag
const empt = parseApplySources('foo,bar', undefined);
check('all-unknown → all (never disable)', eq(empt.sources, all));
check('all-unknown → emptyInput flagged', empt.emptyInput === true);

// Array profile value supported
check('array profile subset', eq(parseApplySources(undefined, ['Linkedin']).sources, ['linkedin']));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
