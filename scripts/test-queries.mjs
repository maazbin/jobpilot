import { queriesFromProfile, listingQueriesFromProfile } from '../src/mcp/queries.js';

const pk = {
  country: 'pakistan',
  skills: ['react'],
  preferences: {
    roles: ['Frontend developer'],
    locations: ['Pakistan', 'Islamabad', 'Karachi', 'Lahore', 'Remote'],
    locationScope: 'pakistan',
    excludeCountries: ['india', 'in', 'bharat'],
    fallbackRegions: ['UAE', 'Dubai', 'Saudi Arabia', 'Riyadh', 'United States', 'USA', 'US'],
  },
};

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

const qs = queriesFromProfile(pk, { limit: 60 });
const ls = listingQueriesFromProfile(pk, { limit: 40 });

check('post queries non-empty', qs.length > 0);
check('listing queries non-empty', ls.length > 0);

const firstPk = qs.findIndex(q => /\b(islamabad|karachi|lahore)\b/i.test(q));
const firstUs = qs.findIndex(q => /\b(usa|united states)\b/i.test(q));
check('a PK-city query exists', firstPk >= 0);
check('PK-city query appears before any US query', firstUs === -1 || firstPk < firstUs);

check('a UAE/Saudi query exists', qs.some(q => /\b(uae|dubai|saudi|riyadh)\b/i.test(q)));

check('no India/Bharat in post queries', qs.every(q => !/\b(india|bharat)\b/i.test(q)));
check('no India/Bharat in listing queries', ls.every(q => !/\b(india|bharat)\b/i.test(q)));
check('listing queries include a PK city', ls.some(q => /\b(islamabad|karachi|lahore)\b/i.test(q)));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
