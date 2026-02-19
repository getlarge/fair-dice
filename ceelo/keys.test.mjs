import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadOrCreateKey, fingerprint, sign, verify } from './keys.js';

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem:  publicKey.export({ type: 'spki',  format: 'pem' }),
  };
}

// ── fingerprint ───────────────────────────────────────────────────────────────

test('fingerprint is deterministic for the same key', () => {
  const { pubPem } = generateKeypair();
  assert.equal(fingerprint(pubPem), fingerprint(pubPem));
});

test('fingerprint differs for different keys', () => {
  const a = generateKeypair();
  const b = generateKeypair();
  assert.notEqual(fingerprint(a.pubPem), fingerprint(b.pubPem));
});

test('fingerprint format is colon-separated 8-hex-char groups', () => {
  const { pubPem } = generateKeypair();
  const fp = fingerprint(pubPem);
  assert.match(fp, /^([0-9a-f]{8}:){7}[0-9a-f]{8}$/);
});

// ── sign / verify ─────────────────────────────────────────────────────────────

test('sign + verify round-trips for arbitrary payloads', () => {
  const { privPem, pubPem } = generateKeypair();
  const payloads = [
    'hello world',
    'game-id:hand-1:abc123def456',
    '',
    'x'.repeat(10_000),
    '\u0000\u00ff binary-ish \n\t',
  ];
  for (const payload of payloads) {
    const sig = sign(payload, privPem);
    assert.ok(verify(payload, sig, pubPem), `payload: ${payload.slice(0, 40)}`);
  }
});

test('verify returns false for tampered payload', () => {
  const { privPem, pubPem } = generateKeypair();
  const sig = sign('original', privPem);
  assert.equal(verify('tampered', sig, pubPem), false);
});

test('verify returns false for wrong key', () => {
  const signer    = generateKeypair();
  const unrelated = generateKeypair();
  const sig = sign('payload', signer.privPem);
  assert.equal(verify('payload', sig, unrelated.pubPem), false);
});

test('verify returns false for truncated signature', () => {
  const { privPem, pubPem } = generateKeypair();
  const sig    = sign('payload', privPem);
  const sigBuf = Buffer.from(sig, 'base64');
  const bad    = sigBuf.slice(0, sigBuf.length - 4).toString('base64');
  assert.equal(verify('payload', bad, pubPem), false);
});

test('signature is a non-empty base64 string', () => {
  const { privPem } = generateKeypair();
  const sig = sign('test', privPem);
  assert.ok(typeof sig === 'string' && sig.length > 0);
  assert.doesNotThrow(() => Buffer.from(sig, 'base64'));
});

// ── loadOrCreateKey ───────────────────────────────────────────────────────────

test('loadOrCreateKey creates key files when absent', () => {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));
  const keyPath = path.join(dir, 'test.pem');

  assert.ok(!fs.existsSync(keyPath));
  const { privPem, pubPem } = loadOrCreateKey(keyPath);
  assert.ok(fs.existsSync(keyPath),           'private key file created');
  assert.ok(fs.existsSync(`${keyPath}.pub`),  'public key file created');
  assert.ok(privPem.includes('PRIVATE KEY'));
  assert.ok(pubPem.includes('PUBLIC KEY'));
});

test('loadOrCreateKey returns same key on subsequent calls', () => {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));
  const keyPath = path.join(dir, 'stable.pem');

  const first  = loadOrCreateKey(keyPath);
  const second = loadOrCreateKey(keyPath);
  assert.equal(fingerprint(first.pubPem), fingerprint(second.pubPem), 'same fingerprint on reload');
});

test('loadOrCreateKey strips stray content outside PEM block', () => {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));
  const keyPath = path.join(dir, 'dirty.pem');

  // Create a valid key first
  const { pubPem } = loadOrCreateKey(keyPath);

  // Append a comment after the PEM block (as if edited by hand)
  fs.writeFileSync(`${keyPath}.pub`, pubPem + '\n# this is a comment\n');

  const reloaded = loadOrCreateKey(keyPath);
  // Should still parse cleanly — the PEM regex strips the trailing comment
  assert.doesNotThrow(() => crypto.createPublicKey(reloaded.pubPem));
});

test('key produced by loadOrCreateKey can sign and verify', () => {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));
  const keyPath = path.join(dir, 'signable.pem');

  const { privPem, pubPem } = loadOrCreateKey(keyPath);
  const sig = sign('test message', privPem);
  assert.ok(verify('test message', sig, pubPem));
});
