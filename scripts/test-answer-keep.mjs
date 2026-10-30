// Pure checks for the salary, yes/no, and citizenship-skip fixes.
// No profile.json and no browser.
import { salaryFor, resolveYesNo, isConsentQuestion } from '../src/mcp/answers.js';

let fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}: ${JSON.stringify(actual)}`);
  if (!ok) fail++;
};

const usdProfile = {
  salary: {},
  currentSalary: {},
  salaryExpectations: [{ country: 'Fixture', min: 4000, max: 4000, currency: 'USD', period: 'month' }],
  answers: {},
};
check('unnamed salary keeps the stored USD figure', salaryFor('Desired salary', usdProfile, true), '4000');

const eurProfile = {
  salary: {},
  currentSalary: {},
  salaryExpectations: [{ country: 'Fixture', min: 3000, max: 3000, currency: 'EUR', period: 'month' }],
  answers: {},
};
check('a USD question converts EUR instead of echoing it', salaryFor('Desired salary in USD', eurProfile, true), '3300');
check('spanish salary question is recognized', salaryFor('¿Cuál es tu expectativa salarial?', eurProfile, true), '3000');

const yn = (q, country, authorizedIn = [], needsSponsorship) => resolveYesNo(q, {
  yesLabel: 'Yes', noLabel: 'No',
  workAuth: { authorizedIn, needsSponsorship },
  country,
});
check('US citizen question is No for a non-US country', yn('Are you a U.S. citizen?', 'Canada'), 'No');
check('home-country residence is Yes', yn('Do you reside in Canada?', 'Canada'), 'Yes');
check('sponsorship in a country they are not authorized for is Yes', yn('Will you require sponsorship for a US work visa?', 'Canada', ['Canada']), 'Yes');
check('sponsorship flag false stays No', yn('Do you require visa sponsorship in the UAE?', 'Canada', [], false), 'No');
check('disability is not invented', yn('Do you have a disability?', 'Canada'), 'No');
check('unrelated yes/no is left to the caller', yn('Are you comfortable with startups?', 'Canada'), null);

check('privacy acceptance is consent', isConsentQuestion('I agree to the privacy policy'), true);
check('work authorization is not consent', isConsentQuestion('Are you authorized to work in the United States?'), false);
check('negative consent is not auto-accepted', isConsentQuestion("I do not agree to the terms"), false);

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
