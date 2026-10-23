// Worker-geo behavior, verified WITHOUT importing src/worker.js. worker.js has top-level
// side effects (it boots Chrome, the server, and all lanes on import), so importing it from a
// test would start the worker — which must never happen. The same country-scope normalization
// lives (inlined) in queries.js, and the India hard-block lives in sources.js; both import with
// no side effects, so we assert the behavior through them.
import { indiaBlocked } from '../src/mcp/sources.js';
import { queriesFromProfile } from '../src/mcp/queries.js';

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

const base = (scope) => ({
  country: 'pakistan',
  preferences: {
    roles: ['Frontend developer'],
    locations: ['Pakistan', 'Islamabad', 'Karachi', 'Lahore', 'Remote'],
    locationScope: scope,
    excludeCountries: ['india', 'in', 'bharat'],
    fallbackRegions: ['UAE', 'Dubai', 'Saudi Arabia', 'Riyadh', 'United States', 'USA', 'US'],
  },
});
const hasPkCity = qs => qs.some(q => /\b(islamabad|karachi|lahore)\b/i.test(q));

// 'pakistan' (country-name) and 'country' are both treated as country-scope → PK-city queries.
check("'pakistan' scope emits PK-city queries", hasPkCity(queriesFromProfile(base('pakistan'))));
check("'country' scope emits PK-city queries", hasPkCity(queriesFromProfile(base('country'))));
// 'worldwide' is NOT country-scope → no PK-city injection.
check("'worldwide' scope does not inject PK cities", !hasPkCity(queriesFromProfile(base('worldwide'))));

// India is never searched: no query names India/Bharat under any scope.
for (const scope of ['pakistan', 'worldwide']) {
  const qs = queriesFromProfile(base(scope));
  check(`no India query under '${scope}' scope`, qs.every(q => !/\b(india|bharat)\b/i.test(q)));
}

// India hard-block (the guard worker.locationAllowed applies before any scope logic).
check('india city blocked', indiaBlocked('Bangalore, India', { preferences: { excludeCountries: ['india'] } }) === true);
check('india-only phrase blocked', indiaBlocked('Remote - India only', { preferences: { excludeCountries: ['india'] } }) === true);
check('pakistan city not blocked', indiaBlocked('Remote role in Karachi, Pakistan', { preferences: { excludeCountries: ['india', 'in', 'bharat'] } }) === false);
check('IN country code blocked', indiaBlocked('Remote, IN', { preferences: { excludeCountries: ['india', 'in', 'bharat'] } }) === true);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
