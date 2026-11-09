'use strict';

const { runOwnedNativeHelper } = require('./nativeHelperLifecycle');
const { stopCodexAppServer } = require('./codexSessionTiming');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCodexCommand, shouldUseShellForCommand } = require('./codexCommand');
const { applyProviderEnvironment, buildProviderConfigArgs, prepareProviderLaunch } = require('./codexProviderLaunch');
const { providerError } = require('./providerProfile');

const MAX_OUTPUT_BYTES = 256 * 1024;
const TEST_PROMPT = 'Use the shell tool to read provider-step-one.txt. It contains the name of a second file. Then use a separate shell tool call to read that second file. Reply only with the exact contents of the second file.';

async function runProviderConnectionTest({ launch, env = process.env, signal } = {}) {
  throwIfTestCancelled(signal);
  return runOwnedNativeHelper(async ownedSignal => {
    throwIfTestCancelled(ownedSignal);
    const prepared = await prepareProviderLaunch(launch, { signal: ownedSignal });
    try {
      throwIfTestCancelled(ownedSignal);
      return await runProviderConnectionTestProcess({ launch: prepared.launch, env, signal: ownedSignal });
    } finally {
      await prepared.close();
    }
  }, signal);
}

function runProviderConnectionTestProcess({ launch, env = process.env, signal } = {}) {
  return new Promise((resolve, reject) => {
    throwIfTestCancelled(signal);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-overleaf-provider-test-'));
    const codexHome = path.join(root, 'codex-home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const verificationToken = `provider-tool-check-${crypto.randomUUID()}`;
    const secondFileName = `provider-check-${crypto.randomUUID()}.txt`;
    fs.writeFileSync(path.join(workspace, 'provider-step-one.txt'), `${secondFileName}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, secondFileName), `${verificationToken}\n`, { mode: 0o600 });
    const childEnv = applyProviderEnvironment({
      ...env,
      CODEX_HOME: codexHome
    }, launch);
    const command = resolveCodexCommand(childEnv);
    if (!command) {
      cleanup(root);
      reject(providerError('codex_not_found', 'Codex CLI was not found locally.'));
      return;
    }
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '-'
    ];
    const startedAt = Date.now();
    let child;
    try {
      throwIfTestCancelled(signal);
      // The shared builder emits -c/TOML pairs. Keep those values out of cmd.exe:
      // names, model IDs and catalog paths may contain quotes or shell syntax.
      const config = buildProviderConfigArgs(launch).filter((_, index) => index % 2 === 1);
      if (process.platform === 'win32') {
        // The isolated home cannot inherit the desktop's sandbox selection.
        // Let Codex prefer MXC where supported, retaining its legacy fallback
        // and managed policy rather than forcing MXC or removing the sandbox.
        config.push('features.prefer_mxc=true');
      }
      fs.writeFileSync(path.join(codexHome, 'config.toml'), config.join('\n') + '\n', { mode: 0o600 });
      const shell = shouldUseShellForCommand(command, childEnv);
      if (shell) childEnv.CODEX_OVERLEAF_TEST_COMMAND = command;
      child = spawn(shell ? (childEnv.ComSpec || childEnv.COMSPEC || 'cmd.exe') : command, shell
        // Only fixed arguments enter the command string. Expanding the quoted
        // path from the environment also preserves literal % and ! in it.
        ? ['/d', '/v:off', '/s', '/c', `""%CODEX_OVERLEAF_TEST_COMMAND%" ${args.join(' ')}"`]
        : args, {
        cwd: workspace,
        env: childEnv,
        windowsVerbatimArguments: shell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      cleanup(root);
      reject(error?.code === 'provider_test_cancelled' ? error
        : providerError('provider_test_spawn_failed', 'Codex could not start the provider connection test.', { cause: error }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = Math.min(120000, Math.max(5000, Number(launch.requestTimeoutMs) || 30000));
    const timer = setTimeout(() => finish(providerError('provider_connection_timeout', 'The provider connection test timed out.')), timeoutMs);
    const onAbort = () => finish(providerError('provider_test_cancelled', 'Provider connection test was cancelled.'));
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr.on('data', chunk => appendOutput('stderr', chunk));
    child.on('error', error => finish(providerError('provider_test_spawn_failed', 'Codex could not start the provider connection test.', { cause: error })));
    child.on('close', code => {
      if (hasLeakedToolControlTokens(`${stdout}\n${stderr}`)) {
        finish(providerError(
          'provider_stream_tool_parse_failed',
          'The provider leaked unparsed tool-call control tokens while streaming.'
        ));
        return;
      }
      if (code === 0 && stdout.includes(verificationToken)) {
        finish(null, {
          durationMs: Date.now() - startedAt,
          capabilities: {
            text: true,
            streaming: true,
            agentTools: true,
            toolRoundTrip: true
          }
        });
        return;
      }
      if (code === 0) {
        finish(providerError(
          'provider_agent_tools_incompatible',
          'The provider returned text but did not complete the required Codex tool call.'
        ));
        return;
      }
      finish(classifyProviderFailure(stderr || stdout, code));
    });
    child.stdin.on('error', error => {
      // Early CLI rejection can close stdin before the write completes; the
      // close handler still owns the useful exit status and stderr diagnosis.
      if (error.code !== 'EPIPE') finish(providerError('provider_test_spawn_failed', 'Codex could not receive the provider connection test.', { cause: error }));
    });
    child.stdin.end(TEST_PROMPT);

    function appendOutput(target, chunk) {
      if (settled) return;
      if (target === 'stdout') stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
        finish(providerError('provider_response_invalid', 'Provider connection test exceeded the output limit.'));
      }
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      stopCodexAppServer(child, { processGroup: process.platform !== 'win32', reason: error }).then(() => {
        cleanup(root);
        if (error) reject(error); else resolve(result);
      }, stopError => { cleanup(root); reject(stopError); });
    }
  });
}

function classifyProviderFailure(text, exitCode) {
  const message = String(text || '');
  if (hasLeakedToolControlTokens(message) || /provider_stream_tool_parse_failed/i.test(message)) {
    return providerError('provider_stream_tool_parse_failed', 'The provider failed to parse streaming tool calls.');
  }
  if (/\b401\b|unauthori[sz]ed|invalid api key|incorrect api key|authentication/i.test(message)) {
    return providerError('provider_auth_rejected', 'The provider rejected the API key.');
  }
  if (/\b403\b|forbidden/i.test(message)) {
    return providerError('provider_auth_rejected', 'The provider denied access for this credential.');
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) {
    return providerError('provider_rate_limited', 'The provider rate limit was reached.');
  }
  if (/model.{0,40}(not found|does not exist|unknown)|\b404\b.{0,80}model/i.test(message)) {
    return providerError('provider_model_not_found', 'The configured model was not found.');
  }
  if (/certificate|self.signed|tls|ssl/i.test(message)) {
    return providerError('provider_tls_failed', 'TLS verification failed for the provider endpoint.');
  }
  if (/enotfound|eai_again|name or service not known|dns/i.test(message)) {
    return providerError('provider_dns_failed', 'The provider hostname could not be resolved.');
  }
  if (/\b404\b|\b405\b|cannot\s+(?:post|get)|(?:route|endpoint).{0,40}(?:not found|unsupported)|unsupported.{0,30}(?:endpoint|api|protocol)|responses.{0,30}(?:unsupported|not found)|chat\/completions.{0,30}(?:unsupported|not found)|v1\/messages.{0,30}(?:unsupported|not found)/i.test(message)) {
    return providerError('provider_protocol_incompatible', 'The endpoint is incompatible with this API protocol.');
  }
  if (/\b400\b|\b415\b|\b422\b|invalid.{0,30}(?:request|parameter|field)|unknown.{0,20}(?:field|parameter)|unsupported.{0,30}(?:field|parameter|tool|schema)|max[_ -]?tokens|context.{0,30}(?:length|window|limit)/i.test(message)) {
    return providerError('provider_request_rejected', 'The provider rejected this protocol probe request. Review the model and compatibility settings.');
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return providerError('provider_connection_timeout', 'The provider connection timed out.');
  }
  return providerError('provider_response_invalid', `Provider connection test failed with exit code ${exitCode}.`);
}

function hasLeakedToolControlTokens(value) {
  return /<\|tool_call_(?:begin|argument_begin|end)\|>/i.test(String(value || ''));
}

function throwIfTestCancelled(signal) {
  if (signal?.aborted) throw providerError('provider_test_cancelled', 'Provider connection test was cancelled.');
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_error) {}
}

module.exports = {
  classifyProviderFailure,
  runProviderConnectionTest
};
