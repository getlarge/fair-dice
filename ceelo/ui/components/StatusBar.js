'use strict';

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export function StatusBar({ gameId, phase, playerCount, minPlayers }) {
  const phaseColor = {
    idle:    theme.smoke,
    joining: theme.gold,
    rolling: theme.gold,
    frozen:  theme.neon,
  }[phase] ?? theme.smoke;

  return React.createElement(
    Box,
    { flexDirection: 'row', gap: 3, paddingX: 1, borderStyle: 'single', borderColor: theme.cement },

    React.createElement(
      Box, { gap: 1 },
      React.createElement(Text, { color: theme.smoke }, 'GAME'),
      React.createElement(Text, { color: theme.gold, bold: true }, gameId ?? '—'),
    ),

    React.createElement(
      Box, { gap: 1 },
      React.createElement(Text, { color: theme.smoke }, 'PHASE'),
      React.createElement(Text, { color: phaseColor, bold: true }, (phase ?? 'idle').toUpperCase()),
    ),

    React.createElement(
      Box, { gap: 1 },
      React.createElement(Text, { color: theme.smoke }, 'PLAYERS'),
      React.createElement(
        Text,
        { color: playerCount >= minPlayers ? theme.neon : theme.chalk },
        `${playerCount ?? 0}/${minPlayers ?? '?'}`,
      ),
    ),
  );
}
