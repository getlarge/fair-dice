'use strict';

import crypto from 'node:crypto';
import { loadOrCreateKey, fingerprint, sign } from '../keys.js';

// ─────────────────────────────────────────────────────────────────────────────
// Command parser + executor.
// Returns { type, ...fields } action objects consumed by the app reducer,
// or { type: 'error', message } / { type: 'help' } for display-only events.
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `Commands:
  help                    show this message
  lobbies                 list known lobbies
  join <gameId> [keyPath] join a game (uses default key if omitted)
  exit / quit             exit`;

function parseCommand(line) {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const [cmd, ...args] = parts;

  switch (cmd.toLowerCase()) {
    case 'help':
    case '?':
      return { type: 'help', text: HELP };

    case 'lobbies':
      return { type: 'lobbies' };

    case 'join': {
      const gameId  = args[0];
      if (!gameId) return { type: 'error', message: 'join requires <gameId>' };
      const keyPath = args[1] || undefined;
      return { type: 'join', gameId, handId: 'hand-1', keyPath };
    }

    case 'exit':
    case 'quit':
      return { type: 'exit' };

    default:
      return { type: 'error', message: `unknown command: ${cmd}. Type help.` };
  }
}

// Build and publish a join envelope; return the pending reveal state
function buildJoin({ gameId, handId, keyPath, publish }) {
  const { privPem, pubPem } = loadOrCreateKey(keyPath);
  const fp     = fingerprint(pubPem);
  const seed   = crypto.randomBytes(32).toString('hex');
  const commit = crypto.createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex');
  const sig    = sign(`${gameId}:${handId}:${commit}`, privPem);

  publish(`cee-lo/${gameId}/joins`, {
    type: 'join',
    game_id: gameId,
    hand_id: handId,
    player_fp: fp,
    pubkey: pubPem,
    commit,
    signature: sig,
  });

  return { gameId, handId, seed, pubPem, privPem, fp, revealSent: false };
}

// Build and publish a reveal envelope on ACK
function buildReveal({ ack, joinState, publish }) {
  if (joinState.revealSent) return false;
  if (ack.player_fp !== joinState.fp) return false;
  if (ack.hand_id   !== joinState.handId) return false;
  if (ack.status    !== 'accepted') return false;

  const sig = sign(`${ack.game_id}:${ack.hand_id}:${joinState.seed}`, joinState.privPem);
  publish(`cee-lo/${ack.game_id}/reveals`, {
    type: 'reveal',
    game_id: ack.game_id,
    hand_id: ack.hand_id,
    player_fp: joinState.fp,
    pubkey: joinState.pubPem,
    seed: joinState.seed,
    signature: sig,
  });
  return true;
}

export { parseCommand, buildJoin, buildReveal, HELP };
