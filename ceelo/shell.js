'use strict';

import readline from 'node:readline';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { loadOrCreateKey, fingerprint, sign } from './keys.js';

function createShell({ mqttUrl = 'ws://localhost:8080' } = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'cee-lo> ',
  });

  const client = mqtt.connect(mqttUrl, { protocolVersion: 4, reconnectPeriod: 1000 });
  const lobbies = new Map(); // game_id -> lobby json
  const joins = new Map(); // game_id -> { handId, seed, keyPath, pubPem, privPem, fp, revealSent }

  client.on('connect', () => {
    console.log(`Connected to ${mqttUrl}`);
    client.subscribe('cee-lo/lobbies', { qos: 1 });
    rl.prompt();
  });

  client.on('message', (topic, message) => {
    if (topic === 'cee-lo/lobbies') {
      const lobby = JSON.parse(message.toString('utf8'));
      lobbies.set(lobby.game_id, lobby);
      console.log(`\n[lobby] game=${lobby.game_id} host_fp=${lobby.host_fp} min_players=${lobby.min_players ?? '?'} beacon=${lobby.beacon_source}`);
      rl.prompt();
      return;
    }

    if (topic.startsWith('cee-lo/') && topic.endsWith('/proofs')) {
      const proof = JSON.parse(message.toString('utf8'));
      console.log(`\n[proof] game=${proof.game_id} hand=${proof.hand_id} dice=${proof.dice?.join(',')} result=${proof.result?.category ?? 'n/a'}`);
      rl.prompt();
      return;
    }

    if (topic.includes('/acks/')) {
      const ack = JSON.parse(message.toString('utf8'));
      const j = joins.get(ack.game_id);
      if (!j) return;
      if (ack.hand_id !== j.handId || ack.status !== 'accepted') return;
      if (j.revealSent) return;
      const revealSig = sign(`${ack.game_id}:${ack.hand_id}:${j.seed}`, j.privPem);
      const reveal = {
        type: 'reveal',
        game_id: ack.game_id,
        hand_id: ack.hand_id,
        player_fp: j.fp,
        pubkey: j.pubPem,
        seed: j.seed,
        signature: revealSig,
      };
      client.publish(`cee-lo/${ack.game_id}/reveals`, JSON.stringify(reveal), { qos: 1 });
      j.revealSent = true;
      console.log(`\n[reveal] sent for game ${ack.game_id}`);
      rl.prompt();
    }
  });

  client.on('error', err => {
    console.error(`MQTT error: ${err.message}`);
  });

  function cmdHelp() {
    console.log(`Commands:
  help                       Show this help
  lobbies                    List known lobbies
  join <game> [hand] [key]   Join a game (defaults: hand-1, ~/.fair-dice/keys/player_ed25519.pem)
  exit | quit                Leave shell`);
  }

  function cmdLobbies() {
    if (lobbies.size === 0) {
      console.log('No lobbies seen yet.');
      return;
    }
    for (const lobby of lobbies.values()) {
      console.log(`- game=${lobby.game_id} host_fp=${lobby.host_fp} min_players=${lobby.min_players ?? '?'} beacon=${lobby.beacon_source}`);
    }
  }

  function cmdJoin(args) {
    const gameId = args[0];
    const handId = args[1] || 'hand-1';
    const keyPath = args[2];
    if (!gameId) {
      console.log('Usage: join <game> [hand] [keyPath]');
      return;
    }
    const { privPem, pubPem } = loadOrCreateKey(keyPath);
    const fp = fingerprint(pubPem);
    const seed = crypto.randomBytes(32).toString('hex');
    const commit = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
    const signature = sign(`${gameId}:${handId}:${commit}`, privPem);
    const payload = {
      type: 'join',
      game_id: gameId,
      hand_id: handId,
      player_fp: fp,
      pubkey: pubPem,
      commit,
      signature,
    };
    joins.set(gameId, { handId, seed, pubPem, privPem, fp, revealSent: false });
    client.subscribe(`cee-lo/${gameId}/acks/${fp}`, { qos: 1 });
    client.subscribe(`cee-lo/${gameId}/proofs`, { qos: 1 });
    client.publish(`cee-lo/${gameId}/joins`, JSON.stringify(payload), { qos: 1 });
    console.log(`Join sent for game ${gameId}, waiting for ACK to reveal...`);
  }

  rl.on('line', line => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    switch (cmd) {
      case 'help':
      case '?':
        cmdHelp();
        break;
      case 'lobbies':
        cmdLobbies();
        break;
      case 'join':
        cmdJoin(rest);
        break;
      case 'exit':
      case 'quit':
        client.end(true);
        rl.close();
        return;
      case '':
        break;
      default:
        console.log(`Unknown command: ${cmd}`);
        cmdHelp();
    }
    rl.prompt();
  });

  rl.on('close', () => {
    client.end(true);
    process.exit(0);
  });

  cmdHelp();
  rl.prompt();
}

export { createShell };
