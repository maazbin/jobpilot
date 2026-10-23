// Verify the dashboard Questions tab renders a pending question with a prefilled
// recommendation and an ans() save hook — the existing list_questions → learn_answer path.
import { renderQuestionsTab } from '../src/dashboard/partials/evolution.js';
import { recommendAnswer } from '../src/mcp/answers.js';

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

const pend = [{ qkey: 'notice period', question: 'What is your notice period?', seen: 1, options: '' }];
const html = renderQuestionsTab(pend, [], recommendAnswer);

check('renders the question text', html.includes('What is your notice period?'));
check('wires the ans() save hook for the qkey', html.includes("ans('notice period'"));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
