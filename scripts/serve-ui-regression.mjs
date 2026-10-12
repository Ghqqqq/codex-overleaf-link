#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = '/test/browser/p2-click-and-repaint.html';
const allowed = new Set([fixture,
  '/extension/src/content/moduleRegistryKernel.js',
  '/extension/src/shared/projectFiles.js',
  '/extension/src/content/otWarmMirrorController.js',
  '/extension/src/content/otWarmMirror.js',
  '/extension/src/content/runScrollLayout.js',
  '/extension/src/content/runRecoveryActions.js',
  '/extension/src/content/runTimelineView.js'
]);
const port = Number(process.env.PORT || 43187);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
http.createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' || !allowed.has(request.url)) {
    response.writeHead(404); response.end(); return;
  }
  try {
    const content = await fs.readFile(path.join(root, request.url));
    response.setHeader('Content-Type', request.url === fixture
      ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8');
    response.end(content);
  } catch {
    response.writeHead(500); response.end('Fixture unavailable');
  }
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Regression fixture: http://127.0.0.1:${port}${fixture}\n`);
});
