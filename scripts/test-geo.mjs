import { isCountryScoped, indiaBlocked } from '../src/worker.js';

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

check('pakistan scope is country-scoped', isCountryScoped('pakistan', 'pakistan') === true);
check('country literal is country-scoped', isCountryScoped('country', 'pakistan') === true);
check('worldwide is not country-scoped', isCountryScoped('worldwide', 'pakistan') === false);
check('continent is not country-scoped', isCountryScoped('continent', 'pakistan') === false);
check('all is not country-scoped', isCountryScoped('all', 'pakistan') === false);
check('empty scope is not country-scoped', isCountryScoped('', 'pakistan') === false);
check('india blocked via worker re-export', indiaBlocked('Bangalore, India', { preferences: { excludeCountries: ['india'] } }) === true);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
