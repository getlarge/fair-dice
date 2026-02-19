#!/usr/bin/env node
'use strict';

import { runCeelo } from './ceelo/cli.js';

const FACES = [
  // 1
  [
    '┌─────────┐',
    '│         │',
    '│    ●    │',
    '│         │',
    '└─────────┘',
  ],
  // 2
  [
    '┌─────────┐',
    '│  ●      │',
    '│         │',
    '│      ●  │',
    '└─────────┘',
  ],
  // 3
  [
    '┌─────────┐',
    '│  ●      │',
    '│    ●    │',
    '│      ●  │',
    '└─────────┘',
  ],
  // 4
  [
    '┌─────────┐',
    '│  ●   ●  │',
    '│         │',
    '│  ●   ●  │',
    '└─────────┘',
  ],
  // 5
  [
    '┌─────────┐',
    '│  ●   ●  │',
    '│    ●    │',
    '│  ●   ●  │',
    '└─────────┘',
  ],
  // 6
  [
    '┌─────────┐',
    '│  ●   ●  │',
    '│  ●   ●  │',
    '│  ●   ●  │',
    '└─────────┘',
  ],
];

function roll() {
  return Math.floor(Math.random() * 6) + 1;
}

function renderRow(values) {
  const faces = values.map(v => FACES[v - 1]);
  const lines = [];
  for (let row = 0; row < 5; row++) {
    lines.push(faces.map(f => f[row]).join('  '));
  }
  return lines.join('\n');
}

function clearLines(n) {
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function animate(count) {
  const LINES = 5;
  let first = true;

  // Build frame schedule: fast at start, slow at end
  const frames = [];
  // 20 fast frames (50ms each)
  for (let i = 0; i < 20; i++) frames.push(50);
  // slow down over 10 frames
  for (let i = 1; i <= 10; i++) frames.push(50 + i * 30);

  let current = Array.from({ length: count }, roll);
  process.stdout.write(renderRow(current) + '\n');

  for (const delay of frames) {
    await sleep(delay);
    current = Array.from({ length: count }, roll);
    clearLines(LINES);
    process.stdout.write(renderRow(current) + '\n');
  }

  // Final result — fixed roll
  const result = Array.from({ length: count }, roll);
  await sleep(400);
  clearLines(LINES);
  process.stdout.write(renderRow(result) + '\n');
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === 'ceelo') {
    return runCeelo(args.slice(1));
  }

  if (cmd !== 'roll') {
    console.error('Usage: fair-dice roll [count]');
    process.exit(1);
  }

  const count = Math.max(1, Math.min(8, parseInt(args[1] ?? '1', 10) || 1));
  const results = await animate(count);
  const total = results.reduce((a, b) => a + b, 0);

  if (count > 1) {
    console.log(`\nRolled: [${results.join(', ')}]  Total: ${total}`);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
