// scripts/test-geo.mjs — country-scope normalization + India hard-block, via side-effect-free
// modules only (sources.js / queries.js). It must NEVER import worker.js, which boots a full
// worker (Chrome + lanes) on import.
import { indiaBlocked } from '../src/mcp/sources.js';
import { queriesFromProfile } from '../src/mcp/queries.js';

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

// Country-scope behaviour is observable through query generation: a 'pakistan' scope must emit
// Pakistan-anchored queries (country-scoped), while 'worldwide' must not.
const base = {
  country: 'Pakistan',
  preferences: {
    roles: ['Frontend developer'], locations: ['Islamabad', 'Karachi'],
    excludeCountries: ['india'], fallbackRegions: [],
  },
};
const pkScoped = { ...base, preferences: { ...base.preferences, locationScope: 'pakistan' } };
const countryScoped = { ...base, preferences: { ...base.preferences, locationScope: 'country' } };
const worldwide = { ...base, preferences: { ...base.preferences, locationScope: 'worldwide' } };

const hasPkAnchor = qs => qs.some(q => /\b(pakistan|islamabad|karachi)\b/i.test(q));
check("'pakistan' scope → PK-anchored queries", hasPkAnchor(queriesFromProfile(pkScoped, { limit: 30 })));
check("'country' scope → PK-anchored queries", hasPkAnchor(queriesFromProfile(countryScoped, { limit: 30 })));
check("'worldwide' scope → no PK-anchored queries", hasPkAnchor(queriesFromProfile(worldwide, { limit: 30 })) === false);

check('india name blocked', indiaBlocked('Bangalore, India', { preferences: { excludeCountries: ['india'] } }) === true);
check('india city blocked by default list', indiaBlocked('Role in Pune', {}) === true);
check('clean PK text not blocked', indiaBlocked('Remote role in Islamabad, Pakistan', { preferences: { excludeCountries: ['india', 'in', 'bharat'] } }) === false);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
