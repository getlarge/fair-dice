'use strict';

import crypto, { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import { startBroker } from './broker.js';
import { openDb, defaultDbPath } from './db.js';
import {
  loadOrCreateKey,
  fingerprint,
  verify,
  sign,
  defaultKeyPath,
} from './keys.js';
import { evaluateCeeLo } from './rules.js';

const hkdfAsync = promisify(hkdf);

// Derive 3 dice faces deterministically from player seeds, a beacon, and host salt.
// Uses HKDF-SHA256 with rejection sampling (discard bytes >= 252 to avoid modulo bias).
// okm is 128 bytes — exhaustion probability is < 10^-90.
async function hkdfDice({ seeds, beacon, hostSalt, gameId, handId }) {
  const info = `cee-lo|${gameId}|${handId}`;
  const material = Buffer.concat([
    Buffer.from(seeds.join(''), 'hex'),
    Buffer.from(beacon, 'hex'),
    Buffer.from(hostSalt, 'hex'),
  ]);
  const okm = new Uint8Array(
    await hkdfAsync('sha256', material, Buffer.alloc(0), Buffer.from(info), 128),
  );
  const dice = [];
  const used = [];
  for (let i = 0; dice.length < 3 && i < okm.length; i++) {
    const byte = okm[i];
    if (byte >= 252) continue;
    dice.push((byte % 6) + 1);
    used.push(byte);
  }
  if (dice.length < 3) throw new Error('hkdfDice: insufficient unbiased bytes (should never happen)');
  return { dice, usedBytes: Buffer.from(used).toString('hex') };
}

function createGameHandler({
  gameId,
  minPlayers,
  allowSet,
  db,
  lobby,
  broker,
  hostFp,
  hostPriv,
}) {
  const handState = new Map();

  function getOrCreateHand(handId) {
    if (!handState.has(handId)) {
      handState.set(handId, {
        joins: new Map(),
        reveals: new Map(),
        hostSalt: crypto.randomBytes(32).toString('hex'),
        proofed: false,
      });
    }
    return handState.get(handId);
  }

  // Publish authoritative retained game state so any client — including late
  // joiners — always gets the current picture without counting ACKs themselves.
  function publishState(handId, state, phase) {
    broker.publish({
      topic: `cee-lo/${gameId}/state`,
      payload: JSON.stringify({
        type: 'state',
        game_id: gameId,
        hand_id: handId,
        phase,                          // joining | rolling | finalized
        player_count: state.joins.size,
        min_players: minPlayers,
      }),
      qos: 1,
      retain: true,
    });
  }

  function handleJoin(state, handId, payload) {
    if (allowSet && !allowSet.has(payload.player_fp)) {
      console.warn(`Reject join from ${payload.player_fp}: not in allowlist`);
      return;
    }
    if (
      !verify(
        `${payload.game_id}:${payload.hand_id}:${payload.commit}`,
        payload.signature,
        payload.pubkey,
      )
    ) {
      console.warn(`Invalid join signature from ${payload.player_fp}`);
      return;
    }
    state.joins.set(payload.player_fp, {
      commit: payload.commit,
      pubkey: payload.pubkey,
    });
    const joinCount = state.joins.size;
    console.log(
      `[${gameId}/${handId}] player joined: ${payload.player_fp.slice(0, 9)}…  (${joinCount}/${minPlayers} needed)`,
    );
    db.prepare(
      'INSERT OR IGNORE INTO join_envelopes(game_id, hand_id, player_fp, envelope_json, ts) VALUES(?,?,?,?,?)',
    ).run(
      payload.game_id,
      payload.hand_id,
      payload.player_fp,
      JSON.stringify(payload),
      new Date().toISOString(),
    );

    broker.publish({
      topic: `cee-lo/${gameId}/acks/${payload.player_fp}`,
      payload: JSON.stringify({
        type: 'ack',
        game_id: gameId,
        hand_id: handId,
        player_fp: payload.player_fp,
        status: 'accepted',
      }),
      qos: 1,
      retain: true,
    });
    publishState(handId, state, 'joining');
    if (state.joins.size >= minPlayers) {
      console.log(`[${gameId}/${handId}] quorum reached — waiting for reveals`);
      publishState(handId, state, 'rolling');
    }
  }

  async function finalizeHand(state, handId) {
    const beacon = crypto.randomBytes(32).toString('hex'); // TODO: replace with drand fetch
    const seeds = Array.from(state.reveals.values()).map((r) => r.seed);
    const { dice, usedBytes } = await hkdfDice({
      seeds,
      beacon,
      hostSalt: state.hostSalt,
      gameId,
      handId,
    });
    const result = evaluateCeeLo(dice);
    const players = Array.from(state.reveals.entries()).map(([fp, r]) => ({
      player_fp: fp,
      seed: r.seed,
      commit: r.commit,
    }));
    const proof = {
      game_id: gameId,
      hand_id: handId,
      beacon: { source: lobby.beacon_source, value: beacon },
      host_salt: state.hostSalt,
      players,
      hkdf_info: `cee-lo|${gameId}|${handId}`,
      dice_bytes: usedBytes,
      dice,
      hash_algo: 'sha256',
      hkdf_algo: 'hkdf-sha256',
      rejection_threshold: 252,
      timestamp: new Date().toISOString(),
      host_fp: hostFp,
      result,
    };
    // TODO: canonicalize proof before signing to avoid irrelevant fields affecting the signature
    const signature = sign(JSON.stringify(proof), hostPriv);
    const proofEnvelope = { ...proof, signature };
    db.prepare(
      'INSERT OR IGNORE INTO hands(game_id, hand_id, beacon_round, proof_json, proof_sig, host_fp, ts) VALUES(?,?,?,?,?,?,?)',
    ).run(
      gameId,
      handId,
      beacon,
      JSON.stringify(proofEnvelope),
      signature,
      hostFp,
      new Date().toISOString(),
    );
    broker.publish({
      topic: `cee-lo/${gameId}/proofs`,
      payload: JSON.stringify(proofEnvelope),
      qos: 1,
      retain: true,
    });
    state.proofed = true;
    publishState(handId, state, 'finalized');
    console.log(
      `Hand ${handId} finalized: ${result.description} (dice: ${dice.join(',')})`,
    );
  }

  function handleReveal(state, handId, payload) {
    if (
      !verify(
        `${payload.game_id}:${payload.hand_id}:${payload.seed}`,
        payload.signature,
        payload.pubkey,
      )
    ) {
      console.warn(`Invalid reveal signature from ${payload.player_fp}`);
      return;
    }
    const row = db
      .prepare(
        'SELECT envelope_json FROM join_envelopes WHERE game_id=? AND hand_id=? AND player_fp=?',
      )
      .get(payload.game_id, payload.hand_id, payload.player_fp);
    if (!row) {
      console.warn(`Reveal with no matching join from ${payload.player_fp}`);
      return;
    }
    const joinEnv = JSON.parse(row.envelope_json);
    const seedCommit = crypto
      .createHash('sha256')
      .update(Buffer.from(payload.seed, 'hex'))
      .digest('hex');
    // TODO: use timing-safe compare to prevent against any potential timing attacks, even though the attack surface is minimal since the commit is public
    if (seedCommit !== joinEnv.commit) {
      console.warn(
        `Reveal seed does not match commit for ${payload.player_fp}`,
      );
      return;
    }
    state.reveals.set(payload.player_fp, {
      seed: payload.seed,
      pubkey: payload.pubkey,
      commit: joinEnv.commit,
    });
    console.log(
      `[${gameId}/${handId}] reveal accepted: ${payload.player_fp.slice(0, 9)}…  (${state.reveals.size}/${minPlayers})`,
    );
    db.prepare(
      'INSERT OR IGNORE INTO reveal_envelopes(game_id, hand_id, player_fp, envelope_json, ts) VALUES(?,?,?,?,?)',
    ).run(
      payload.game_id,
      payload.hand_id,
      payload.player_fp,
      JSON.stringify(payload),
      new Date().toISOString(),
    );
    if (!state.proofed && state.reveals.size >= minPlayers) {
      console.log(`[${gameId}/${handId}] all reveals in — finalizing hand`);
      finalizeHand(state, handId).catch(err =>
        console.error(`[${gameId}/${handId}] finalize error:`, err.message),
      );
    }
  }

  return function onPacket(packet) {
    const topic = packet.topic || '';
    if (!topic.startsWith(`cee-lo/${gameId}/`)) return;
    const kind = topic.split('/')[2];
    try {
      const payload = JSON.parse(packet.payload.toString('utf8'));
      const handId = payload.hand_id || 'hand-1';
      const state = getOrCreateHand(handId);
      if (kind === 'joins') handleJoin(state, handId, payload);
      else if (kind === 'reveals') handleReveal(state, handId, payload);
    } catch (err) {
      console.error('Failed to process publish:', err.message);
    }
  };
}

function startHostRuntime({
  gameId,
  port = 8080,
  host = '0.0.0.0',
  mqttUrl,
  allowlist,
  minPlayers = 2,
  dbPath = defaultDbPath(),
  hostKeyPath = defaultKeyPath('host'),
  beaconSource = 'drand',
}) {
  if (!gameId) {
    throw new Error('gameId is required');
  }
  const allowSet = allowlist ? new Set(allowlist) : null;
  const db = openDb(dbPath);
  const { pubPem: hostPub, privPem: hostPriv } = loadOrCreateKey(hostKeyPath);
  const hostFp = fingerprint(hostPub);
  const resolvedMqttUrl = mqttUrl || `ws://${host}:${port}`;

  const lobby = {
    game_id: gameId,
    host_fp: hostFp,
    beacon_source: beaconSource,
    min_players: minPlayers,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    'INSERT OR REPLACE INTO lobby(game_id, lobby_json, host_fp, beacon_source, created_at) VALUES(?,?,?,?,?)',
  ).run(
    gameId,
    JSON.stringify(lobby),
    hostFp,
    lobby.beacon_source,
    lobby.created_at,
  );

  const { broker, server } = startBroker({ port, host });

  const onPacket = createGameHandler({
    gameId,
    minPlayers,
    allowSet,
    db,
    lobby,
    broker,
    hostFp,
    hostPriv,
  });
  broker.on('publish', (packet, client) => {
    if (!client) return; // ignore broker-originated messages
    onPacket(packet);
  });

  broker.on('client', (client) => {
    console.log(`[${gameId}] client connected:    ${client.id}`);
  });
  broker.on('clientDisconnect', (client) => {
    console.log(`[${gameId}] client disconnected: ${client.id}`);
  });

  broker.publish({
    topic: 'cee-lo/lobbies',
    payload: JSON.stringify(lobby),
    retain: true,
    qos: 1,
  });

  const ready = new Promise((resolve, reject) => {
    server.once('listening', () => {
      console.log(`Lobby announced for game ${gameId} on ${resolvedMqttUrl}`);
      console.log(`Host fingerprint: ${hostFp}`);
      resolve();
    });
    server.once('error', reject);
  });

  return { broker, server, hostFp, hostPub, lobby, ready };
}

function stopHostRuntime({ broker, server }) {
  return new Promise((resolve, reject) => {
    broker.close((brokerErr) => {
      server.close((serverErr) => {
        const err = brokerErr || serverErr;
        err ? reject(err) : resolve();
      });
    });
  });
}

export { startHostRuntime, stopHostRuntime, hkdfDice };
