'use strict';

import fs from 'fs';
import mqtt from 'mqtt';
import crypto from 'crypto';
import { startBroker } from './broker.js';
import { openDb, defaultDbPath } from './db.js';
import { loadOrCreateKey, fingerprint, verify, sign, defaultKeyPath } from './keys.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      args[key] = val;
    } else if (!args._) {
      args._ = [argv[i]];
    } else {
      args._.push(argv[i]);
    }
  }
  return args;
}

function loadAllowlist(file) {
  if (!file) return null;
  if (!fs.existsSync(file)) throw new Error(`allowlist not found: ${file}`);
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean),
  );
}

function handleHost(rawArgs) {
  const args = parseArgs(rawArgs);
  const gameId = args.game || args.g;
  const port = Number(args.port || 8080);
  const mqttUrl = args.mqtt || `ws://0.0.0.0:${port}`;
  const allowlist = loadAllowlist(args.allowlist);
  const db = openDb(args.db || defaultDbPath());
  const { pubPem: hostPub } = loadOrCreateKey(args['host-key'] || defaultKeyPath('host'));
  const hostFp = fingerprint(hostPub);

  const lobby = {
    game_id: gameId,
    host_fp: hostFp,
    beacon_source: args.beacon || 'drand',
    created_at: new Date().toISOString(),
  };

  // Save lobby in DB
  db.prepare(
    'INSERT OR REPLACE INTO lobby(game_id, lobby_json, host_fp, beacon_source, created_at) VALUES(?,?,?,?,?)',
  ).run(gameId, JSON.stringify(lobby), hostFp, lobby.beacon_source, lobby.created_at);

  const { broker } = startBroker({
    port,
    onPublish: (packet, client) => {
      const topic = packet.topic || '';
      if (!topic.startsWith(`cee-lo/${gameId}/`)) return;
      const kind = topic.split('/')[2];
      try {
        const payload = JSON.parse(packet.payload.toString('utf8'));
        if (kind === 'joins') {
          if (allowlist && !allowlist.has(payload.player_fp)) {
            console.warn(`Reject join from ${payload.player_fp}: not in allowlist`);
            return;
          }
          const ok = verify(
            `${payload.game_id}:${payload.hand_id}:${payload.commit}`,
            payload.signature,
            payload.pubkey,
          );
          if (!ok) {
            console.warn(`Invalid join signature from ${payload.player_fp}`);
            return;
          }
          db.prepare(
            'INSERT OR IGNORE INTO join_envelopes(game_id, hand_id, player_fp, envelope_json, ts) VALUES(?,?,?,?,?)',
          ).run(
            payload.game_id,
            payload.hand_id,
            payload.player_fp,
            JSON.stringify(payload),
            new Date().toISOString(),
          );
        } else if (kind === 'reveals') {
          const ok = verify(
            `${payload.game_id}:${payload.hand_id}:${payload.seed}`,
            payload.signature,
            payload.pubkey,
          );
          if (!ok) {
            console.warn(`Invalid reveal signature from ${payload.player_fp}`);
            return;
          }
          // Check commit match
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
          if (seedCommit !== joinEnv.commit) {
            console.warn(`Reveal seed does not match commit for ${payload.player_fp}`);
            return;
          }
          db.prepare(
            'INSERT OR IGNORE INTO reveal_envelopes(game_id, hand_id, player_fp, envelope_json, ts) VALUES(?,?,?,?,?)',
          ).run(
            payload.game_id,
            payload.hand_id,
            payload.player_fp,
            JSON.stringify(payload),
            new Date().toISOString(),
          );
        }
      } catch (err) {
        console.error('Failed to process publish:', err.message);
      }
    },
  });

  // Publish lobby announcement (retained)
  const retainedPacket = {
    topic: 'cee-lo/lobbies',
    payload: JSON.stringify(lobby),
    retain: true,
    qos: 1,
  };
  broker.publish(retainedPacket);

  console.log(`Lobby announced for game ${gameId} on ${mqttUrl}`);
  console.log(`Host fingerprint: ${hostFp}`);
}

function handleJoin(rawArgs) {
  const args = parseArgs(rawArgs);
  const gameId = args.game || args.g;
  const handId = args.hand || 'hand-1';
  const mqttUrl = args.mqtt || 'ws://localhost:8080';
  const { privPem, pubPem } = loadOrCreateKey(args.key);
  const playerFp = fingerprint(pubPem);

  const client = mqtt.connect(mqttUrl, { protocolVersion: 5 });

  client.on('connect', () => {
    client.subscribe('cee-lo/lobbies', { qos: 1 }, () => {
      console.log('Subscribed to lobbies; waiting for announcement...');
    });
  });

  client.on('message', (topic, message) => {
    if (topic === 'cee-lo/lobbies') {
      try {
        const lobby = JSON.parse(message.toString('utf8'));
        if (lobby.game_id !== gameId) return;
        console.log(`Found lobby for game ${gameId}, host ${lobby.host_fp}`);
        const seed = crypto.randomBytes(32).toString('hex');
        const commit = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
        const toSign = `${gameId}:${handId}:${commit}`;
        const signature = sign(toSign, privPem);
        const payload = {
          type: 'join',
          game_id: gameId,
          hand_id: handId,
          player_fp: playerFp,
          pubkey: pubPem,
          commit,
          signature,
        };
        client.publish(`cee-lo/${gameId}/joins`, JSON.stringify(payload), { qos: 1 });
        console.log(`Sent join for ${playerFp}`);
        // Auto-reveal immediately using the same seed
        const revealSig = sign(`${gameId}:${handId}:${seed}`, privPem);
        const reveal = {
          type: 'reveal',
          game_id: gameId,
          hand_id: handId,
          player_fp: playerFp,
          pubkey: pubPem,
          seed,
          signature: revealSig,
        };
        client.publish(`cee-lo/${gameId}/reveals`, JSON.stringify(reveal), { qos: 1 });
        console.log(`Sent reveal for ${playerFp}`);
      } catch (err) {
        console.error('Join error:', err.message);
      }
    }
  });
}

function handleVerify(rawArgs) {
  const args = parseArgs(rawArgs);
  const proofPath = args.proof;
  if (!proofPath) {
    console.error('--proof <file> required');
    process.exit(1);
  }
  const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
  console.log('Proof loaded (signature verification not yet implemented in this stub).');
  console.log(JSON.stringify(proof, null, 2));
}

function runCeelo(args) {
  const sub = args[0];
  if (sub === 'host') return handleHost(args.slice(1));
  if (sub === 'join') return handleJoin(args.slice(1));
  if (sub === 'verify') return handleVerify(args.slice(1));
  console.error('Usage: fair-dice ceelo <host|join|verify> [options]');
  process.exit(1);
}

export { runCeelo };
