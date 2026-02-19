'use strict';

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

// ASCII logo — heavy block lettering, 5 lines tall
const LOGO_LINES = [
  ' ██████╗███████╗███████╗    ██╗      ██████╗ ',
  '██╔════╝██╔════╝██╔════╝    ██║     ██╔═══██╗',
  '██║     █████╗  █████╗      ██║     ██║   ██║',
  '██║     ██╔══╝  ██╔══╝      ██║     ██║   ██║',
  '╚██████╗███████╗███████╗    ███████╗╚██████╔╝',
  ' ╚═════╝╚══════╝╚══════╝    ╚══════╝ ╚═════╝ ',
];

const TAGLINE = '« FOUR · FIVE · SIX »   KOOL G RAP STYLE   PROVABLY FAIR';

export function Header({ connected, gameId }) {
  return React.createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'double', borderColor: theme.gold, paddingX: 1 },

    // Logo
    React.createElement(
      Box, { flexDirection: 'column' },
      ...LOGO_LINES.map((line, i) =>
        React.createElement(Text, { key: i, color: i < 2 ? theme.gold : theme.chalk, bold: true }, line)
      ),
    ),

    // Tagline + status row
    React.createElement(
      Box,
      { marginTop: 1, justifyContent: 'space-between' },
      React.createElement(Text, { color: theme.smoke, dimColor: true }, TAGLINE),
      React.createElement(
        Box,
        { gap: 1 },
        React.createElement(
          Text,
          { color: connected ? theme.connected : theme.disconnected, bold: true },
          connected ? '● LIVE' : '○ CONNECTING…'
        ),
        gameId
          ? React.createElement(Text, { color: theme.gold }, `  GAME: ${gameId}`)
          : null,
      ),
    ),
  );
}
