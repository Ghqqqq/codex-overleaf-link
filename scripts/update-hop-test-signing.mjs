import crypto from 'node:crypto';

const DEFAULT_KEY_ID = 'release-2026-01';

export function createEphemeralReleaseSignature(manifestBytes, options = {}) {
  const bytes = Buffer.isBuffer(manifestBytes)
    ? manifestBytes
    : Buffer.from(manifestBytes || '');
  if (!bytes.length) {
    throw new Error('Update-hop rehearsal manifest is empty.');
  }
  const keyId = String(options.keyId || DEFAULT_KEY_ID);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(keyId)) {
    throw new Error('Update-hop rehearsal key id is invalid.');
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, bytes, privateKey);
  const signatureBytes = Buffer.from(`${JSON.stringify({
    keyId,
    algorithm: 'Ed25519',
    signature: signature.toString('base64')
  }, null, 2)}\n`);
  const publicKeyPem = publicKey.export({
    type: 'spki',
    format: 'pem'
  }).toString();

  return Object.freeze({
    keyId,
    publicKeyPem,
    signatureBytes
  });
}

export function replaceTrustedUpdateKeySource(source, options = {}) {
  const value = String(source || '');
  const keyId = String(options.keyId || DEFAULT_KEY_ID);
  const publicKeyPem = String(options.publicKeyPem || '').trimEnd();
  if (!publicKeyPem.startsWith('-----BEGIN PUBLIC KEY-----') ||
      !publicKeyPem.endsWith('-----END PUBLIC KEY-----')) {
    throw new Error('Update-hop rehearsal public key is not a PEM public key.');
  }

  const startToken = `  '${keyId}': [`;
  const endToken = "  ].join('\\n')";
  const start = value.indexOf(startToken);
  const endStart = start < 0 ? -1 : value.indexOf(endToken, start);
  if (start < 0 || endStart < 0) {
    throw new Error(`Trusted update key ${keyId} was not found in the temporary updater source.`);
  }
  const end = endStart + endToken.length;
  const rows = [...publicKeyPem.split(/\r?\n/), '']
    .map(line => `    ${JSON.stringify(line)}`)
    .join(',\n');
  const replacement = `${startToken}\n${rows}\n${endToken}`;
  return `${value.slice(0, start)}${replacement}${value.slice(end)}`;
}
