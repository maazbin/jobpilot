// Each group in preferences.mix totals 100. Missing keys use MIX_DEFAULT.

export const MIX_DEFAULT = {
  sources: { linkedin: 32, indeed: 16, glassdoor: 16, web: 16, ycombinator: 0, wellfound: 0, x: 20 },
  actions: { email: 34, posts: 16, connect: 16, dm: 12, easy_apply: 10, form: 12 },
};

const GROUPS = {
  sources: ['linkedin', 'indeed', 'glassdoor', 'web', 'ycombinator', 'wellfound', 'x'],
  actions: ['email', 'posts', 'connect', 'dm', 'easy_apply', 'form'],
};

function total100(group) {
  const keys = Object.keys(group);
  const sum = keys.reduce((s, k) => s + group[k], 0);
  if (sum === 100) return group;
  if (sum <= 0) {
    const even = Math.floor(100 / keys.length);
    keys.forEach(k => { group[k] = even; });
    group[keys[keys.length - 1]] += 100 - even * keys.length;
    return group;
  }
  let rest = 100;
  keys.forEach((k, i) => {
    if (i === keys.length - 1) group[k] = rest;
    else {
      const n = Math.max(0, Math.min(rest, Math.round(group[k] / sum * 100)));
      group[k] = n;
      rest -= n;
    }
  });
  return group;
}

export function outreachMix(preferences = {}) {
  const saved = preferences.mix || {};
  const out = {};
  for (const [group, keys] of Object.entries(GROUPS)) {
    out[group] = {};
    for (const key of keys) {
      const n = Number(saved[group]?.[key]);
      out[group][key] = Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : MIX_DEFAULT[group][key];
    }
    total100(out[group]);
  }
  return out;
}
