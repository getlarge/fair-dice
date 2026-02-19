'use strict';

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { useDiceAnimation } from '../hooks/useDiceAnimation.js';

// Result banner text + color
function resultBanner(result) {
  if (!result) return null;
  const { category, description } = result;
  return {
    color: theme.resultColor(category),
    text: description?.toUpperCase() ?? category?.toUpperCase() ?? '',
  };
}

// Phase label shown above dice
const PHASE_LABELS = {
  idle:    { text: 'WAITING FOR PLAYERS…', color: theme.smoke },
  rolling: { text: '▶  ROLLING…',          color: theme.gold  },
  landing: { text: '▼  LANDING…',          color: theme.chalk },
  frozen:  { text: '■  RESULT',            color: theme.neon  },
};

// Render a single die's 7 frame-lines as a column of Text nodes
function Die({ lines, color }) {
  return React.createElement(
    Box,
    { flexDirection: 'column', marginX: 1 },
    ...lines.map((line, i) =>
      React.createElement(Text, { key: i, color, bold: true }, line)
    ),
  );
}

export function DicePanel({ animPhase, finalDice, result }) {
  const frames = useDiceAnimation(animPhase, finalDice);

  const phaseLabel = PHASE_LABELS[animPhase] || PHASE_LABELS.idle;

  // Choose die color based on phase
  const dieColor = animPhase === 'frozen'
    ? theme.resultColor(result?.category)
    : animPhase === 'rolling' || animPhase === 'landing'
      ? theme.gold
      : theme.cement;

  const banner = animPhase === 'frozen' ? resultBanner(result) : null;

  return React.createElement(
    Box,
    {
      flexDirection: 'column',
      borderStyle: 'round',
      borderColor: theme.gold,
      paddingX: 1,
      paddingY: 0,
      width: 38,
      alignItems: 'center',
    },

    // Panel title
    React.createElement(
      Box, { marginBottom: 0 },
      React.createElement(Text, { color: theme.gold, bold: true }, '🎲  DICE TABLE'),
    ),

    // Phase label
    React.createElement(
      Box, { marginBottom: 1 },
      React.createElement(Text, { color: phaseLabel.color, dimColor: animPhase === 'idle' }, phaseLabel.text),
    ),

    // Three dice side by side
    React.createElement(
      Box,
      { flexDirection: 'row', justifyContent: 'center' },
      Die({ lines: frames[0], color: dieColor }),
      Die({ lines: frames[1], color: dieColor }),
      Die({ lines: frames[2], color: dieColor }),
    ),

    // Result banner
    banner
      ? React.createElement(
          Box,
          { marginTop: 1, borderStyle: 'single', borderColor: banner.color, paddingX: 2 },
          React.createElement(Text, { color: banner.color, bold: true }, banner.text),
        )
      : React.createElement(Box, { height: 3 }),   // placeholder keeps layout stable
  );
}
