// scripts/test-smartapply-fillstep.mjs — proves the SmartApply advance/questions stall fix:
//  (a) resolveYesNo() answers work-auth / sponsorship / residence truthfully for the Pakistan
//      profile (authorized nowhere listed), so required Yes/No radio groups resolve;
//  (b) salaryFor() returns a numeric PKR salary for the "Desired salary" field;
//  (c) chooseRadioValue() maps the picked label to the option value, and simulating that
//      selection on a plain-array group fixture leaves exactly one option checked — which is the
//      condition that clears SmartApply's disabled Continue button.
//
// Pure-helper tests only (no browser, no data/profile.json read): the decision logic was
// factored into exported pure functions, matching the test-salary.mjs pattern of passing a plain
// profile object.
import { resolveYesNo, salaryFor } from '../src/mcp/answers.js';
import { chooseRadioValue } from '../src/mcp/human-assisted-apply.js';

let fail = 0;
const check = (name, actual, expected) => {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}: ${JSON.stringify(actual)}`);
  if (!ok) fail++;
};

// Profile under test: Pakistan, authorized nowhere listed, 3 yrs, 200000 PKR/month.
const workAuth = { authorizedIn: [] };
const country = 'Pakistan';
const yn = q => resolveYesNo(q, { yesLabel: 'Yes', noLabel: 'No', workAuth, country });

// (a) Work-authorization / sponsorship / residence — truthful for a not-authorized user.
check('authorized to work in the US → No', yn('Are you authorized to work in the United States?'), 'No');
check('authorized to work in the UAE → No', yn('Are you legally authorized to work in the United Arab Emirates?'), 'No');
check('require visa sponsorship in the UAE → Yes', yn('Do you require visa sponsorship to work in the UAE?'), 'Yes');
check('require sponsorship in the US → Yes', yn('Will you now or in the future require sponsorship for a US work visa?'), 'Yes');
check('reside in California → No', yn('Do you currently reside in California?'), 'No');
check('federal contractor US citizens → No', yn('This is a federal contractor role requiring U.S. citizens. Are you a U.S. citizen?'), 'No');
check('consent to background check → Yes', yn('Do you consent to a background check?'), 'Yes');

const pakProfile = {
  salary: {},
  currentSalary: {},
  salaryExpectations: [
    { country: 'Pakistan', min: 200000, max: 200000, currency: 'PKR', period: 'month' },
  ],
  answers: {},
};

// (b) Desired salary resolves to a numeric PKR figure.
const sal = salaryFor('Desired salary', pakProfile, true);
check('desired salary is a non-empty numeric string', !!sal && !isNaN(parseFloat(sal)), true);
check('desired salary is the PKR figure', sal, '200000');

// (c) Radio-selection helper + simulated selection clears the required group.
const group = { name: 'q_citizen', type: 'radio', required: true, options: [
  { value: 'Yes', label: 'Yes', checked: false },
  { value: 'No', label: 'No', checked: false },
] };
check('chooseRadioValue maps picked label "No" → value "No"', chooseRadioValue(group, 'No'), 'No');
check('chooseRadioValue returns null for an absent label', chooseRadioValue(group, 'Maybe'), null);

// Simulate marking the chosen value checked (mirrors fillStep's in-frame checked=true pass) and
// assert the group ends with exactly one checked option — SmartApply's disabled Continue clears
// once every required group has one checked option.
const picked = resolveYesNo('Are you a U.S. citizen?', { yesLabel: 'Yes', noLabel: 'No', workAuth, country });
const pickedValue = chooseRadioValue(group, picked);
for (const o of group.options) o.checked = o.value === pickedValue;
const checkedCount = group.options.filter(o => o.checked).length;
check('required radio group ends with exactly one checked option', checkedCount, 1);
check('the checked option is the truthful "No"', group.options.find(o => o.checked)?.value, 'No');

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
