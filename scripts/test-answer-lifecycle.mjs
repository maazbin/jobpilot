import { initDB, getDB, save } from '../src/tracker.js';
import { initEvolve, askLater, answerByKey, learnedAnswer, pendingQuestions, qkey } from '../src/evolve.js';
await initDB(); initEvolve();

const uniq = 'ZTST' + Date.now();
const Q = `How many years of ${uniq} Kubernetes experience do you have?`;
const Qreword = `Years of ${uniq} Kubernetes experience?`;

let fail = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) fail++; };

// 1. Unknown question gets parked
askLater(Q, []);
const parkedKey = pendingQuestions(200).find(a => a.question.includes(uniq))?.qkey;
check('question parked with a key', !!parkedKey);

// 2. Simulate the DASHBOARD saving via the EXACT stored qkey (the bug path)
answerByKey(parkedKey, '5 years', 'user');

// 3. The parked question must now be GONE from pending (this was the bug)
check('question cleared from pending after answer', !pendingQuestions(200).some(a => a.question.includes(uniq)));

// 4. The answer is reused for the SAME question
check('answer reused (exact)', learnedAnswer(Q) === '5 years');

// 5. The answer is reused for a REWORDED version (fuzzy)
check('answer reused (reworded)', learnedAnswer(Qreword) === '5 years');

// 6. askLater on the reworded version must NOT re-park it
askLater(Qreword, []);
check('reworded question not re-parked', !pendingQuestions(200).some(a => a.question.includes(uniq)));

// 7. qkey is deterministic
check('qkey deterministic', qkey(Q) === qkey(Q));

// cleanup
getDB().run('DELETE FROM answers WHERE question LIKE ?', ['%' + uniq + '%']);
getDB().run('DELETE FROM answers WHERE qkey LIKE ?', ['%' + uniq.toLowerCase() + '%']); save();

console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail === 0 ? 0 : 1);
