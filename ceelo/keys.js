'use strict';

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function defaultKeyPath(kind = 'player') {
  const base = path.join(os.homedir(), '.fair-dice', 'keys');
  ensureDir(base);
  return path.join(base, `${kind}_ed25519.pem`);
}

function loadOrCreateKey(keyPath = defaultKeyPath()) {
  ensureDir(path.dirname(keyPath));

  const generate = () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(
      keyPath,
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      `${keyPath}.pub`,
      publicKey.export({ type: 'spki', format: 'pem' }),
    );
  };

  if (!fs.existsSync(keyPath) || !fs.existsSync(`${keyPath}.pub`)) {
    generate();
  }

  let privPem = fs.readFileSync(keyPath, 'utf8');
  let rawPub = fs.readFileSync(`${keyPath}.pub`, 'utf8');
  let match = rawPub.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
  let pubPem = match ? match[0] : rawPub.trim();

  // Validate; if invalid (e.g., legacy file with comments), regenerate once
  try {
    crypto.createPublicKey(pubPem);
  } catch (err) {
    console.warn(`Invalid public key at ${keyPath}.pub, regenerating...`);
    generate();
    privPem = fs.readFileSync(keyPath, 'utf8');
    rawPub = fs.readFileSync(`${keyPath}.pub`, 'utf8');
    match = rawPub.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
    pubPem = match ? match[0] : rawPub.trim();
  }

  return { privPem, pubPem };
}

function fingerprint(pubPem) {
  const der = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
  const hash = crypto.createHash('sha256').update(der).digest('hex');
  return hash.match(/.{1,8}/g).join(':');
}

function sign(detachedPayload, privPem) {
  return crypto.sign(null, Buffer.from(detachedPayload), privPem).toString('base64');
}

function verify(detachedPayload, signatureB64, pubPem) {
  return crypto.verify(
    null,
    Buffer.from(detachedPayload),
    pubPem,
    Buffer.from(signatureB64, 'base64'),
  );
}

export {
  loadOrCreateKey,
  fingerprint,
  sign,
  verify,
  defaultKeyPath,
};
