import { listedPlaceOption } from '../src/mcp/forms.js';

const profile = { country: 'Canada', location: 'Toronto, Canada' };
let failed = 0;
function eq(name, actual, expected) {
  if (actual !== expected) { failed++; console.error('FAIL', name, JSON.stringify(actual), 'expected', JSON.stringify(expected)); }
  else console.log('ok', name);
}

eq('country list does not pick the first row', listedPlaceOption('Country', 'Afghanistan', profile), '');
eq('country list picks the profile country', listedPlaceOption('Country', 'Canada', profile), 'Canada');
eq('nationality uses the profile country', listedPlaceOption('Please indicate your nationality', 'Canada', profile), 'Canada');
eq('work country rejects a different country', listedPlaceOption('In which country do you currently work?', 'Afghanistan', profile), '');
eq('city suggestion can be the profile city', listedPlaceOption('Location (City)', 'Toronto, Ontario', profile), 'Toronto, Ontario');
eq('a non-place question is left to the answer engine', listedPlaceOption('How did you hear about us?', 'Afghanistan', profile), null);

if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('listedPlaceOption ok');
