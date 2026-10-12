// src/dashboard.js — Thin re-export shim. The dashboard has been split into:
//
//   src/dashboard/index.js          coordinator (DB queries + HTML assembly)
//   src/dashboard/styles.js         CSS
//   src/dashboard/helpers.js        pure formatting helpers
//   src/dashboard/partials/header.js
//   src/dashboard/partials/kpis.js
//   src/dashboard/partials/tables.js
//   src/dashboard/partials/evolution.js
//   src/dashboard/partials/clientscripts.js
//
// Edit individual partials instead of this file.
// This shim keeps existing `import { writeDash } from './dashboard.js'` imports working.

export { writeDash } from './dashboard/index.js';
