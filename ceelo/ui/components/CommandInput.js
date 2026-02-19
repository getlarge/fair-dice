'use strict';

import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { theme } from '../theme.js';

const MAX_HISTORY = 50;

export function CommandInput({ onSubmit, disabled }) {
  const [value, setValue]     = useState('');
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [saved, setSaved]     = useState('');
  const { isRawModeSupported } = useStdin();

  useInput((input, key) => {
    if (disabled) return;

    if (key.upArrow) {
      if (history.length === 0) return;
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      if (histIdx === -1) setSaved(value);
      setHistIdx(next);
      setValue(history[next]);
      return;
    }

    if (key.downArrow) {
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setValue(saved);
      } else {
        setHistIdx(next);
        setValue(history[next]);
      }
      return;
    }

    if (key.return) {
      const line = value.trim();
      if (line) {
        setHistory(h => [...h.filter(e => e !== line), line].slice(-MAX_HISTORY));
        setValue('');
        setHistIdx(-1);
        setSaved('');
        onSubmit(line);
      }
      return;
    }

    // Ctrl-U: clear line (Unix readline convention)
    if (key.ctrl && input === 'u') {
      setValue('');
      return;
    }

    // Ctrl-W: delete last word
    if (key.ctrl && input === 'w') {
      setValue(v => v.replace(/\S+\s*$/, ''));
      return;
    }

    if (key.backspace || key.delete) {
      setValue(v => v.slice(0, -1));
      return;
    }

    // Tab: complete common game commands
    if (key.tab) {
      const COMMANDS = ['join ', 'lobbies', 'help', 'exit'];
      const match = COMMANDS.find(c => c.startsWith(value) && c !== value);
      if (match) setValue(match);
      return;
    }

    // Let Ink's exitOnCtrlC handle Ctrl-C — don't intercept it here
    if (key.ctrl) return;

    if (!key.meta && input) {
      setValue(v => v + input);
    }
  }, { isActive: !!isRawModeSupported });

  return React.createElement(
    Box,
    {
      borderStyle: 'single',
      borderColor: disabled ? theme.cement : theme.gold,
      paddingX: 1,
      flexDirection: 'row',
      gap: 1,
    },
    React.createElement(Text, { color: disabled ? theme.cement : theme.gold, bold: true }, 'cee-lo›'),
    React.createElement(Text, { color: theme.chalk }, value),
    // Static block cursor — visible only when active and raw mode supported
    !disabled && isRawModeSupported
      ? React.createElement(Text, { color: theme.gold }, '█')
      : null,
  );
}
