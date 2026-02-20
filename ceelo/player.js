'use strict';

import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { loadOrCreateKey, fingerprint, sign } from './keys.js';

/**
 * Run the full player protocol for one hand: join → wait for ACK → reveal.
 * Returns the mqtt client so the caller can close it or keep watching.
 *
 * @param {object} opts
 * @param {string} opts.mqttUrl
 * @param {string} opts.gameId
 * @param {string} opts.handId
 * @param {string} [opts.keyPath]   - path to player key file (generated if absent)
 * @param {function} [opts.onLog]   - (msg: string) => void  (defaults to console.log)
 * @param {function} [opts.onError] - (msg: string) => void  (defaults to console.error)
 */
function joinGame({ mqttUrl, gameId, handId = 'hand-1', keyPath, onLog, onError }) {
  if (!keyPath) throw new Error('joinGame: keyPath is required');
  const log   = onLog   ?? console.log;
  const error = onError ?? console.error;

  const { privPem, pubPem } = loadOrCreateKey(keyPath);
  const playerFp = fingerprint(pubPem);

  let joinSent   = false;
  let revealSent = false;
  let pendingSeed = null;

  const client = mqtt.connect(mqttUrl, { protocolVersion: 4, reconnectPeriod: 0 });

  client.on('connect', () => {
    // Subscribe to the lobby (retained) and our own per-fp ACK topic (retained).
    // Using a per-fp subtopic means our retained ACK survives reconnects.
    client.subscribe('cee-lo/lobbies',                        { qos: 1 });
    client.subscribe(`cee-lo/${gameId}/acks/${playerFp}`,     { qos: 1 });
    log(`connected  fp=${playerFp.slice(0, 9)}…  game=${gameId}`);
  });

  client.on('error', (err) => error(`mqtt error: ${err.message}`));

  client.on('message', (topic, buf) => {
    let payload;
    try { payload = JSON.parse(buf.toString('utf8')); }
    catch { return; }

    if (topic === 'cee-lo/lobbies') {
      if (payload.game_id !== gameId || joinSent) return;
      pendingSeed  = crypto.randomBytes(32).toString('hex');
      const commit = crypto.createHash('sha256')
        .update(Buffer.from(pendingSeed, 'hex')).digest('hex');
      const sig = sign(`${gameId}:${handId}:${commit}`, privPem);
      client.publish(
        `cee-lo/${gameId}/joins`,
        JSON.stringify({ type: 'join', game_id: gameId, hand_id: handId,
          player_fp: playerFp, pubkey: pubPem, commit, signature: sig }),
        { qos: 1 },
      );
      joinSent = true;
      log(`join sent  fp=${playerFp.slice(0, 9)}…  commit=${commit.slice(0, 9)}…`);
      return;
    }

    if (topic === `cee-lo/${gameId}/acks/${playerFp}`) {
      if (!joinSent || revealSent) return;
      if (payload.player_fp !== playerFp) return;
      if (payload.hand_id   !== handId)   return;
      if (payload.status    !== 'accepted') return;
      if (!pendingSeed) { error('ACK received but no pending seed'); return; }
      const sig = sign(`${gameId}:${handId}:${pendingSeed}`, privPem);
      client.publish(
        `cee-lo/${gameId}/reveals`,
        JSON.stringify({ type: 'reveal', game_id: gameId, hand_id: handId,
          player_fp: playerFp, pubkey: pubPem, seed: pendingSeed, signature: sig }),
        { qos: 1 },
      );
      revealSent = true;
      log(`reveal sent  fp=${playerFp.slice(0, 9)}…`);
      return;
    }
  });

  return client;
}

export { joinGame };
