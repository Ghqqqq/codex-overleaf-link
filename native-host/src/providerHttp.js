'use strict';

const { providerError } = require('./providerProfile');
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type', 'content-length'];

function carriesEndpointCredentials(headers, launch) {
  const namedHeader = String(launch.apiKeyHeaderName || '').toLowerCase();
  return [...headers].some(([name, value]) => value && (
    name === namedHeader
    || /(?:^|[-_])(?:authorization|auth|api[-_]?key|token|secret|cookie|credential|password|signature)(?:$|[-_])/i.test(name)
    || launch.apiKey && value.includes(launch.apiKey)
  ));
}

// Fetch's method/body redirect rules remain intact. Credentials configured for
// this endpoint never authorize a request to a different origin.
async function fetchProvider(url, options, launch = {}) {
  let current = new URL(url);
  let method = String(options.method || 'GET').toUpperCase();
  let body = options.body;
  const headers = new Headers(options.headers);
  const credentialed = carriesEndpointCredentials(headers, launch);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(current, { ...options, method, body, headers, redirect: 'manual' });
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    await response.body?.cancel().catch(() => {});
    if (redirects >= 20) throw providerError('provider_upstream_error', 'The provider exceeded the redirect limit.');
    let next;
    try { next = new URL(location, current); }
    catch (_) { throw providerError('provider_upstream_error', 'The provider returned an invalid redirect.'); }
    if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password) {
      throw providerError('provider_upstream_error', 'The provider returned an unsupported redirect.');
    }
    if (credentialed && next.origin !== current.origin) {
      throw providerError('provider_upstream_error', 'The provider redirected to a different origin; endpoint credentials were not forwarded.');
    }
    if ((response.status === 301 || response.status === 302) && method === 'POST'
      || response.status === 303 && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    current = next;
  }
}

// Preserve ordinary Response.text()/json() capacity and UTF-8 semantics while
// reporting each body chunk to the existing idle lifecycle. Compact/SSE limits
// remain in their own readers; this does not introduce a new response cap.
async function readProviderText(response, onActivity = () => {}) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      onActivity();
      chunks.push(decoder.decode(value, { stream: true }));
    }
    complete = true;
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readProviderJson(response, onActivity) {
  const text = await readProviderText(response, onActivity);
  try { return JSON.parse(text); }
  catch (_) { throw providerError('provider_response_invalid', 'The provider returned an invalid JSON response.'); }
}

module.exports = { fetchProvider, readProviderText, readProviderJson };
