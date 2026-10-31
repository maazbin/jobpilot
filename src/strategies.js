// src/strategies.js — one playbook per platform, plus the human's corrections.
// The seed records what already worked or failed. Notes live in data/ and are never committed.
import fs from 'fs';
import path from 'path';
import { DATA } from './config.js';

const NOTES = path.join(DATA, 'strategy-notes.json');

export const STRATEGIES = [
  { id: 'x-link', platform: 'X', when: 'The post has an apply link', step: 'Open the link and submit the employer form.', result: 'worked', evidence: 'The employer page said the application was submitted.' },
  { id: 'x-email-reply', platform: 'X', when: 'A reply publishes an email address', step: 'Send the CV to that address and name the remote role.', result: 'worked', evidence: 'Gmail showed Message sent with the CV attached.' },
  { id: 'x-reply-instead', platform: 'X', when: 'The post has an apply link', step: 'Leave a public reply and stop.', result: 'failed', evidence: 'A reply is not the application when the post has a link.' },
  { id: 'ig-comments', platform: 'Instagram', when: 'A hiring post is open', step: 'Read the comments first. The email, link, or instruction is often there.', result: 'open', evidence: '' },
  { id: 'ig-bio', platform: 'Instagram', when: 'The caption points at the bio, or the comments do not name a link', step: 'Open the profile and use the link in the bio.', result: 'open', evidence: '' },
  { id: 'ig-dm', platform: 'Instagram', when: 'The post says to send a message', step: 'Send a short note with the portfolio in the inbox.', result: 'open', evidence: '' },
  { id: 'ig-old-grid', platform: 'Instagram', when: 'The keyword grid is on screen', step: 'Treat the first posts as the newest jobs.', result: 'failed', evidence: 'That grid was weeks old. Open a post from the last day.' },
  { id: 'ig-personal', platform: 'Instagram', when: 'The inbox shows a personal chat or a promotion', step: 'Reply in that thread.', result: 'failed', evidence: 'Those threads are not an application.' },
  { id: 'li-easy', platform: 'LinkedIn', when: 'The job shows Easy Apply and the location is in scope', step: 'Submit once, then wait. A burst gets the account restricted.', result: 'worked', evidence: 'Count it only when the page says the application was sent.' },
  { id: 'yc-jobs-home', platform: 'Y Combinator', when: 'The jobs page is ycombinator.com/jobs', step: 'Treat a footer Sign In link as logged out.', result: 'failed', evidence: 'The account control was a button, and Open messages was in the header. The footer Sign In link opened the Work at a Startup application.' },
  { id: 'yc-founder-email', platform: 'Y Combinator', when: 'An open role is remote with no country list, or it offers visa in a listed place, and a founder address is published', step: 'Email that person with the CV. Do not stop at the Apply button.', result: 'worked', evidence: 'Gmail reported the message sent with the CV. One was a Berlin role that will sponsor. One was a remote AI Engineer role whose YC company page published the founders address.' },
  { id: 'yc-us-office', platform: 'Y Combinator', when: 'The card says Remote and Will sponsor, and the office is in the United States', step: 'Treat that card as worldwide remote.', result: 'failed', evidence: 'The interview was an onsite day in San Francisco. The United States is not a listed place.' },
  { id: 'wf-city-search', platform: 'Wellfound', when: 'The jobs page hides roles that do not accept one city', step: 'Treat those cards as the senior search.', result: 'failed', evidence: 'That list was part-time work and tutors.' },
  { id: 'wf-profile-save', platform: 'Wellfound', when: 'The about form is missing the GitHub URL, the portfolio, the bio, or years', step: 'Fill those from the profile and press Save on that form.', result: 'worked', evidence: 'A reload kept the GitHub URL, the portfolio, and the bio. Years then showed 5.' },
  { id: 'wf-skill', platform: 'Wellfound', when: 'The skill field offers suggestions', step: 'Choose the suggestion that starts with the skill name.', result: 'worked', evidence: 'Python and FastAPI showed on the skills list.' },
];

/** Merge saved human notes onto the seed. A verdict of "wrong" blocks that step. */
export function applyNotes(list, notes = {}) {
  return list.map(s => {
    const human = notes[s.id] || null;
    return { ...s, human, blocked: human?.verdict === 'wrong' };
  });
}

export function readNotes() {
  try { return JSON.parse(fs.readFileSync(NOTES, 'utf8')); } catch { return {}; }
}

export function listStrategies() {
  return applyNotes(STRATEGIES, readNotes());
}

export function saveStrategyNote(id, verdict, note) {
  if (!STRATEGIES.some(s => s.id === id)) return false;
  if (verdict !== 'works' && verdict !== 'wrong') return false;
  const notes = readNotes();
  notes[id] = { verdict, note: String(note || '').slice(0, 500), at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(NOTES), { recursive: true });
  fs.writeFileSync(NOTES, JSON.stringify(notes, null, 2));
  return true;
}
