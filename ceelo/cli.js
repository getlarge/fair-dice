'use strict';

import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import mqtt from 'mqtt';
import { startHostRuntime } from './host.js';
import { loadOrCreateKey, fingerprint, sign } from './keys.js';

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

function handleHost(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      game:        { type: 'string', short: 'g' },
      port:        { type: 'string', default: '8080' },
      mqtt:        { type: 'string' },
      allowlist:   { type: 'string' },
      'min-players': { type: 'string', default: '2' },
      db:          { type: 'string' },
      'host-key':  { type: 'string' },
      beacon:      { type: 'string', default: 'drand' },
    },
  });

  const gameId = values.game;
  if (!gameId) {
    console.error('--game <id> is required');
    process.exit(1);
  }

  startHostRuntime({
    gameId,
    port: Number(values.port),
    mqttUrl: values.mqtt,
    allowlist: loadAllowlist(values.allowlist),
    minPlayers: Number(values['min-players']),
    dbPath: values.db,
    hostKeyPath: values['host-key'],
    beaconSource: values.beacon,
  });
}

function handleJoin(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      game:  { type: 'string', short: 'g' },
      hand:  { type: 'string', default: 'hand-1' },
      mqtt:  { type: 'string', default: 'ws://localhost:8080' },
      key:   { type: 'string' },
    },
  });

  const gameId = values.game;
  if (!gameId) {
    console.error('--game <id> is required');
    process.exit(1);
  }

  const handId = values.hand;
  const { privPem, pubPem } = loadOrCreateKey(values.key);
  const playerFp = fingerprint(pubPem);

  const client = mqtt.connect(values.mqtt, { protocolVersion: 4 });
  let joinSent = false;
  let revealSent = false;
  let pendingSeed = null;

  client.on('connect', () => {
    client.subscribe('cee-lo/lobbies', { qos: 1 });
    client.subscribe(`cee-lo/${gameId}/acks`, { qos: 1 });
    console.log('Subscribed to lobbies; waiting for announcement...');
  });

  client.on('message', (topic, message) => {
    if (topic === 'cee-lo/lobbies') {
      try {
        const lobby = JSON.parse(message.toString('utf8'));
        if (lobby.game_id !== gameId || joinSent) return;
        console.log(`Found lobby for game ${gameId}, host ${lobby.host_fp}`);
        pendingSeed = crypto.randomBytes(32).toString('hex');
        const commit = crypto.createHash('sha256').update(Buffer.from(pendingSeed, 'hex')).digest('hex');
        const signature = sign(`${gameId}:${handId}:${commit}`, privPem);
        client.publish(
          `cee-lo/${gameId}/joins`,
          JSON.stringify({ type: 'join', game_id: gameId, hand_id: handId, player_fp: playerFp, pubkey: pubPem, commit, signature }),
          { qos: 1 },
        );
        joinSent = true;
        console.log(`Sent join for ${playerFp}, awaiting ACK to reveal...`);
      } catch (err) {
        console.error('Join error:', err.message);
      }
    } else if (topic === `cee-lo/${gameId}/acks`) {
      if (!joinSent || revealSent) return;
      try {
        const ack = JSON.parse(message.toString('utf8'));
        if (ack.player_fp !== playerFp || ack.hand_id !== handId || ack.status !== 'accepted') return;
        if (!pendingSeed) {
          console.warn('ACK received but no pending seed; skipping reveal');
          return;
        }
        const signature = sign(`${gameId}:${handId}:${pendingSeed}`, privPem);
        client.publish(
          `cee-lo/${gameId}/reveals`,
          JSON.stringify({ type: 'reveal', game_id: gameId, hand_id: handId, player_fp: playerFp, pubkey: pubPem, seed: pendingSeed, signature }),
          { qos: 1 },
        );
        revealSent = true;
        console.log(`Sent reveal for ${playerFp} after ACK`);
      } catch (err) {
        console.error('Ack handling error:', err.message);
      }
    }
  });
}

function handleVerify(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      proof: { type: 'string' },
    },
  });

  if (!values.proof) {
    console.error('--proof <file> is required');
    process.exit(1);
  }
  const proof = JSON.parse(fs.readFileSync(values.proof, 'utf8'));
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
