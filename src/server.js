// src/server.js — Local dashboard + onboarding web server (127.0.0.1 only).
// Serves the dashboard, an onboarding form (CV upload + paste links/roles),
// and small JSON endpoints to read/write the profile. Nothing leaves the machine.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProfile, updateProfile, profileGaps } from './profile.js';
import { cdpStatus, listTabs } from './agent/browser.js';
import { writeDash } from './dashboard.js';
import { DASH, DATA } from './config.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const UPLOADS = path.join(DATA, 'uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const PORT = Number(process.env.JOB_AGENT_PORT) || 7788;

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, maxBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > maxBytes) { reject(new Error('too large')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Parse a single-file multipart/form-data upload (CV). Minimal, dependency-free.
function parseMultipart(buf, contentType) {
  const m = /boundary=(.+)$/.exec(contentType || '');
  if (!m) return null;
  const boundary = '--' + m[1];
  const parts = buf.toString('latin1').split(boundary).slice(1, -1);
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(0, headerEnd);
    const fnMatch = /filename="([^"]+)"/.exec(header);
    if (!fnMatch) continue;
    const filename = fnMatch[1];
    let data = part.slice(headerEnd + 4);
    if (data.endsWith('\r\n')) data = data.slice(0, -2);
    return { filename, buffer: Buffer.from(data, 'latin1') };
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    // ── GET / → onboarding form OR dashboard, depending on completeness ───────
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      if (url.pathname === '/' && profileGaps().length) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(onboardingHtml());
      }
      const { reloadIfChanged } = await import('./tracker.js');
      await reloadIfChanged();
      writeDash();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(DASH, 'utf8'));
    }

    // ── GET /onboard → always show the form (edit profile) ────────────────────
    if (req.method === 'GET' && url.pathname === '/onboard') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(onboardingHtml());
    }

    // ── GET /api/status ───────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const cdp = await cdpStatus();
      const tabs = cdp.ok ? await listTabs() : [];
      const loggedIn = ['linkedin', 'indeed', 'glassdoor', 'gmail', 'x.com']
        .filter(s => tabs.some(t => t.url?.includes(s)));
      return json(res, 200, { chrome: cdp, loggedIn, gaps: profileGaps(), profile: getProfile() });
    }

    // ── POST /api/profile → save pasted fields ────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/profile') {
      const body = await readBody(req);
      const patch = JSON.parse(body.toString('utf8') || '{}');
      const saved = updateProfile(patch);
      return json(res, 200, { ok: true, profile: saved, gaps: profileGaps() });
    }

    // ── POST /api/cv → upload CV file, store it, set cvPath ────────────────────
    if (req.method === 'POST' && url.pathname === '/api/cv') {
      const body = await readBody(req);
      const file = parseMultipart(body, req.headers['content-type']);
      if (!file) return json(res, 400, { ok: false, error: 'no file' });
      const safe = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dest = path.join(UPLOADS, safe);
      fs.writeFileSync(dest, file.buffer);
      updateProfile({ cvPath: dest });
      return json(res, 200, { ok: true, cvPath: dest, size: file.buffer.length });
    }

    // ── POST /api/stop → halt the always-on worker (writes a flag the lanes honor) ─────
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      try { fs.writeFileSync(path.join(DATA, '.stop'), new Date().toISOString()); } catch {}
      return json(res, 200, { ok: true, detail: 'Stop requested — the worker will halt within a few seconds. Your logged-in Chrome stays open.' });
    }
    // ── POST /api/consent → user opts in/out of auto-contribution ──────────────
    if (req.method === 'POST' && url.pathname === '/api/consent') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const saved = updateProfile({ consent: { autoContribute: !!body.autoContribute } });
      return json(res, 200, { ok: true, consent: saved.consent });
    }

    // ── GET /api/answers → open questions + learned answers ───────────────────
    if (req.method === 'GET' && url.pathname === '/api/answers') {
      const { initDB } = await import('./tracker.js');
      await initDB();
      const { pendingQuestions, allAnswers } = await import('./evolve.js');
      return json(res, 200, { pending: pendingQuestions(), learned: allAnswers() });
    }

    // ── POST /api/answers → user teaches an answer (clears the pending question) ─
    if (req.method === 'POST' && url.pathname === '/api/answers') {
      const { initDB } = await import('./tracker.js');
      await initDB();
      const { learn, answerByKey } = await import('./evolve.js');
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (!body.answer) return json(res, 400, { ok: false, error: 'answer required' });
      // The dashboard sends the EXACT stored qkey — update that row in place so the
      // parked question is actually cleared (no re-keying, no duplicate row).
      if (body.qkey) answerByKey(body.qkey, body.answer, 'user');
      else learn(body.question, body.answer, 'user');
      return json(res, 200, { ok: true });
    }

    // ── GET /evidence/<file> → encounter screenshots + HTML snapshots ──────────
    if (req.method === 'GET' && url.pathname.startsWith('/evidence/')) {
      const name = path.basename(decodeURIComponent(url.pathname.slice('/evidence/'.length)));
      const file = path.join(DATA, 'evolution', name);
      if (!file.startsWith(path.join(DATA, 'evolution')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : 'text/html' });
      return res.end(fs.readFileSync(file));
    }

    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

// ── Onboarding form HTML (dark, matches dashboard) ────────────────────────────
function onboardingHtml() {
  const p = getProfile();
  const L = p.links || {};
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Job Agent — Setup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;font-size:14px}
.wrap{max-width:720px;margin:0 auto}
h1{font-size:22px;margin-bottom:4px}
.sub{color:#64748b;margin-bottom:24px;font-size:13px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;margin-bottom:16px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:14px}
label{display:block;font-size:12px;color:#94a3b8;margin:10px 0 4px}
input[type=text],input[type=email],textarea{width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:9px 12px;color:#e2e8f0;font-size:13px}
input:focus,textarea:focus{outline:none;border-color:#6366f1}
.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.drop{border:2px dashed #334155;border-radius:10px;padding:28px;text-align:center;color:#64748b;cursor:pointer;transition:.2s}
.drop:hover,.drop.over{border-color:#6366f1;color:#a5b4fc;background:#1e1b4b22}
.btn{background:#6366f1;color:#fff;border:none;border-radius:8px;padding:11px 24px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
.btn:hover{background:#4f46e5}
.ok{color:#22c55e}.warn{color:#f59e0b}
.status{font-size:12px;margin-top:6px}
.pill{display:inline-block;background:#0f172a;border:1px solid #334155;border-radius:6px;padding:3px 10px;margin:3px 4px 0 0;font-size:12px}
</style></head><body><div class="wrap">
<h1>🤖 Job Agent — Setup</h1>
<div class="sub">Upload your CV and paste your links. Everything stays on your machine.</div>

<div class="card">
  <h2>📄 CV / Resume</h2>
  <div class="drop" id="drop">Drop your CV here, or click to choose a PDF/DOCX
    <input type="file" id="cv" accept=".pdf,.doc,.docx" style="display:none">
  </div>
  <div class="status" id="cvStatus">${p.cvPath ? '<span class="ok">✓ ' + p.cvPath + '</span>' : 'No CV uploaded yet'}</div>
</div>

<div class="card">
  <h2>👤 You</h2>
  <div class="row">
    <div><label>Full name</label><input type="text" id="name" value="${p.name || ''}"></div>
    <div><label>Email</label><input type="email" id="email" value="${p.email || ''}"></div>
  </div>
  <div class="row">
    <div><label>Phone</label><input type="text" id="phone" value="${p.phone || ''}"></div>
    <div><label>Location</label><input type="text" id="location" value="${p.location || ''}"></div>
  </div>
  <div class="row">
    <div><label>Headline / current title</label><input type="text" id="headline" value="${p.headline || p.currentTitle || ''}" placeholder="Senior Software Engineer"></div>
    <div><label>Years of experience</label><input type="text" id="years" value="${p.yearsExperience || ''}" placeholder="5"></div>
  </div>
</div>

<div class="card">
  <h2>🔗 Links & Portfolio</h2>
  <div class="row">
    <div><label>LinkedIn</label><input type="text" id="linkedin" value="${L.linkedin || ''}"></div>
    <div><label>GitHub</label><input type="text" id="github" value="${L.github || ''}"></div>
  </div>
  <div class="row">
    <div><label>Portfolio</label><input type="text" id="portfolio" value="${L.portfolio || ''}"></div>
    <div><label>Website / other</label><input type="text" id="website" value="${L.website || ''}"></div>
  </div>
</div>

<div class="card">
  <h2>🎯 What to look for</h2>
  <label>Target roles (comma-separated)</label>
  <input type="text" id="roles" value="${(p.preferences?.roles || []).join(', ')}" placeholder="AI Engineer, ML Engineer, Backend Engineer">
  <label>Key skills (comma-separated)</label>
  <input type="text" id="skills" value="${(p.skills || []).join(', ')}" placeholder="Python, FastAPI, AWS, LLM, RAG">
  <label>Skip (comma-separated)</label>
  <input type="text" id="skip" value="${(p.preferences?.skip || []).join(', ')}" placeholder="junior, intern, sales">
  <label>Location scope — how far should the agent search?</label>
  <select id="locationScope" style="width:100%;background:#0f172a;border:1px solid #334155;border-radius:8px;padding:9px 12px;color:#e2e8f0;font-size:13px">
    <option value="worldwide" ${(p.preferences?.locationScope||'worldwide')==='worldwide'?'selected':''}>🌍 Worldwide — apply to jobs anywhere</option>
    <option value="all"       ${(p.preferences?.locationScope||'')==='all'      ?'selected':''}>🌐 All — same as worldwide, no filtering</option>
    <option value="continent" ${(p.preferences?.locationScope||'')==='continent'?'selected':''}>🗺 Continent — same continent as my location</option>
    <option value="country"   ${(p.preferences?.locationScope||'')==='country'  ?'selected':''}>📍 Country — same country as my location only</option>
  </select>
  <label>Sites you're logged into (comma-separated)</label>
  <input type="text" id="sources" value="${(p.loggedInSources || []).join(', ')}" placeholder="linkedin, gmail">
</div>

<div class="card">
  <h2>💰 The things the agent should never guess</h2>
  <div class="sub" style="margin:-6px 0 10px">So it can answer screening questions without pausing to ask you.</div>
  <div class="row">
    <div><label>Expected salary — amount</label><input type="text" id="salAmount" value="${p.salary?.amount || ''}" placeholder="500000"></div>
    <div><label>Currency / period</label><input type="text" id="salCur" value="${(p.salary?.currency || '') + (p.salary?.period ? ' / ' + p.salary.period : '')}" placeholder="PKR / month"></div>
  </div>
  <div class="row">
    <div><label>Need visa sponsorship?</label><input type="text" id="sponsor" value="${p.workAuth?.needsSponsorship === true ? 'yes' : p.workAuth?.needsSponsorship === false ? 'no' : ''}" placeholder="no"></div>
    <div><label>Authorized to work in</label><input type="text" id="authIn" value="${(p.workAuth?.authorizedIn || []).join(', ')}" placeholder="Pakistan"></div>
  </div>
  <label>Notice period</label>
  <input type="text" id="notice" value="${(p.answers || {})['notice period'] || ''}" placeholder="2 weeks">
</div>

<div class="card">
  <h2>📝 Anything else useful (free-form)</h2>
  <div class="sub" style="margin:-6px 0 10px">Context, preferences, a short pitch, constraints — the agent reads this when answering questions and writing outreach.</div>
  <textarea id="extra" rows="4" placeholder="e.g. I prefer product companies over agencies. I'm strongest in backend + LLM systems. Open to contract. My pitch: I build the system around the model…">${p.extra || p.summary || ''}</textarea>
</div>

<div class="card">
  <h2>💬 Common application answers (optional)</h2>
  <label>One per line, as <code>question = answer</code></label>
  <textarea id="answers" rows="4" placeholder="years of python = 5&#10;visa = No, I don't need sponsorship&#10;notice period = 2 weeks">${Object.entries(p.answers || {}).filter(([k]) => k !== 'notice period').map(([k, v]) => k + ' = ' + v).join('\n')}</textarea>
</div>

<button class="btn" id="save">Save & open dashboard</button>
<span class="status" id="saveStatus"></span>

<script>
const $ = id => document.getElementById(id);
const drop = $('drop'), cv = $('cv');
drop.onclick = () => cv.click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); if (e.dataTransfer.files[0]) uploadCV(e.dataTransfer.files[0]); };
cv.onchange = () => cv.files[0] && uploadCV(cv.files[0]);

async function uploadCV(file) {
  $('cvStatus').textContent = 'Uploading ' + file.name + '…';
  const fd = new FormData(); fd.append('cv', file);
  const r = await fetch('/api/cv', { method: 'POST', body: fd }).then(r => r.json());
  $('cvStatus').innerHTML = r.ok ? '<span class="ok">✓ ' + r.cvPath + '</span>' : '<span class="warn">upload failed</span>';
}

$('save').onclick = async () => {
  const parseList = s => s.split(',').map(x => x.trim()).filter(Boolean);
  const answers = {};
  $('answers').value.split('\\n').forEach(line => { const i = line.indexOf('='); if (i > 0) answers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); });
  if ($('notice').value.trim()) answers['notice period'] = $('notice').value.trim();
  const salCur = $('salCur').value.split('/').map(x => x.trim());
  const sponsorVal = $('sponsor').value.trim().toLowerCase();
  const patch = {
    name: $('name').value, email: $('email').value, phone: $('phone').value, location: $('location').value,
    headline: $('headline').value, currentTitle: $('headline').value,
    yearsExperience: parseInt($('years').value) || 0,
    skills: parseList($('skills').value),
    extra: $('extra').value,
    salary: { amount: parseInt($('salAmount').value) || 0, currency: (salCur[0] || '').toUpperCase(), period: salCur[1] || 'month' },
    workAuth: { needsSponsorship: sponsorVal === 'yes' ? true : sponsorVal === 'no' ? false : undefined, authorizedIn: parseList($('authIn').value) },
    links: { linkedin: $('linkedin').value, github: $('github').value, portfolio: $('portfolio').value, website: $('website').value },
    preferences: { roles: parseList($('roles').value), skip: parseList($('skip').value), locationScope: $('locationScope').value },
    loggedInSources: parseList($('sources').value),
    answers,
  };
  $('saveStatus').textContent = 'Saving…';
  const r = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).then(r => r.json());
  if (r.ok) { $('saveStatus').innerHTML = '<span class="ok">✓ saved — opening dashboard…</span>'; setTimeout(() => location.href = '/dashboard', 800); }
  else $('saveStatus').innerHTML = '<span class="warn">save failed</span>';
};
</script>
</div></body></html>`;
}

export function startServer() {
  return new Promise((resolve) => {
    let port = PORT;
    let attempts = 0;
    const tryListen = () => {
      server.listen(port, '127.0.0.1');
    };
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && attempts < 10) {
        attempts++;
        port++;               // try the next port
        setTimeout(tryListen, 100);
      } else {
        console.error(`[job-agent] web server could not bind: ${e.message}`);
        resolve(0);           // non-fatal — MCP tools still work without the UI
      }
    });
    server.on('listening', () => {
      console.error(`[job-agent] dashboard + onboarding at http://127.0.0.1:${port}`);
      resolve(port);
    });
    tryListen();
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { initDB } = await import('./tracker.js');
  const { initAttempts } = await import('./attempts.js');
  await initDB(); await initAttempts();
  await startServer();
}
