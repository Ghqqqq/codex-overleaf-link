const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { extractFunction } = require('./_helpers/extractFunction');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const smokeScriptPath = path.join(__dirname, '../scripts/smoke-extension.mjs');
const smokeScriptUrl = pathToFileURL(smokeScriptPath).href;

function runSmokeModuleScript(source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}


test('package exposes a real Chrome extension smoke-test entrypoint', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.equal(pkg.scripts['smoke:extension'], 'npm run build:content && node scripts/smoke-extension.mjs');
});

test('extension smoke script loads the unpacked extension and probes the Overleaf panel', () => {
  const source = fs.readFileSync(
    smokeScriptPath,
    'utf8'
  );

  assert.match(source, /--load-extension=/);
  assert.match(source, /--disable-extensions-except=/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /Runtime\.evaluate/);
  assert.match(source, /codex-overleaf-panel/);
  assert.match(source, /--url/);
});

test('parseArgs supports JSON output, probe selection, profile reuse, and keep-profile', () => {
  const result = runSmokeModuleScript(`
    import { parseArgs, normalizeProbes } from ${JSON.stringify(smokeScriptUrl)};
    const parsed = parseArgs([
      '--url', 'https://www.overleaf.com/project/65f00112233445566778899a',
      '--json', '/tmp/codex-overleaf-smoke.json',
      '--probe', 'native',
      '--profile-dir', '/tmp/codex-overleaf-profile',
      '--keep-profile'
    ]);
    console.log(JSON.stringify({
      url: parsed.url,
      jsonPath: parsed.jsonPath,
      probe: parsed.probe,
      profileDir: parsed.profileDir,
      keepProfile: parsed.keepProfile,
      normalized: normalizeProbes(parsed.probe)
    }));
  `);

  assert.deepEqual(result, {
    url: 'https://www.overleaf.com/project/65f00112233445566778899a',
    jsonPath: '/tmp/codex-overleaf-smoke.json',
    probe: 'native',
    profileDir: '/tmp/codex-overleaf-profile',
    keepProfile: true,
    normalized: ['native']
  });
});

test('normalizeProbes defaults to panel and expands all supported probes', () => {
  const result = runSmokeModuleScript(`
    import { normalizeProbes } from ${JSON.stringify(smokeScriptUrl)};
    console.log(JSON.stringify({
      defaultProbe: normalizeProbes(undefined),
      panel: normalizeProbes('panel'),
      native: normalizeProbes('native'),
      project: normalizeProbes('project'),
      diagnostics: normalizeProbes('diagnostics'),
      all: normalizeProbes('all')
    }));
  `);

  assert.deepEqual(result, {
    defaultProbe: ['panel'],
    panel: ['panel'],
    native: ['native'],
    project: ['project'],
    diagnostics: ['diagnostics'],
    all: ['panel', 'native', 'project', 'diagnostics']
  });
});

test('normalizeProbes rejects unsupported probes even when all is requested', () => {
  const result = runSmokeModuleScript(`
    import { normalizeProbes } from ${JSON.stringify(smokeScriptUrl)};
    let message = '';
    try {
      normalizeProbes(['all', 'bogus']);
    } catch (error) {
      message = error.message;
    }
    console.log(JSON.stringify({ message }));
  `);

  assert.match(result.message, /Unsupported smoke probe "bogus"/);
});

test('redactSmokeResult keeps only allowlisted fields and strips sensitive content', () => {
  const result = runSmokeModuleScript(`
    import { redactSmokeResult } from ${JSON.stringify(smokeScriptUrl)};
    const redacted = redactSmokeResult({
      timestamp: '2026-05-07T00:00:00.000Z',
      url: 'https://www.overleaf.com/project/raw-project-id',
      urlOrigin: 'https://www.overleaf.com',
      projectId: 'raw-project-id',
      projectIdHash: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      extensionVersion: '0.9.5',
      chromeVersion: 'Chrome/125.0.0.0',
      nativeCompatibility: {
        status: 'native_missing',
        rawMessage: 'token sk-test-1234567890abcdef should not leak'
      },
      probes: {
        project: {
          status: 'passed',
          fileCount: 2,
          textBytes: 42,
          files: [{ path: 'main.tex', content: 'Top secret theorem text' }],
          theoremExcerpt: 'Private theorem statement should not leak',
          arbitraryPreview: 'Private preview should not leak',
          nested: {
            privateSummary: 'Private summary should not leak'
          }
        },
        diagnostics: {
          status: 'failed',
          promptText: 'Rewrite this private paragraph',
          compileLog: 'LaTeX Error: private compile output',
          diff: '--- private diff',
          binaryBase64: 'VG9wIHNlY3JldCBiaW5hcnkgY29udGVudA=='
        }
      },
      metrics: {
        project: {
          durationMs: 12,
          fileCount: 2,
          textBytes: 42,
          secret: ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')
        }
      },
      errors: [{
        probe: 'native',
        message: 'Native failed while reading Private theorem statement should not leak with secret AWS key AKIA1234567890ABCDEF',
        theoremExcerpt: 'Private theorem statement should not leak',
        privateSummary: 'Private summary should not leak'
      }],
      promptText: 'Do not serialize this prompt',
      compileLog: 'Do not serialize this log',
      diff: 'Do not serialize this diff',
      binaryBase64: 'QUJDREVGR0g=',
      unexpected: 'remove me'
    });
    console.log(JSON.stringify(redacted));
  `);
  const serialized = JSON.stringify(result);

  assert.deepEqual(Object.keys(result), [
    'timestamp',
    'urlOrigin',
    'projectIdHash',
    'extensionVersion',
    'chromeVersion',
    'nativeCompatibility',
    'probes',
    'metrics',
    'errors'
  ]);
  assert.equal(
    result.projectIdHash,
    'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  );
  assert.equal(result.metrics.project.fileCount, 2);
  assert.equal(result.metrics.project.textBytes, 42);
  assert.doesNotMatch(serialized, /raw-project-id|Top secret theorem|Rewrite this private|LaTeX Error|private diff/);
  assert.doesNotMatch(serialized, /Private theorem|Private preview|Private summary|secret AWS key/);
  assert.doesNotMatch(serialized, /theoremExcerpt|arbitraryPreview|privateSummary|nested/);
  assert.doesNotMatch(serialized, /VG9wIHNlY3Jld|sk-test|ghp_|AKIA1234567890ABCDEF|Do not serialize/);
});

test('redactSmokeResult drops unknown native capability names before writing JSON', () => {
  const result = runSmokeModuleScript(`
    import { redactSmokeResult } from ${JSON.stringify(smokeScriptUrl)};
    const redacted = redactSmokeResult({
      nativeCompatibility: {
        status: 'ok',
        capabilities: {
          bridgePing: true,
          mirrorSync: true,
          secretTheoremPreview: true,
          privateProjectText: 'Private theorem statement should not leak',
          tokenStatus: 'sk-test-1234567890abcdef',
          nestedPreview: {
            secretTheoremPreview: 'Private nested theorem text',
            token: ['ghp', 'abcdefghijklmnopqrstuvwxyz123456'].join('_')
          }
        }
      }
    });
    console.log(JSON.stringify(redacted));
  `);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.nativeCompatibility.capabilities, {
    bridgePing: true,
    mirrorSync: true
  });
  assert.doesNotMatch(serialized, /secretTheoremPreview|privateProjectText|tokenStatus|nestedPreview/);
  assert.doesNotMatch(serialized, /Private theorem|sk-test|ghp_/);
});

test('redactSmokeResult drops non-boolean native capability values before writing JSON', () => {
  const result = runSmokeModuleScript(`
    import { redactSmokeResult } from ${JSON.stringify(smokeScriptUrl)};
    const redacted = redactSmokeResult({
      nativeCompatibility: {
        status: 'ok',
        capabilities: {
          bridgePing: 'alpha beta gamma',
          mirrorSync: true,
          mirrorPatchFiles: false,
          codexRun: 'Private theorem statement should not leak',
          codexCancel: 1
        }
      }
    });
    console.log(JSON.stringify(redacted));
  `);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.nativeCompatibility.capabilities, {
    mirrorSync: true,
    mirrorPatchFiles: false
  });
  assert.doesNotMatch(serialized, /bridgePing|codexRun|codexCancel/);
  assert.doesNotMatch(serialized, /alpha beta gamma|Private theorem/);
});

test('content script exposes a non-mutating smoke helper without project content', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );

  assert.match(contentScript, /CodexOverleafSmoke/);
  assert.match(contentScript, /probeNative/);
  assert.match(contentScript, /probeProject/);
  assert.match(contentScript, /sendBackgroundNative\(\{\s*method:\s*'bridge\.ping'/);
  assert.match(contentScript, /callPageBridge\('getProjectSnapshot',\s*\{[\s\S]*includeContent:\s*false/);
  assert.doesNotMatch(contentScript.match(/async function smokeProbeProject[\s\S]*?\n  \}/)?.[0] || '', /includeContent:\s*true/);
});

test('content smoke helper byte summary uses text content without returning content', () => {
  const contentScript = fs.readFileSync(
    path.join(__dirname, '../extension/src/content/contentRuntime.js'),
    'utf8'
  );
  const source = `
    ${extractFunction(contentScript, 'summarizeSmokeProjectBytes')}
    summarizeSmokeProjectBytes([
      { path: 'main.tex', kind: 'text', content: 'alpha beta\\n' },
      { path: 'unicode.tex', kind: 'text', content: 'snowman: \\u2603\\n' },
      { path: 'plot.pdf', kind: 'binary', size: 4 }
    ]);
  `;
  const bytes = vm.runInNewContext(source, { TextEncoder });

  assert.equal(bytes.text, Buffer.byteLength('alpha beta\n') + Buffer.byteLength('snowman: \u2603\n'));
  assert.equal(bytes.binary, 4);
  assert.doesNotMatch(JSON.stringify(bytes), /alpha beta|snowman/);
});

test('runProbe evaluates the panel probe without exposing project content', () => {
  const result = runSmokeModuleScript(`
    import { runProbe } from ${JSON.stringify(smokeScriptUrl)};
    const calls = [];
    const probe = await runProbe({
      async send(method, params) {
        calls.push({ method, params });
        return { result: { value: true } };
      }
    }, 'panel', { timeoutMs: 5, pollIntervalMs: 1 });
    console.log(JSON.stringify({ probe, calls }));
  `);

  assert.equal(result.probe.status, 'passed');
  assert.equal(result.probe.probe, 'panel');
  assert.equal(result.calls[0].method, 'Runtime.evaluate');
  assert.match(result.calls[0].params.expression, /codex-overleaf-panel/);
});

test('runProbe calls the content smoke helper for native status', () => {
  const result = runSmokeModuleScript(`
    import { runProbe } from ${JSON.stringify(smokeScriptUrl)};
    const calls = [];
    const probe = await runProbe({
      async send(method, params) {
        calls.push({ method, params });
        return {
          result: {
            value: {
              supported: true,
              ok: true,
              status: 'ok',
              nativeCompatibility: {
                status: 'ok',
                nativeVersion: '0.9.5',
                protocolVersion: '1'
              }
            }
          }
        };
      }
    }, 'native', { timeoutMs: 5, pollIntervalMs: 1 });
    console.log(JSON.stringify({ probe, calls }));
  `);
  const expression = result.calls[0].params.expression;

  assert.equal(result.probe.probe, 'native');
  assert.equal(result.probe.status, 'passed');
  assert.equal(result.probe.nativeCompatibility.status, 'ok');
  assert.match(expression, /CodexOverleafSmoke/);
  assert.match(expression, /probeNative/);
});

test('runProbe evaluates smoke helpers in the discovered content script context', () => {
  const result = runSmokeModuleScript(`
    import { runProbe } from ${JSON.stringify(smokeScriptUrl)};
    const calls = [];
    let contextListener = null;
    const probe = await runProbe({
      on(method, listener) {
        calls.push({ method: 'on', event: method });
        contextListener = listener;
        return () => calls.push({ method: 'off', event: method });
      },
      async send(method, params = {}) {
        calls.push({ method, params });
        if (method === 'Runtime.enable') {
          contextListener({ context: { id: 41, name: 'Codex Overleaf content script' } });
          return {};
        }
        if (params.expression.includes('smokeHelperAvailable')) {
          return { result: { value: true } };
        }
        return {
          result: {
            value: {
              supported: true,
              ok: true,
              nativeCompatibility: { status: 'ok' }
            }
          }
        };
      }
    }, 'native', { timeoutMs: 5, pollIntervalMs: 1 });
    const helperCall = calls.find(call => call.params?.expression?.includes('"probeNative"'));
    console.log(JSON.stringify({ probe, helperCall, calls }));
  `);

  assert.equal(result.probe.status, 'passed');
  assert.equal(result.helperCall.params.contextId, 41);
  assert.ok(result.calls.some(call => call.method === 'Runtime.enable'));
  assert.ok(result.calls.some(call => call.method === 'off' && call.event === 'Runtime.executionContextCreated'));
});

test('runProbe calls the content smoke helper for project counts without project text', () => {
  const result = runSmokeModuleScript(`
    import { runProbe } from ${JSON.stringify(smokeScriptUrl)};
    const calls = [];
    const probe = await runProbe({
      async send(method, params) {
        calls.push({ method, params });
        return {
          result: {
            value: {
              supported: true,
              ok: true,
              status: 'ok',
              counts: {
                files: 3,
                skipped: 1
              },
              bytes: {
                text: 1200,
                binary: 2048
              },
              privateSummary: 'private project body'
            }
          }
        };
      }
    }, 'project', { timeoutMs: 5, pollIntervalMs: 1 });
    console.log(JSON.stringify({ probe, calls }));
  `);
  const serialized = JSON.stringify(result);
  const expression = result.calls[0].params.expression;

  assert.equal(result.probe.probe, 'project');
  assert.equal(result.probe.status, 'passed');
  assert.equal(typeof result.probe.metrics.durationMs, 'number');
  assert.deepEqual({
    fileCount: result.probe.metrics.fileCount,
    skippedCount: result.probe.metrics.skippedCount,
    textBytes: result.probe.metrics.textBytes,
    binaryBytes: result.probe.metrics.binaryBytes
  }, {
    fileCount: 3,
    skippedCount: 1,
    textBytes: 1200,
    binaryBytes: 2048
  });
  assert.match(expression, /CodexOverleafSmoke/);
  assert.match(expression, /probeProject/);
  assert.doesNotMatch(serialized, /private project body|main\.tex/);
});

test('runProbe verifies diagnostics export surface without triggering an export', () => {
  const result = runSmokeModuleScript(`
    import { runProbe } from ${JSON.stringify(smokeScriptUrl)};
    const probe = await runProbe({
      async send() {
        return {
          result: {
            value: {
              supported: true,
              diagnosticsMenu: true,
              exportButton: true,
              resultSurface: true
            }
          }
        };
      }
    }, 'diagnostics', { timeoutMs: 5, pollIntervalMs: 1 });
    console.log(JSON.stringify(probe));
  `);

  assert.equal(result.probe, 'diagnostics');
  assert.equal(result.status, 'passed');
  assert.equal(result.metrics.diagnosticsMenu, true);
  assert.equal(result.metrics.exportButton, true);
  assert.equal(result.metrics.resultSurface, true);
});
