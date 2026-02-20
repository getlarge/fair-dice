'use strict';

import React, { useReducer, useCallback, useRef } from 'react';
import { Box, Text, useApp } from 'ink';
import { theme } from './theme.js';
import { Header }       from './components/Header.js';
import { DicePanel }    from './components/DicePanel.js';
import { LogPanel }     from './components/LogPanel.js';
import { StatusBar }    from './components/StatusBar.js';
import { CommandInput } from './components/CommandInput.js';
import { useMqtt }      from './hooks/useMqtt.js';
import { parseCommand, HELP } from './commands.js';
import { joinGame }     from '../player.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL = {
  gameId:       null,
  phase:        'idle',  // idle | joining | rolling | frozen
  animPhase:    'idle',  // idle | rolling | landing | frozen
  finalDice:    null,
  result:       null,
  playerCount:  0,       // authoritative from host state messages
  minPlayers:   2,
  lobbies:      {},      // gameId → lobby
  log:          [],
};

let _seq = 0;
function logEntry(type, text) {
  const now = new Date();
  const ts  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  return { id: ++_seq, ts, type, text };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reducer — pure, no side-effects
// ─────────────────────────────────────────────────────────────────────────────
function reducer(state, action) {
  switch (action.type) {

    case 'LOBBY_SEEN': {
      const lobby = action.lobby;
      return {
        ...state,
        lobbies: { ...state.lobbies, [lobby.game_id]: lobby },
        log: [...state.log, logEntry('lobby',
          `game=${lobby.game_id}  host=${lobby.host_fp?.slice(0,9)}…  min=${lobby.min_players}`)],
      };
    }

    case 'JOIN_SENT': {
      return {
        ...state,
        gameId: action.gameId,
        phase:  'joining',
        log: [...state.log, logEntry('join',
          `join sent → game=${action.gameId}`)],
      };
    }

    // Authoritative game state from the host — drives phase and player count.
    // Published retained so late-joining clients get it immediately on subscribe.
    case 'GAME_STATE': {
      const { gs } = action;
      if (gs.game_id !== state.gameId) return state;
      const phase     = gs.phase === 'rolling'   ? 'rolling'
                      : gs.phase === 'finalized' ? 'frozen'
                      : state.phase; // 'joining' keeps UI phase unchanged
      const animPhase = gs.phase === 'rolling' && state.animPhase === 'idle'
                      ? 'rolling'
                      : state.animPhase;
      return {
        ...state,
        phase,
        animPhase,
        playerCount: gs.player_count,
        minPlayers:  gs.min_players,
        log: [...state.log, logEntry('state',
          `game=${gs.game_id}  players=${gs.player_count}/${gs.min_players}  phase=${gs.phase}`)],
      };
    }

    case 'PROOF_RECEIVED': {
      const { proof } = action;
      const isOurGame = state.gameId === proof.game_id;
      return {
        ...state,
        finalDice: isOurGame ? proof.dice   : state.finalDice,
        result:    isOurGame ? proof.result  : state.result,
        phase:     isOurGame ? 'frozen'      : state.phase,
        animPhase: isOurGame ? 'landing'     : state.animPhase,
        log: [...state.log, logEntry('proof',
          `game=${proof.game_id}  dice=${proof.dice?.join('-')}  → ${proof.result?.description ?? '?'}`)],
      };
    }

    case 'ANIM_FROZEN':
      return { ...state, animPhase: 'frozen' };

    case 'LOG_ADD':
      return { ...state, log: [...state.log, logEntry(action.logType ?? 'info', action.text)] };

    case 'LOBBIES_LIST': {
      const lobbies = Object.values(state.lobbies);
      if (lobbies.length === 0) {
        return { ...state, log: [...state.log, logEntry('info', 'no lobbies seen yet')] };
      }
      return {
        ...state,
        log: [...state.log, ...lobbies.map(l =>
          logEntry('lobby', `game=${l.game_id}  host=${l.host_fp?.slice(0,9)}…  min=${l.min_players}`))],
      };
    }

    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// App
// ─────────────────────────────────────────────────────────────────────────────
export function App({ mqttUrl, minPlayers = 2 }) {
  const { exit } = useApp();
  const [state, dispatch] = useReducer(reducer, { ...INITIAL, minPlayers });

  // Track active player client per game (gameId → mqtt client).
  // On new join we end the old client for that game first.
  const playerClientsRef = useRef(new Map());

  // Flip animPhase from landing → frozen after the landing animation completes
  React.useEffect(() => {
    if (state.animPhase === 'landing') {
      const total = 80+80+100+120+150+200+260+340+440+100;
      const t = setTimeout(() => dispatch({ type: 'ANIM_FROZEN' }), total);
      return () => clearTimeout(t);
    }
  }, [state.animPhase]);

  // Clean up all player clients on unmount
  React.useEffect(() => {
    return () => {
      for (const client of playerClientsRef.current.values()) {
        try { client.end(true); } catch { /* ignore */ }
      }
    };
  }, []);

  // ── MQTT message handler ──────────────────────────────────────────────────
  const onMessage = useCallback((topic, payload) => {
    if (topic === 'cee-lo/lobbies') {
      dispatch({ type: 'LOBBY_SEEN', lobby: payload });
      return;
    }

    if (topic.endsWith('/state')) {
      dispatch({ type: 'GAME_STATE', gs: payload });
      return;
    }

    if (topic.endsWith('/proofs')) {
      dispatch({ type: 'PROOF_RECEIVED', proof: payload });
      return;
    }
  }, []);

  const { connected } = useMqtt({ mqttUrl, onMessage });

  // ── Command handler ───────────────────────────────────────────────────────
  const handleCommand = useCallback((line) => {
    const cmd = parseCommand(line);
    if (!cmd) return;

    if (cmd.type === 'help') {
      HELP.split('\n').forEach(l =>
        dispatch({ type: 'LOG_ADD', logType: 'info', text: l }));
      return;
    }
    if (cmd.type === 'lobbies') {
      dispatch({ type: 'LOBBIES_LIST' });
      return;
    }
    if (cmd.type === 'join') {
      if (!connected) {
        dispatch({ type: 'LOG_ADD', logType: 'error', text: 'not connected to broker' });
        return;
      }
      // End any existing client for this game before creating a new one
      const existing = playerClientsRef.current.get(cmd.gameId);
      if (existing) { try { existing.end(true); } catch { /* ignore */ } }
      dispatch({ type: 'JOIN_SENT', gameId: cmd.gameId });
      const client = joinGame({
        mqttUrl,
        gameId:  cmd.gameId,
        handId:  cmd.handId,
        keyPath: cmd.keyPath,
        onLog:   (msg) => dispatch({ type: 'LOG_ADD', logType: 'info', text: msg }),
        onError: (msg) => dispatch({ type: 'LOG_ADD', logType: 'error', text: msg }),
      });
      playerClientsRef.current.set(cmd.gameId, client);
      return;
    }
    if (cmd.type === 'exit') {
      exit();
      return;
    }
    if (cmd.type === 'error') {
      dispatch({ type: 'LOG_ADD', logType: 'error', text: cmd.message });
    }
  }, [connected, mqttUrl, exit]);

  return React.createElement(
    Box, { flexDirection: 'column', height: '100%' },

    React.createElement(Header, { connected, gameId: state.gameId }),

    React.createElement(
      Box, { flexDirection: 'row', flexGrow: 1, gap: 1 },
      React.createElement(DicePanel, {
        animPhase: state.animPhase,
        finalDice: state.finalDice,
        result:    state.result,
      }),
      React.createElement(LogPanel, { entries: state.log }),
    ),

    React.createElement(StatusBar, {
      gameId:      state.gameId,
      phase:       state.phase,
      playerCount: state.playerCount,
      minPlayers:  state.minPlayers,
    }),

    React.createElement(CommandInput, {
      onSubmit: handleCommand,
      disabled: !connected,
    }),

    React.createElement(
      Box, { paddingX: 2 },
      React.createElement(Text, { color: theme.cement, dimColor: true },
        connected
          ? 'help · lobbies · join <gameId> [keyPath] · exit'
          : `connecting to ${mqttUrl}…`,
      ),
    ),
  );
}
