#!/usr/bin/env node
// call-tool.mjs — One-shot MCP tool caller for brains without a live MCP client.
// Usage: node scripts/call-tool.mjs <toolName> [jsonArgs]
import { spawn } from 'child_process';

const tool = process.argv[2];
let args = {};
if (process.env.JOBPILOT_TOOL_ARGS) {
  args = JSON.parse(process.env.JOBPILOT_TOOL_ARGS);
} else if (process.argv[3]) {
  // PowerShell often strips quotes; accept base64 via --b64 <payload>
  if (process.argv[3] === '--b64' && process.argv[4]) {
    args = JSON.parse(Buffer.from(process.argv[4], 'base64').toString('utf8'));
  } else {
    args = JSON.parse(process.argv[3]);
  }
}
if (!tool) {
  console.error('usage: node scripts/call-tool.mjs <tool> [jsonArgs|--b64 <b64>]');
  process.exit(2);
}

const srv = spawn('node', ['mcp-server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, JOBPILOT_NO_AUTOWORKER: '1' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let stderr = '';
srv.stdout.on('data', d => { buf += d.toString(); });
srv.stderr.on('data', d => { stderr += d.toString(); });

function send(obj) {
  srv.stdin.write(JSON.stringify(obj) + '\n');
}

function waitForId(id, timeoutMs = 180000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) return resolve(msg);
        } catch { /* partial */ }
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout waiting for id=${id}\nstderr:\n${stderr.slice(-2000)}\nstdout:\n${buf.slice(-2000)}`));
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

(async () => {
  // MCP initialize handshake (SDK may require it)
  send({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'call-tool', version: '1.0.0' },
    },
  });
  await waitForId(0, 30000);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  const msg = await waitForId(1, 300000);
  const text = msg.result?.content?.[0]?.text ?? JSON.stringify(msg, null, 2);
  process.stdout.write(text + '\n');
  srv.kill();
  process.exit(msg.error ? 1 : 0);
})().catch(err => {
  console.error(err.message || err);
  try { srv.kill(); } catch {}
  process.exit(1);
});
