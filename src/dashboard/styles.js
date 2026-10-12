// src/dashboard/styles.js — CSS for the pipeline dashboard.
// Exported as a string so the main coordinator inlines it into the HTML.
// Edit here to restyle the dashboard without touching business logic.

/**
 * Returns the full <style> block CSS string for the dashboard.
 * @returns {string}
 */
export function dashStyles() {
  return `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e2e8f0;font-size:13px}
a{color:#60a5fa;text-decoration:none}.dim{color:#64748b}.role{max-width:300px;color:#f1f5f9}.em{color:#22c55e;font-weight:600}
.hdr{padding:16px 28px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;background:#0f172a}
.hdr h1{font-size:20px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
.wrap{max-width:1750px;margin:0 auto;padding:18px 26px}
.ks{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.k{background:#111a2e;border:1px solid #1e293b;border-top:3px solid;border-radius:10px;padding:12px 16px;min-width:120px}
.kv{font-size:28px;font-weight:800;line-height:1}.kl{font-size:11px;color:#94a3b8;margin-top:5px}
.qs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}
.qc{display:block;background:#111a2e;border:1px solid;border-radius:10px;padding:12px 16px;color:#cbd5e1;cursor:pointer}
.qh{font-weight:800;font-size:14px;margin-bottom:4px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;background:#111a2e;border:1px solid #1e293b;border-radius:8px;overflow:hidden}
th{background:#0f172a;color:#64748b;font-size:11px;text-transform:uppercase;text-align:left;padding:7px 9px;border-bottom:1px solid #1e293b}
td{padding:6px 9px;border-bottom:1px solid #16203a;vertical-align:top}
tr:hover td{background:#0f172a}.empty{text-align:center;color:#475569;padding:18px}
.b{padding:1px 7px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid}
.b-agent{padding:1px 7px;border-radius:6px;font-size:10px;font-weight:700;border:1px solid;background:#0c1f3a22;color:#60a5fa;border-color:#60a5fa55}
.tabs{display:flex;gap:6px;margin-top:18px;flex-wrap:wrap}
.tabs button{background:#111a2e;color:#94a3b8;border:1px solid #1e293b;border-bottom:none;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-weight:600}
.tabs button.on{background:#1e293b;color:#fff}.pane{display:none}.pane.on{display:block}
.legend{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 18px;background:#111a2e;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;font-size:12px}
.banner{background:#111a2e;border:1px solid #1e293b;border-radius:8px;padding:9px 14px;margin-bottom:14px;font-size:12px}
input.s{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:6px;width:320px;margin-bottom:8px}
.opt{background:#1e293b;color:#e2e8f0;border:1px solid #3b82f6;border-radius:6px;padding:4px 10px;margin:2px;cursor:pointer;font-weight:600}
.opt:hover{background:#3b82f6}
.ai{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:6px;width:420px;margin-right:6px;vertical-align:middle;font-family:inherit}
.opt.rec{background:#14532d;border-color:#22c55e;color:#bbf7d0}
.qbanner{background:#1a1407;border:1px solid #a16207;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#fcd34d}
.loginbanner{background:#2a0a0a;border:1px solid #b91c1c;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:14px;color:#fecaca}
.loginbtn{display:inline-block;background:#ef4444;color:#fff;font-weight:700;padding:5px 14px;border-radius:7px;text-decoration:none;margin:0 4px}
.loginbtn:hover{background:#dc2626}
.consentbar{background:#0b1f17;border:1px solid #166534;border-radius:8px;padding:9px 14px;margin-bottom:12px;font-size:12.5px;color:#bbf7d0}
.cbtn{border:none;border-radius:7px;padding:5px 12px;font-weight:700;cursor:pointer;margin-left:8px}
.cbtn.on{background:#22c55e;color:#06240f}.cbtn.off{background:#334155;color:#e2e8f0}
.stopbtn{margin-top:8px;background:#ef4444;color:#fff;border:none;border-radius:7px;padding:6px 14px;font-weight:700;cursor:pointer}
.stopbtn:hover{background:#dc2626}
`.trim();
}
