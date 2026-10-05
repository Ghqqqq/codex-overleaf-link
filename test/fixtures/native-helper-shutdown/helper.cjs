'use strict';
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const root = process.env.CODEX_TEST_DISCONNECT_ROOT;
fs.writeFileSync(path.join(root, 'helper-pid.json'), JSON.stringify({ pid: process.pid }));
process.on('SIGTERM', () => {}); // Exercise the bounded force-stop stage.
process.stdout.on('error', () => {});
setInterval(() => fs.appendFileSync(path.join(root, 'heartbeat'), '.'), 30);
readline.createInterface({ input: process.stdin }).on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
});
