'use strict';

import { parseArgs } from 'node:util';

// ─────────────────────────────────────────────────────────────────────────────
// Command parser — pure, no side-effects, no crypto.
// Returns { type, ...fields } consumed by the app reducer.
// ─────────────────────────────────────────────────────────────────────────────

const HELP = `Commands:
  help                                  show this message
  lobbies                               list known lobbies
  join <gameId> --key <path> [--hand h] join a game
  exit / quit                           exit`;

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
      const gameId = args[0];
      if (!gameId) return { type: 'error', message: 'join requires <gameId>' };

      let parsed;
      try {
        ({ values: parsed } = parseArgs({
          args: args.slice(1),
          options: {
            key:  { type: 'string', short: 'k' },
            hand: { type: 'string', short: 'h', default: 'hand-1' },
          },
          strict: true,
        }));
      } catch (err) {
        return { type: 'error', message: err.message };
      }

      if (!parsed.key) return { type: 'error', message: 'join requires --key <path>' };
      return { type: 'join', gameId, handId: parsed.hand, keyPath: parsed.key };
    }

    case 'exit':
    case 'quit':
      return { type: 'exit' };

    default:
      return { type: 'error', message: `unknown command: ${cmd}. Type help.` };
  }
}

export { parseCommand, HELP };
