'use strict';

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

const MAX_LINES = 24;

// Each log entry: { id, ts, type, text }
export function LogPanel({ entries }) {
  const visible = entries.slice(-MAX_LINES);

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.cement,
      paddingX: 1,
      flexGrow: 1,
    },

    // Header
    React.createElement(
      Box, { marginBottom: 1 },
      React.createElement(Text, { color: theme.gold, bold: true }, '📋  GAME LOG'),
    ),

    // Log lines
    ...visible.map(entry =>
      React.createElement(
        Box,
        { key: entry.id, flexDirection: 'row', gap: 1 },
        React.createElement(Text, { color: theme.cement }, entry.ts),
        React.createElement(
          Text,
          { color: theme.logColor(entry.type), bold: entry.type === 'proof' },
          `[${entry.type}]`,
        ),
        React.createElement(Text, { color: theme.primary, wrap: 'truncate' }, entry.text),
      )
    ),

    // Fill remaining space
    visible.length === 0
      ? React.createElement(
          Text,
          { color: theme.cement, dimColor: true },
          'waiting for events…',
        )
      : null,
  );
}
