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
import { parseCommand, buildJoin, buildReveal, HELP } from './commands.js';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
const INITIAL = {
  gameId:      null,
  phase:       'idle',   // idle | joining | rolling | frozen
  animPhase:   'idle',   // idle | rolling | landing | frozen
  finalDice:   null,
  result:      null,
  // Track unique ACK'd fingerprints so we don't double-count retransmits
  ackedPlayers: [],      // [fp, ...]
  minPlayers:  2,
  lobbies:     {},       // gameId → lobby
  joins:       {},       // gameId → { handId, seed, privPem, pubPem, fp, revealSent }
  log:         [],
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
        joins:  { ...state.joins, [action.gameId]: action.joinState },
        log: [...state.log, logEntry('join',
          `join sent → game=${action.gameId}  hand=${action.joinState.handId}`)],
      };
    }

    case 'ACK_RECEIVED': {
      const { ack } = action;
      // Only track ACKs for our current game
      if (ack.game_id !== state.gameId) return state;
      // De-duplicate: same fp already counted
      if (state.ackedPlayers.includes(ack.player_fp)) {
        return {
          ...state,
          log: [...state.log, logEntry('ack',
            `re-ack ${ack.player_fp?.slice(0,9)}… (ignored)`)],
        };
      }
      const ackedPlayers = [...state.ackedPlayers, ack.player_fp];
      const count = ackedPlayers.length;
      const startRoll = count >= state.minPlayers;
      return {
        ...state,
        ackedPlayers,
        phase:     startRoll ? 'rolling' : state.phase,
        animPhase: startRoll ? 'rolling' : state.animPhase,
        log: [...state.log, logEntry('ack',
          `player ${ack.player_fp?.slice(0,9)}… accepted  [${count}/${state.minPlayers}]`)],
      };
    }

    case 'PROOF_RECEIVED': {
      const { proof } = action;
      const isOurGame = state.gameId === proof.game_id;
      return {
        ...state,
        finalDice: isOurGame ? proof.dice  : state.finalDice,
        result:    isOurGame ? proof.result : state.result,
        phase:     isOurGame ? 'frozen'    : state.phase,
        animPhase: isOurGame ? 'landing'   : state.animPhase,
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

  // Keep a ref to latest state so the MQTT callback never captures stale closures
  const stateRef = useRef(state);
  stateRef.current = state;

  // joinsRef is updated synchronously in handleCommand right after buildJoin returns,
  // before React re-renders. onMessage reads from here so ACKs that arrive in the same
  // tick as the dispatch never miss the join state.
  const joinsRef  = useRef({});   // gameId → joinState (same shape as state.joins)

  const publishRef = useRef(null);

  // Flip animPhase from landing → frozen after the landing animation completes
  React.useEffect(() => {
    if (state.animPhase === 'landing') {
      const total = 80+80+100+120+150+200+260+340+440+100;
      const t = setTimeout(() => dispatch({ type: 'ANIM_FROZEN' }), total);
      return () => clearTimeout(t);
    }
  }, [state.animPhase]);

  // ── MQTT message handler ──────────────────────────────────────────────────
  // Uses stateRef so it always reads current state without being recreated.
  const onMessage = useCallback((topic, payload) => {
    if (topic === 'cee-lo/lobbies') {
      dispatch({ type: 'LOBBY_SEEN', lobby: payload });
      return;
    }

    if (topic.endsWith('/acks')) {
      dispatch({ type: 'ACK_RECEIVED', ack: payload });
      // Auto-reveal: read from joinsRef (updated synchronously before dispatch,
      // so this always has the current seed even if React hasn't re-rendered yet).
      const join = joinsRef.current[payload.game_id];
      if (join && !join.revealSent && publishRef.current) {
        const sent = buildReveal({ ack: payload, joinState: join, publish: publishRef.current });
        if (sent) {
          join.revealSent = true; // intentional mutation of the ref object
          dispatch({ type: 'LOG_ADD', logType: 'reveal',
            text: `reveal sent → game=${payload.game_id}` });
        }
      }
      return;
    }

    if (topic.endsWith('/proofs')) {
      dispatch({ type: 'PROOF_RECEIVED', proof: payload });
      return;
    }
  }, []); // stable — reads state via stateRef

  const { connected, publish } = useMqtt({ mqttUrl, onMessage });
  publishRef.current = publish;

  // ── Command handler ───────────────────────────────────────────────────────
  const handleCommand = useCallback((line) => {
    const cmd = parseCommand(line);
    if (!cmd) return;

    if (cmd.type === 'help') {
      // Print each help line as a separate log entry so it wraps properly
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
      try {
        const joinState = buildJoin({
          gameId:  cmd.gameId,
          handId:  cmd.handId,
          keyPath: cmd.keyPath,
          publish,
        });
        // Update joinsRef synchronously BEFORE dispatch so onMessage can find
        // the seed even if an ACK arrives before React re-renders.
        joinsRef.current[cmd.gameId] = joinState;
        dispatch({ type: 'JOIN_SENT', gameId: cmd.gameId, joinState });
      } catch (err) {
        dispatch({ type: 'LOG_ADD', logType: 'error', text: err.message });
      }
      return;
    }
    if (cmd.type === 'exit') {
      exit();
      return;
    }
    if (cmd.type === 'error') {
      dispatch({ type: 'LOG_ADD', logType: 'error', text: cmd.message });
    }
  }, [connected, publish, exit]);

  const playerCount = state.ackedPlayers.length;

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
      playerCount,
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
