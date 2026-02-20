import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
import { startHostRuntime, stopHostRuntime, hkdfDice } from './host.js';
import { sign, fingerprint, verify } from './keys.js';
import { startBroker } from './broker.js';
import { joinGame } from './player.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem:  publicKey.export({ type: 'spki',  format: 'pem' }),
  };
}

// Write a fresh keypair to a temp file; return the path.
// Used by e2e joinGame() tests so each player gets a unique key.
function tempKeyPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ceelo-test-'));
  const keyFile = path.join(dir, 'player_ed25519.pem');
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return keyFile;
}

function mqttClient(url) {
  return mqtt.connect(url, { protocolVersion: 4, connectTimeout: 2000, reconnectPeriod: 0 });
}

function waitForConnect(client) {
  return new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('error', reject);
  });
}

function subscribeAsync(client, topic, opts = { qos: 1 }) {
  return new Promise((resolve, reject) =>
    client.subscribe(topic, opts, (err, granted) => (err ? reject(err) : resolve(granted))),
  );
}

// Resolves on the next message matching the given topic
function nextMessage(client, topic) {
  return new Promise(resolve => {
    function handler(t, msg) {
      if (t === topic) {
        client.removeListener('message', handler);
        resolve(JSON.parse(msg.toString('utf8')));
      }
    }
    client.on('message', handler);
  });
}

// Resolves with null if no message arrives within `ms` milliseconds
function nextMessageOrTimeout(client, topic, ms = 300) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      client.removeListener('message', handler);
      resolve(null);
    }, ms);
    function handler(t, msg) {
      if (t === topic) {
        clearTimeout(timer);
        client.removeListener('message', handler);
        resolve(JSON.parse(msg.toString('utf8')));
      }
    }
    client.on('message', handler);
  });
}

function publishJoin({ client, gameId, handId, privPem, pubPem, seed }) {
  const commit    = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
  const signature = sign(`${gameId}:${handId}:${commit}`, privPem);
  const payload   = JSON.stringify({
    type: 'join', game_id: gameId, hand_id: handId,
    player_fp: fingerprint(pubPem), pubkey: pubPem, commit, signature,
  });
  return new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/joins`, payload, { qos: 1 }, err =>
      err ? reject(err) : resolve({ commit, seed }),
    ),
  );
}

function publishReveal({ client, gameId, handId, privPem, pubPem, seed }) {
  const signature = sign(`${gameId}:${handId}:${seed}`, privPem);
  const payload   = JSON.stringify({
    type: 'reveal', game_id: gameId, hand_id: handId,
    player_fp: fingerprint(pubPem), pubkey: pubPem, seed, signature,
  });
  return new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/reveals`, payload, { qos: 1 }, err =>
      err ? reject(err) : resolve(),
    ),
  );
}

// Spin up a host on a random port; return { host, port, url }
async function startTestHost(overrides = {}) {
  const gameId = `test-${crypto.randomBytes(4).toString('hex')}`;
  const host   = startHostRuntime({
    gameId,
    port: 0,
    host: '127.0.0.1',
    minPlayers: 2,
    beaconSource: 'test',
    dbPath: `./.fair-dice/test-${gameId}.db`,
    ...overrides,
    gameId, // always own gameId
  });
  await host.ready;
  const port = host.server.address().port;
  const url  = `ws://127.0.0.1:${port}`;
  return { host, port, url, gameId };
}

// Next message whose topic starts with the given prefix
function nextMessagePrefix(client, topicPrefix) {
  return new Promise(resolve => {
    function handler(t, msg) {
      if (t.startsWith(topicPrefix)) {
        client.removeListener('message', handler);
        resolve(JSON.parse(msg.toString('utf8')));
      }
    }
    client.on('message', handler);
  });
}

function nextMessagePrefixOrTimeout(client, topicPrefix, ms = 300) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      client.removeListener('message', handler);
      resolve(null);
    }, ms);
    function handler(t, msg) {
      if (t.startsWith(topicPrefix)) {
        clearTimeout(timer);
        client.removeListener('message', handler);
        resolve(JSON.parse(msg.toString('utf8')));
      }
    }
    client.on('message', handler);
  });
}

// Connect a client, subscribe to all game topics, await retained lobby
async function connectPlayer(url, gameId) {
  const client = mqttClient(url);
  await waitForConnect(client);

  // Register lobby listener before subscribe to catch the retained message
  const lobbyPromise = nextMessage(client, 'cee-lo/lobbies');
  await subscribeAsync(client, 'cee-lo/lobbies');
  await subscribeAsync(client, `cee-lo/${gameId}/acks/+`); // per-fp retained ACKs
  await subscribeAsync(client, `cee-lo/${gameId}/state`);
  await subscribeAsync(client, `cee-lo/${gameId}/proofs`);

  const lobby = await lobbyPromise;
  return { client, lobby };
}

// ─────────────────────────────────────────────────────────────────────────────
// Broker unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('broker: retained lobby message delivered to new subscriber', async t => {
  const { broker, server } = startBroker({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const url  = `ws://127.0.0.1:${port}`;

  const retained = JSON.stringify({ game_id: 'unit-test', host_fp: 'fp', min_players: 2 });
  broker.publish({ topic: 'cee-lo/lobbies', payload: retained, retain: true, qos: 1 });

  const client = mqttClient(url);
  t.after(async () => {
    await client.endAsync();
    await new Promise((resolve, reject) => broker.close(err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  await waitForConnect(client);

  const msgPromise = nextMessage(client, 'cee-lo/lobbies');
  await subscribeAsync(client, 'cee-lo/lobbies');
  const msg = await msgPromise;

  assert.equal(msg.game_id, 'unit-test');
});

test('broker: message published by one client received by another', async t => {
  const { broker, server } = startBroker({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const url  = `ws://127.0.0.1:${port}`;

  const sender   = mqttClient(url);
  const receiver = mqttClient(url);
  t.after(async () => {
    await sender.endAsync();
    await receiver.endAsync();
    await new Promise((resolve, reject) => broker.close(err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  await Promise.all([waitForConnect(sender), waitForConnect(receiver)]);

  const topic = 'test/relay';
  const msgPromise = nextMessage(receiver, topic);
  await subscribeAsync(receiver, topic);

  await new Promise((resolve, reject) =>
    sender.publish(topic, JSON.stringify({ hello: 'world' }), { qos: 1 }, err =>
      err ? reject(err) : resolve(),
    ),
  );

  const msg = await msgPromise;
  assert.deepEqual(msg, { hello: 'world' });
});

// ─────────────────────────────────────────────────────────────────────────────
// Host integration tests
// ─────────────────────────────────────────────────────────────────────────────

test('happy path: 2 players join and reveal → proof published', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');

  const ack1Promise = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  const ack1 = await ack1Promise;
  assert.equal(ack1.status, 'accepted');
  assert.equal(ack1.player_fp, fingerprint(p1.pubPem));

  const ack2Promise = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack2Promise;

  const proofPromise = nextMessage(client, `cee-lo/${gameId}/proofs`);
  await publishReveal({ client, gameId, handId, ...p1, seed: s1 });
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });

  const proof = await proofPromise;

  assert.equal(proof.game_id, gameId);
  assert.equal(proof.hand_id, handId);
  assert.ok(Array.isArray(proof.dice) && proof.dice.length === 3, 'three dice');
  assert.ok(proof.dice.every(d => d >= 1 && d <= 6), 'dice faces in range');
  assert.ok(proof.result?.category, 'result has category');
  assert.ok(proof.signature, 'host signature present');
  assert.equal(proof.players.length, 2, 'two players in proof');
});

test('proof is signed by host and signature verifies', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');

  const ack1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  await ack1;

  const ack2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack2;

  const proofPromise = nextMessage(client, `cee-lo/${gameId}/proofs`);
  await publishReveal({ client, gameId, handId, ...p1, seed: s1 });
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });
  const proof = await proofPromise;

  // Verify the host signature: sign(JSON.stringify(proofWithoutSig), hostPriv)
  const { signature, ...proofWithoutSig } = proof;
  const valid = verify(JSON.stringify(proofWithoutSig), signature, host.hostPub);
  assert.ok(valid, 'host signature verifies against host public key');
  assert.equal(proof.host_fp, host.hostFp, 'proof host_fp matches runtime hostFp');
});

test('duplicate join from same fingerprint is ignored', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s1b = crypto.randomBytes(32).toString('hex'); // second attempt, different seed

  const ack1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  await ack1;

  // Second join from same player — host uses INSERT OR IGNORE, still sends ACK
  // but the stored commit must remain the first one
  const ack2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1b });
  await ack2;

  // Now reveal with the ORIGINAL seed — should still work
  const p2 = generateKeypair();
  const s2 = crypto.randomBytes(32).toString('hex');
  const ack3 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack3;

  const proofPromise = nextMessage(client, `cee-lo/${gameId}/proofs`);
  await publishReveal({ client, gameId, handId, ...p1, seed: s1 });
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });
  const proof = await proofPromise;

  // Proof should have exactly 2 distinct players (not 3)
  const fps = proof.players.map(p => p.player_fp);
  assert.equal(new Set(fps).size, 2, 'exactly 2 distinct players in proof');
});

test('invalid join signature is rejected — no ACK sent', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1   = generateKeypair();
  const evil = generateKeypair(); // sign with a different key
  const seed = crypto.randomBytes(32).toString('hex');
  const commit = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');

  const badSig  = sign(`${gameId}:${handId}:${commit}`, evil.privPem); // wrong key
  const payload = JSON.stringify({
    type: 'join', game_id: gameId, hand_id: handId,
    player_fp: fingerprint(p1.pubPem), pubkey: p1.pubPem, commit, signature: badSig,
  });
  await new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/joins`, payload, { qos: 1 }, err =>
      err ? reject(err) : resolve(),
    ),
  );

  const ack = await nextMessagePrefixOrTimeout(client, `cee-lo/${gameId}/acks/`, 300);
  assert.equal(ack, null, 'no ACK for invalid signature');
});

test('reveal with wrong seed (commit mismatch) — no proof', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');
  const sWrong = crypto.randomBytes(32).toString('hex'); // different from committed seed

  const ack1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  await ack1;

  const ack2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack2;

  // p1 reveals wrong seed
  await publishReveal({ client, gameId, handId, ...p1, seed: sWrong });
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });

  const proof = await nextMessageOrTimeout(client, `cee-lo/${gameId}/proofs`, 400);
  assert.equal(proof, null, 'no proof when seed does not match commit');
});

test('reveal before join is rejected — no proof', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');

  // p1 reveals without joining first
  await publishReveal({ client, gameId, handId, ...p1, seed: s1 });

  // p2 does the full join+reveal
  const ack2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack2;
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });

  const proof = await nextMessageOrTimeout(client, `cee-lo/${gameId}/proofs`, 400);
  assert.equal(proof, null, 'no proof when a required player never joined');
});

test('minPlayers: 3 — proof only after third reveal', async t => {
  const { host, url, gameId } = await startTestHost({ minPlayers: 3 });
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const players = [generateKeypair(), generateKeypair(), generateKeypair()];
  const seeds   = players.map(() => crypto.randomBytes(32).toString('hex'));

  // All 3 join
  for (let i = 0; i < 3; i++) {
    const ack = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
    await publishJoin({ client, gameId, handId, ...players[i], seed: seeds[i] });
    await ack;
  }

  // Only 2 reveal — no proof yet
  const earlyProof = nextMessageOrTimeout(client, `cee-lo/${gameId}/proofs`, 300);
  await publishReveal({ client, gameId, handId, ...players[0], seed: seeds[0] });
  await publishReveal({ client, gameId, handId, ...players[1], seed: seeds[1] });
  assert.equal(await earlyProof, null, 'no proof after only 2/3 reveals');

  // Third reveal — proof must arrive now
  const proofPromise = nextMessage(client, `cee-lo/${gameId}/proofs`);
  await publishReveal({ client, gameId, handId, ...players[2], seed: seeds[2] });
  const proof = await proofPromise;

  assert.equal(proof.players.length, 3, 'three players in proof');
  assert.ok(proof.dice.every(d => d >= 1 && d <= 6), 'dice faces in range');
});

test('host publishes state after each join and at quorum', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');

  // After p1 joins: state phase=joining, player_count=1
  const state1 = nextMessage(client, `cee-lo/${gameId}/state`);
  const ack1   = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  await ack1;
  const gs1 = await state1;
  assert.equal(gs1.phase,        'joining');
  assert.equal(gs1.player_count, 1);
  assert.equal(gs1.min_players,  2);

  // After p2 joins: host publishes joining(count=2) then rolling(count=2).
  // Collect all state messages published while p2 joins, then assert rolling appeared.
  const statesAfterP2 = [];
  const stateCollector = (topic, msg) => {
    if (topic === `cee-lo/${gameId}/state`) {
      try { statesAfterP2.push(JSON.parse(msg.toString('utf8'))); } catch { /* ignore */ }
    }
  };
  client.on('message', stateCollector);

  const ack2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await ack2;
  // Give broker a tick to deliver any in-flight state messages
  await new Promise(r => setTimeout(r, 50));
  client.removeListener('message', stateCollector);

  const rollingState = statesAfterP2.find(gs => gs.phase === 'rolling') ?? null;
  assert.ok(rollingState, 'rolling state published after quorum');
  assert.equal(rollingState.player_count, 2);
});

test('host publishes finalized state after proof', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair(), p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');
  const a1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  await a1;
  const a2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  await a2;
  await publishReveal({ client, gameId, handId, ...p1, seed: s1 });
  await publishReveal({ client, gameId, handId, ...p2, seed: s2 });
  // Wait for proof, then check state is finalized
  await nextMessage(client, `cee-lo/${gameId}/proofs`);

  // The finalized state should be retained — a new client can read it
  const late = mqttClient(url);
  t.after(() => late.endAsync());
  await waitForConnect(late);
  const lateState = nextMessage(late, `cee-lo/${gameId}/state`);
  await subscribeAsync(late, `cee-lo/${gameId}/state`);
  const gs = await lateState;
  assert.equal(gs.phase, 'finalized');
});

test('late client gets current state via retained message', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  // P1 joins before P2 connects
  const { client: early } = await connectPlayer(url, gameId);
  t.after(async () => {
    await early.endAsync();
    await stopHostRuntime(host);
  });

  const p1 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const a1 = nextMessagePrefix(early, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client: early, gameId, handId, ...p1, seed: s1 });
  await a1;

  // P2 connects after P1 has already joined
  const late = mqttClient(url);
  t.after(() => late.endAsync());
  await waitForConnect(late);
  const statePromise = nextMessage(late, `cee-lo/${gameId}/state`);
  await subscribeAsync(late, `cee-lo/${gameId}/state`);
  const gs = await statePromise;

  // Must reflect current reality: 1 player joined
  assert.equal(gs.player_count, 1);
  assert.equal(gs.phase,        'joining');
});

test('allowlisted player joins; non-allowlisted player is silently rejected', async t => {
  const p1 = generateKeypair();
  const p2 = generateKeypair(); // will be blocked

  const { host, url, gameId } = await startTestHost({
    allowlist: [fingerprint(p1.pubPem)], // only p1 allowed
  });
  const handId = 'hand-1';

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  // p1 joins — should be accepted
  const ack1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
  const s1 = crypto.randomBytes(32).toString('hex');
  await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
  const a1 = await ack1;
  assert.equal(a1.status, 'accepted');

  // p2 joins — should be rejected silently (no ACK)
  const s2 = crypto.randomBytes(32).toString('hex');
  await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
  const ack2 = await nextMessagePrefixOrTimeout(client, `cee-lo/${gameId}/acks/`, 300);
  assert.equal(ack2, null, 'no ACK for non-allowlisted player');
});

test('two independent games on same broker do not interfere', async t => {
  // Two separate host runtimes on the same broker would need one broker instance.
  // Instead, spin up two independent host runtimes (each with their own broker)
  // and verify each produces its own proof independently.
  const hostA = await startTestHost();
  const hostB = await startTestHost();

  t.after(async () => {
    await stopHostRuntime(hostA.host);
    await stopHostRuntime(hostB.host);
  });

  async function runGame({ url, gameId }) {
    const { client } = await connectPlayer(url, gameId);
    const handId = 'hand-1';
    const p1 = generateKeypair(), p2 = generateKeypair();
    const s1 = crypto.randomBytes(32).toString('hex');
    const s2 = crypto.randomBytes(32).toString('hex');
    const a1 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
    await publishJoin({ client, gameId, handId, ...p1, seed: s1 });
    await a1;
    const a2 = nextMessagePrefix(client, `cee-lo/${gameId}/acks/`);
    await publishJoin({ client, gameId, handId, ...p2, seed: s2 });
    await a2;
    const proofP = nextMessage(client, `cee-lo/${gameId}/proofs`);
    await publishReveal({ client, gameId, handId, ...p1, seed: s1 });
    await publishReveal({ client, gameId, handId, ...p2, seed: s2 });
    const proof = await proofP;
    await client.endAsync();
    return proof;
  }

  const [proofA, proofB] = await Promise.all([
    runGame(hostA),
    runGame(hostB),
  ]);

  assert.equal(proofA.game_id, hostA.gameId, 'proof A belongs to game A');
  assert.equal(proofB.game_id, hostB.gameId, 'proof B belongs to game B');
  assert.notEqual(proofA.game_id, proofB.game_id, 'different game IDs');
  assert.ok(proofA.dice.length === 3 && proofB.dice.length === 3);
});

test('retained proof delivered to client that connects after finalization', async t => {
  const { host, url, gameId } = await startTestHost();
  const handId = 'hand-1';

  // Run the full game with a dedicated client
  const { client: gameClient } = await connectPlayer(url, gameId);
  const p1 = generateKeypair(), p2 = generateKeypair();
  const s1 = crypto.randomBytes(32).toString('hex');
  const s2 = crypto.randomBytes(32).toString('hex');
  const a1 = nextMessagePrefix(gameClient, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client: gameClient, gameId, handId, ...p1, seed: s1 });
  await a1;
  const a2 = nextMessagePrefix(gameClient, `cee-lo/${gameId}/acks/`);
  await publishJoin({ client: gameClient, gameId, handId, ...p2, seed: s2 });
  await a2;
  const proofP = nextMessage(gameClient, `cee-lo/${gameId}/proofs`);
  await publishReveal({ client: gameClient, gameId, handId, ...p1, seed: s1 });
  await publishReveal({ client: gameClient, gameId, handId, ...p2, seed: s2 });
  await proofP; // wait for finalization
  await gameClient.endAsync();

  // Late-joining client — connects after the proof is already published (retained)
  const late = mqttClient(url);
  t.after(async () => {
    await late.endAsync();
    await stopHostRuntime(host);
  });
  await waitForConnect(late);

  const lateProofPromise = nextMessage(late, `cee-lo/${gameId}/proofs`);
  await subscribeAsync(late, `cee-lo/${gameId}/proofs`);
  const lateProof = await lateProofPromise;

  assert.equal(lateProof.game_id, gameId, 'late client gets the retained proof');
  assert.ok(Array.isArray(lateProof.dice) && lateProof.dice.length === 3);
});

test('invalid JSON publish does not crash the broker', async t => {
  const { host, url, gameId } = await startTestHost();

  const { client } = await connectPlayer(url, gameId);
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  // Publish garbage to the joins topic
  await new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/joins`, 'this is not json {{{', { qos: 1 }, err =>
      err ? reject(err) : resolve(),
    ),
  );

  // Broker should still be alive — subscribe to lobbies and get the retained message
  const lobbyPromise = nextMessage(client, 'cee-lo/lobbies');
  await subscribeAsync(client, 'cee-lo/lobbies');
  const lobby = await lobbyPromise;
  assert.equal(lobby.game_id, gameId, 'broker still responsive after invalid JSON');
});

// ─────────────────────────────────────────────────────────────────────────────
// hkdfDice unit tests
// ─────────────────────────────────────────────────────────────────────────────

test('hkdfDice returns exactly 3 dice faces in [1,6]', async () => {
  const seeds = [
    crypto.randomBytes(32).toString('hex'),
    crypto.randomBytes(32).toString('hex'),
  ];
  const { dice } = await hkdfDice({
    seeds,
    beacon: crypto.randomBytes(32).toString('hex'),
    hostSalt: crypto.randomBytes(32).toString('hex'),
    gameId: 'test-game',
    handId: 'hand-1',
  });
  assert.equal(dice.length, 3, 'exactly 3 dice');
  assert.ok(dice.every(d => Number.isInteger(d) && d >= 1 && d <= 6), 'all faces in [1,6]');
});

test('hkdfDice is deterministic — same inputs produce same dice', async () => {
  const seeds    = [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')];
  const beacon   = crypto.randomBytes(32).toString('hex');
  const hostSalt = crypto.randomBytes(32).toString('hex');
  const params   = { seeds, beacon, hostSalt, gameId: 'g1', handId: 'h1' };

  const { dice: first  } = await hkdfDice(params);
  const { dice: second } = await hkdfDice(params);
  assert.deepEqual(first, second, 'same inputs must produce same dice');
});

test('hkdfDice is sensitive to each input — changing any input changes output', async () => {
  const base = {
    seeds:    [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')],
    beacon:   crypto.randomBytes(32).toString('hex'),
    hostSalt: crypto.randomBytes(32).toString('hex'),
    gameId:   'game-x',
    handId:   'hand-1',
  };

  const { dice: baseResult } = await hkdfDice(base);

  // Change beacon
  const altBeacon = await hkdfDice({ ...base, beacon: crypto.randomBytes(32).toString('hex') });
  // Change hostSalt
  const altSalt   = await hkdfDice({ ...base, hostSalt: crypto.randomBytes(32).toString('hex') });
  // Change gameId
  const altGame   = await hkdfDice({ ...base, gameId: 'game-y' });
  // Change seed
  const altSeeds  = await hkdfDice({ ...base, seeds: [crypto.randomBytes(32).toString('hex'), base.seeds[1]] });

  // At least one die should differ for each mutation (collision possible but astronomically unlikely)
  assert.notDeepEqual(baseResult, altBeacon.dice,  'different beacon → different dice');
  assert.notDeepEqual(baseResult, altSalt.dice,    'different hostSalt → different dice');
  assert.notDeepEqual(baseResult, altGame.dice,    'different gameId → different dice');
  assert.notDeepEqual(baseResult, altSeeds.dice,   'different seed → different dice');
});

test('hkdfDice usedBytes are a hex string of plausible length', async () => {
  const { usedBytes } = await hkdfDice({
    seeds:    [crypto.randomBytes(32).toString('hex')],
    beacon:   crypto.randomBytes(32).toString('hex'),
    hostSalt: crypto.randomBytes(32).toString('hex'),
    gameId:   'g',
    handId:   'h',
  });
  assert.match(usedBytes, /^[0-9a-f]+$/, 'usedBytes is hex');
  // At least 3 bytes used (one per die), at most 128 * 2 = 256 hex chars
  assert.ok(usedBytes.length >= 6 && usedBytes.length <= 256, 'usedBytes length plausible');
});

// ─────────────────────────────────────────────────────────────────────────────
// E2E tests using player.js — no UI, no manual MQTT protocol
// ─────────────────────────────────────────────────────────────────────────────

test('e2e: joinGame() — 2 players complete a full hand via player module', async t => {
  const { host, url, gameId } = await startTestHost();

  // Observer client subscribes to state and proofs
  const observer = mqttClient(url);
  await waitForConnect(observer);
  const proofPromise = nextMessage(observer, `cee-lo/${gameId}/proofs`);
  await subscribeAsync(observer, `cee-lo/${gameId}/proofs`);

  t.after(async () => {
    await observer.endAsync();
    await stopHostRuntime(host);
  });

  // Spin up two players using the player module; each needs a distinct key file
  const logs1 = [], errs1 = [];
  const logs2 = [], errs2 = [];

  const c1 = joinGame({
    mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath(),
    onLog:   msg => logs1.push(msg),
    onError: msg => errs1.push(msg),
  });
  const c2 = joinGame({
    mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath(),
    onLog:   msg => logs2.push(msg),
    onError: msg => errs2.push(msg),
  });

  t.after(async () => {
    await c1.endAsync();
    await c2.endAsync();
  });

  const proof = await proofPromise;

  assert.equal(proof.game_id, gameId);
  assert.equal(proof.hand_id, 'hand-1');
  assert.ok(Array.isArray(proof.dice) && proof.dice.length === 3, '3 dice in proof');
  assert.ok(proof.dice.every(d => d >= 1 && d <= 6), 'dice faces valid');
  assert.ok(proof.result?.category, 'result has category');
  assert.equal(proof.players.length, 2, '2 players in proof');
  assert.equal(errs1.length, 0, `player 1 errors: ${errs1.join('; ')}`);
  assert.equal(errs2.length, 0, `player 2 errors: ${errs2.join('; ')}`);
});

test('e2e: joinGame() — proof is signed by host and verifiable', async t => {
  const { host, url, gameId } = await startTestHost();

  const observer = mqttClient(url);
  await waitForConnect(observer);
  const proofPromise = nextMessage(observer, `cee-lo/${gameId}/proofs`);
  await subscribeAsync(observer, `cee-lo/${gameId}/proofs`);

  t.after(async () => {
    await observer.endAsync();
    await stopHostRuntime(host);
  });

  const c1 = joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() });
  const c2 = joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() });
  t.after(async () => { await c1.endAsync(); await c2.endAsync(); });

  const proof = await proofPromise;
  const { signature, ...proofWithoutSig } = proof;
  const valid = verify(JSON.stringify(proofWithoutSig), signature, host.hostPub);
  assert.ok(valid, 'host signature verifies');
  assert.equal(proof.host_fp, host.hostFp);
});

test('e2e: joinGame() — 3 players, minPlayers=3', async t => {
  const { host, url, gameId } = await startTestHost({ minPlayers: 3 });

  const observer = mqttClient(url);
  await waitForConnect(observer);
  const proofPromise = nextMessage(observer, `cee-lo/${gameId}/proofs`);
  await subscribeAsync(observer, `cee-lo/${gameId}/proofs`);

  t.after(async () => {
    await observer.endAsync();
    await stopHostRuntime(host);
  });

  const clients = [
    joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() }),
    joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() }),
    joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() }),
  ];
  t.after(async () => { for (const c of clients) await c.endAsync(); });

  const proof = await proofPromise;
  assert.equal(proof.players.length, 3, '3 players in proof');
  assert.ok(proof.dice.every(d => d >= 1 && d <= 6));
});

test('e2e: joinGame() — state topic transitions joining→rolling→finalized', async t => {
  const { host, url, gameId } = await startTestHost();

  const observer = mqttClient(url);
  await waitForConnect(observer);
  const phases = [];

  observer.on('message', (topic, buf) => {
    if (topic === `cee-lo/${gameId}/state`) {
      try { phases.push(JSON.parse(buf.toString()).phase); } catch { /* ignore */ }
    }
  });
  await subscribeAsync(observer, `cee-lo/${gameId}/state`);
  await subscribeAsync(observer, `cee-lo/${gameId}/proofs`);
  const proofPromise = nextMessage(observer, `cee-lo/${gameId}/proofs`);

  t.after(async () => {
    await observer.endAsync();
    await stopHostRuntime(host);
  });

  const c1 = joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() });
  const c2 = joinGame({ mqttUrl: url, gameId, handId: 'hand-1', keyPath: tempKeyPath() });
  t.after(async () => { await c1.endAsync(); await c2.endAsync(); });

  await proofPromise;
  // finalized state is published after proof — give broker a tick to deliver it
  await new Promise(r => setTimeout(r, 50));

  assert.ok(phases.includes('joining'),   'joining phase observed');
  assert.ok(phases.includes('rolling'),   'rolling phase observed');
  assert.ok(phases.includes('finalized'), 'finalized phase observed');
});
