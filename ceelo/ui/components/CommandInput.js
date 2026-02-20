'use strict';

import React, { useState } from 'react';
import { Box, Text, useInput, useStdin } from 'ink';
import { theme } from '../theme.js';

const MAX_HISTORY = 50;

export function CommandInput({ onSubmit, disabled }) {
  const [value, setValue]     = useState('');
  const [cursor, setCursor]   = useState(0);
  const [history, setHistory] = useState([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [saved, setSaved]     = useState('');
  const { isRawModeSupported } = useStdin();

  // Clamp cursor whenever value changes externally (history nav, clear, etc.)
  function setValueAndCursor(v, pos) {
    setValue(v);
    setCursor(pos !== undefined ? Math.min(pos, v.length) : v.length);
  }

  useInput((input, key) => {
    if (disabled) return;

    if (key.upArrow) {
      if (history.length === 0) return;
      const next = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
      if (histIdx === -1) setSaved(value);
      setHistIdx(next);
      setValueAndCursor(history[next]);
      return;
    }

    if (key.downArrow) {
      if (histIdx === -1) return;
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setValueAndCursor(saved);
      } else {
        setHistIdx(next);
        setValueAndCursor(history[next]);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor(c => Math.max(0, c - 1));
      return;
    }

    if (key.rightArrow) {
      setCursor(c => Math.min(value.length, c + 1));
      return;
    }

    if (key.return) {
      const line = value.trim();
      if (line) {
        setHistory(h => [...h.filter(e => e !== line), line].slice(-MAX_HISTORY));
        setValueAndCursor('', 0);
        setHistIdx(-1);
        setSaved('');
        onSubmit(line);
      }
      return;
    }

    // Ctrl-A: jump to beginning
    if (key.ctrl && input === 'a') {
      setCursor(0);
      return;
    }

    // Ctrl-E: jump to end
    if (key.ctrl && input === 'e') {
      setCursor(value.length);
      return;
    }

    // Ctrl-U: clear line
    if (key.ctrl && input === 'u') {
      setValueAndCursor('', 0);
      return;
    }

    // Ctrl-W: delete word before cursor
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
      const after  = value.slice(cursor);
      setValueAndCursor(before + after, before.length);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      const next = value.slice(0, cursor - 1) + value.slice(cursor);
      setValueAndCursor(next, cursor - 1);
      return;
    }

    // Tab: complete common game commands (only at end of word)
    if (key.tab) {
      const COMMANDS = ['join ', 'lobbies', 'help', 'exit'];
      const prefix = value.slice(0, cursor);
      const match  = COMMANDS.find(c => c.startsWith(prefix) && c !== prefix);
      if (match) setValueAndCursor(match + value.slice(cursor), match.length);
      return;
    }

    // Let Ink's exitOnCtrlC handle Ctrl-C — don't intercept it here
    if (key.ctrl) return;

    if (!key.meta && input) {
      const next = value.slice(0, cursor) + input + value.slice(cursor);
      setValueAndCursor(next, cursor + input.length);
    }
  }, { isActive: !!isRawModeSupported });

  const before = value.slice(0, cursor);
  const atCursor = value[cursor] ?? ' '; // character under cursor (space if at end)
  const after  = value.slice(cursor + 1);

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
    // Text before cursor
    React.createElement(Text, { color: theme.chalk }, before),
    // Cursor block (only when active and raw mode supported)
    !disabled && isRawModeSupported
      ? React.createElement(Text, { color: theme.gold, inverse: true }, atCursor)
      : React.createElement(Text, { color: theme.chalk }, atCursor === ' ' ? '' : atCursor),
    // Text after cursor
    React.createElement(Text, { color: theme.chalk }, after),
  );
}
