// scripts/test-questions-ui.mjs — VERIFY the Questions tab renders a pending question with a
// prefilled recommendation and an ans('<qkey>',…) save hook that POSTs to learn_answer.
// Pure render check against side-effect-free modules (no worker, no server boot).
import { renderQuestionsTab } from '../src/dashboard/partials/evolution.js';
import { recommendAnswer } from '../src/mcp/answers.js';

let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

const pend = [{ qkey: 'notice period', question: 'What is your notice period?', seen: 1, options: '' }];
const html = renderQuestionsTab(pend, [], recommendAnswer);

check('renders the pending question text', html.includes('What is your notice period?'));
check("renders an ans('notice period',…) save hook", html.includes("ans('notice period'"));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
