import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { startHostRuntime, stopHostRuntime } from './host.js';
import { sign, fingerprint } from './keys.js';

function generateKeypair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pubPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function publishJoin({ client, gameId, handId, privPem, pubPem, seed }) {
  const commit = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
  const signature = sign(`${gameId}:${handId}:${commit}`, privPem);
  const payload = JSON.stringify({
    type: 'join',
    game_id: gameId,
    hand_id: handId,
    player_fp: fingerprint(pubPem),
    pubkey: pubPem,
    commit,
    signature,
  });
  return new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/joins`, payload, { qos: 1 }, err =>
      err ? reject(err) : resolve({ commit, seed }),
    ),
  );
}

function publishReveal({ client, gameId, handId, privPem, pubPem, seed }) {
  const signature = sign(`${gameId}:${handId}:${seed}`, privPem);
  const payload = JSON.stringify({
    type: 'reveal',
    game_id: gameId,
    hand_id: handId,
    player_fp: fingerprint(pubPem),
    pubkey: pubPem,
    seed,
    signature,
  });
  return new Promise((resolve, reject) =>
    client.publish(`cee-lo/${gameId}/reveals`, payload, { qos: 1 }, err =>
      err ? reject(err) : resolve(),
    ),
  );
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

test('end-to-end MQTT flow produces proof with evaluated dice', async t => {
  // Unique gameId per run to avoid DB UNIQUE constraint collisions
  const gameId = `test-game-${crypto.randomBytes(4).toString('hex')}`;
  const handId = 'hand-1';

  const host = startHostRuntime({
    gameId,
    port: 0,
    host: '127.0.0.1',
    minPlayers: 2,
    beaconSource: 'test-beacon',
    dbPath: `./.fair-dice/test-flow-${gameId}.db`,
  });

  await host.ready;

  const port = host.server.address().port;
  const client = mqtt.connect(`ws://127.0.0.1:${port}`, {
    protocolVersion: 4,
    connectTimeout: 2000,
  });

  // Guarantee cleanup regardless of how the test exits
  t.after(async () => {
    await client.endAsync();
    await stopHostRuntime(host);
  });

  await waitForConnect(client);

  // Register the lobby listener before subscribing — the retained message
  // is delivered as part of the SUBACK flow and can arrive before the next
  // await tick, so the listener must already be in place.
  const lobbyPromise = nextMessage(client, 'cee-lo/lobbies');

  await subscribeAsync(client, 'cee-lo/lobbies');
  await subscribeAsync(client, `cee-lo/${gameId}/acks`);
  await subscribeAsync(client, `cee-lo/${gameId}/proofs`);

  const lobby = await lobbyPromise;
  assert.equal(lobby.game_id, gameId);

  const p1 = generateKeypair();
  const p2 = generateKeypair();
  const seed1 = crypto.randomBytes(32).toString('hex');
  const seed2 = crypto.randomBytes(32).toString('hex');

  // Wait for broker ACKs before revealing to guarantee join state is committed
  const ack1 = nextMessage(client, `cee-lo/${gameId}/acks`);
  await publishJoin({ client, gameId, handId, privPem: p1.privPem, pubPem: p1.pubPem, seed: seed1 });
  await ack1;

  const ack2 = nextMessage(client, `cee-lo/${gameId}/acks`);
  await publishJoin({ client, gameId, handId, privPem: p2.privPem, pubPem: p2.pubPem, seed: seed2 });
  await ack2;

  // Register proof listener before sending reveals so we can't miss it
  const proofPromise = nextMessage(client, `cee-lo/${gameId}/proofs`);

  await publishReveal({ client, gameId, handId, privPem: p1.privPem, pubPem: p1.pubPem, seed: seed1 });
  await publishReveal({ client, gameId, handId, privPem: p2.privPem, pubPem: p2.pubPem, seed: seed2 });

  const proof = await proofPromise;

  assert.equal(proof.game_id, gameId);
  assert.equal(proof.hand_id, handId);
  assert.ok(Array.isArray(proof.dice) && proof.dice.length === 3, 'three dice');
  assert.ok(proof.result?.category, 'result category present');
  assert.ok(proof.signature, 'host signature present');
  assert.equal(proof.players.length, 2, 'two players recorded');
});
