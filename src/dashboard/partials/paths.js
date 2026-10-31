// Decision trees from docs/paths/<site>/path.md.
// A brain matches the current page to a node, then takes a reached or success branch.
// stop and refused are leaves. The dashboard draws the same tree.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { esc } from '../helpers.js';

const PATHS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/paths');
const FOLLOW = new Set(['reached', 'success']);

function kind(result) {
  if (result === 'success') return 'ok';
  if (result === 'stop' || result === 'refused') return 'stop';
  if (result === 'retry') return 'wait';
  return 'go';
}

/** Parse a ```tree block. Table rows remain readable if a file has not moved yet. */
export function parsePathTree(text) {
  const fenced = String(text || '').match(/```tree\r?\n([\s\S]*?)```/);
  const body = fenced ? fenced[1] : '';
  const meta = {};
  const nodes = [];
  let cur = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const node = line.match(/^node\s+(\S+)/);
    if (node) {
      cur = { id: node[1], see: '', action: '', branches: [] };
      nodes.push(cur);
      continue;
    }
    const branch = line.match(/^branch\s+(reached|success|stop|refused|retry)\s*\|\s*(.*?)\s*\|\s*(\S+)\s*$/);
    if (branch && cur) {
      cur.branches.push({ result: branch[1], control: branch[2], next: branch[3] });
      continue;
    }
    const field = line.match(/^(see|action):\s*(.+)$/);
    if (field && cur) { cur[field[1]] = field[2]; continue; }
    const metaLine = line.match(/^([a-zA-Z0-9_]+):\s*(.+)$/);
    if (metaLine && !cur) meta[metaLine[1]] = metaLine[2];
  }
  if (nodes.length) return { meta, nodes };

  const hops = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(s => s.trim().replace(/`/g, ''));
    if (cells.length < 4 || cells[0] === 'From' || cells[0] === 'Where you were' || /^[-:]+$/.test(cells[0])) continue;
    hops.push({ from: cells[0], option: cells[1], to: cells[2], result: cells[3].split(/[.\s]/)[0].toLowerCase() });
  }
  return { meta, nodes: [], hops };
}

/** @param {string} [dir] */
export function readPathTraces(dir = PATHS) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => {
    const file = path.join(dir, d.name, 'path.md');
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const tree = parsePathTree(text);
    const hops = tree.nodes.length
      ? tree.nodes.flatMap(n => n.branches)
      : (tree.hops || []);
    const title = (text.match(/^#\s+(.+)$/m) || [null, d.name])[1].trim();
    return { site: d.name, title, meta: tree.meta, nodes: tree.nodes, hops };
  });
}

function renderNode(node, byId, stack, drawn) {
  const here = new Set(stack);
  const branches = node.branches.map(b => {
    const child = byId.get(b.next);
    const follow = FOLLOW.has(b.result);
    let kids = '';
    if (child && follow && !here.has(child.id) && !drawn.has(child.id)) {
      drawn.add(child.id);
      kids = `<div class="tree-kids">${renderNode(child, byId, stack.concat(child.id), drawn)}</div>`;
    } else if (child && follow) {
      kids = `<div class="tree-back">↩ ${esc(child.id)}</div>`;
    } else if (child) {
      kids = `<div class="tree-leaf">${esc(child.see || child.id)}</div>`;
    }
    return `<div class="tree-branch hop-${kind(b.result)}"><i>${esc(b.result)}</i><span>${esc(b.control)}</span><em>${esc(b.next)}</em>${kids}</div>`;
  }).join('');
  const action = node.action ? `<code>${esc(node.action)}</code>` : '';
  return `<div class="tree-node"><b>${esc(node.id)}</b>${action}<div class="tree-see">${esc(node.see)}</div>${branches}</div>`;
}

function reachable(start, byId) {
  const seen = new Set();
  const stack = start.map(n => n.id);
  while (stack.length) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const b of node.branches) if (FOLLOW.has(b.result)) stack.push(b.next);
  }
  return seen;
}

function rootsOf(nodes) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const external = new Set();
  for (const n of nodes) for (const b of n.branches) if (b.next !== n.id) external.add(b.next);
  const roots = nodes.filter(n => !external.has(n.id));
  const seen = reachable(roots, byId);
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    roots.push(n);
    for (const id of reachable([n], byId)) seen.add(id);
  }
  return roots.length ? roots : nodes.slice(0, 1);
}

/** @param {{site:string, meta:object, nodes:object[], hops:object[]}[]} traces */
export function renderPathsTab(traces) {
  if (!traces.length) return '<p class="dim">No path traces in docs/paths yet.</p>';
  return traces.map(t => {
    const meta = Object.entries(t.meta || {}).map(([k, v]) => `${k}: ${v}`).join(' · ');
    if (!t.nodes.length) {
      return `<h2>${esc(t.title || t.site)}</h2><div class="trace">${t.hops.map(h => `<div class="hop hop-${kind(h.result)}"><b>${esc(h.from)}</b><span>${esc(h.option)}</span><em>${esc(h.to)}</em><i>${esc(h.result)}</i></div>`).join('')}</div>`;
    }
    const byId = new Map(t.nodes.map(n => [n.id, n]));
    const drawn = new Set();
    const forest = rootsOf(t.nodes).map(n => {
      drawn.add(n.id);
      return renderNode(n, byId, [n.id], drawn);
    }).join('');
    return `<h2>${esc(t.title || t.site)}</h2>${meta ? `<p class="dim">${esc(meta)}</p>` : ''}<div class="trace">${forest}</div>`;
  }).join('');
}
