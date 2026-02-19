'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DICE FACES — 7 lines tall, 9 chars wide
// Pip layout uses a 3×3 grid of 2-char cells inside the box borders.
// ─────────────────────────────────────────────────────────────────────────────

const E = '  ';   // empty cell
const P = '⬤ ';  // pip (bullet + space = 2 chars)

const INNER = {
  1: [[E, E, E], [E, P, E], [E, E, E]],
  2: [[P, E, E], [E, E, E], [E, E, P]],
  3: [[P, E, E], [E, P, E], [E, E, P]],
  4: [[P, E, P], [E, E, E], [P, E, P]],
  5: [[P, E, P], [E, P, E], [P, E, P]],
  6: [[P, E, P], [P, E, P], [P, E, P]],
};

function makeFace(n) {
  const g = INNER[n];
  return [
    '╔═══════╗',
    `║ ${g[0].join('')}║`,
    '║       ║',
    `║ ${g[1].join('')}║`,
    '║       ║',
    `║ ${g[2].join('')}║`,
    '╚═══════╝',
  ];
}

const FACES = {};
for (let i = 1; i <= 6; i++) FACES[i] = makeFace(i);

// ─────────────────────────────────────────────────────────────────────────────
// MOTION FRAMES — tumbling die between faces
// Four tilt angles: slight-right, steep-right, steep-left, slight-left
// ─────────────────────────────────────────────────────────────────────────────

const TILT = [
  [  // T0: slight right lean — top edge nudged right
    '╔══════╗ ',
    '╚╗      ╚╗',
    ' ║  ░░  ║',
    ' ║  ░░  ║',
    ' ║  ░░  ║',
    ' ╔╝      ╔╝',
    ' ╚══════╝',
  ],
  [  // T1: steep right — die seen from top-left corner
    ' ╔═════╗',
    '╔╝ ▒▒▒ ╚╗',
    '║  ▒▒▒  ║',
    '╚╗ ▒▒▒ ╔╝',
    ' ║     ║',
    ' ╚═════╝',
    '         ',
  ],
  [  // T2: flat spin — horizontal blur streak
    '         ',
    '╔═══════╗',
    '░░░░░░░░░',
    '▒▒▒▒▒▒▒▒▒',
    '░░░░░░░░░',
    '╚═══════╝',
    '         ',
  ],
  [  // T3: steep left — die seen from top-right
    '╔═════╗ ',
    '╚╗ ▒▒▒ ╔╝',
    '║  ▒▒▒  ║',
    '╔╝ ▒▒▒ ╚╗',
    '║      ║ ',
    '╚═════╝ ',
    '         ',
  ],
  [  // T4: slight left lean
    ' ╔══════╗',
    '╔╝      ╔╝',
    '║  ░░  ║ ',
    '║  ░░  ║ ',
    '║  ░░  ║ ',
    '╚╗      ╚╗',
    ' ╚══════╝',
  ],
];

// Motion blur — shown at peak speed, not between every face
const BLUR = [
  [  // Heavy blur: die moving fast
    '▓▓▓▓▓▓▓▓▓',
    '▓░░░░░░░▓',
    '▓░▒▒▒▒░▓▓',
    '▓░▒████▒░',
    '▓░▒▒▒▒░▓▓',
    '▓░░░░░░░▓',
    '▓▓▓▓▓▓▓▓▓',
  ],
  [  // Medium blur
    '▒▒▒▒▒▒▒▒▒',
    '▒░░░░░░░▒',
    '▒░╔═══╗░▒',
    '▒░║▓▓▓║░▒',
    '▒░╚═══╝░▒',
    '▒░░░░░░░▒',
    '▒▒▒▒▒▒▒▒▒',
  ],
  [  // Light blur — almost resolved
    '░░░░░░░░░',
    '░╔═════╗░',
    '░║ ░░░ ║░',
    '░║ ░░░ ║░',
    '░║ ░░░ ║░',
    '░╚═════╝░',
    '░░░░░░░░░',
  ],
];

// ─────────────────────────────────────────────────────────────────────────────
// IDLE — question mark face
// ─────────────────────────────────────────────────────────────────────────────

const FACE_UNKNOWN = [
  '╔═══════╗',
  '║       ║',
  '║  ╔═╗  ║',
  '║  ╚═╝  ║',
  '║   ╷   ║',
  '║   ·   ║',
  '╚═══════╝',
];

// ─────────────────────────────────────────────────────────────────────────────
// ROLL_CYCLE — sequence of {type, idx} describing one full tumble loop.
// Faces dominate so the viewer can read the numbers; motion frames give
// the impression of rolling without obscuring too long.
//
// Rhythm: face → tilt → face → tilt → face → blur → face → tilt → face → tilt
// At 60ms/frame a full 10-step cycle = 600ms, reads as fast spinning.
// ─────────────────────────────────────────────────────────────────────────────

const ROLL_CYCLE = [
  { type: 'face', idx: null },  // show face
  { type: 'tilt', idx: 0    },  // slight lean
  { type: 'face', idx: null },
  { type: 'tilt', idx: 1    },  // steep lean
  { type: 'face', idx: null },
  { type: 'tilt', idx: 2    },  // flat spin streak
  { type: 'face', idx: null },
  { type: 'tilt', idx: 3    },  // steep lean other side
  { type: 'face', idx: null },
  { type: 'tilt', idx: 4    },  // slight lean other side
  { type: 'face', idx: null },
  { type: 'blur', idx: 0    },  // fast blur (peak speed)
  { type: 'face', idx: null },
  { type: 'blur', idx: 1    },  // medium blur
];

function getFrame(type, idx, face) {
  if (type === 'face') return FACES[face] || FACES[1];
  if (type === 'tilt') return TILT[idx % TILT.length];
  if (type === 'blur') return BLUR[idx % BLUR.length];
  return FACE_UNKNOWN;
}

// ─────────────────────────────────────────────────────────────────────────────
// LANDING deceleration schedule (ms per frame, slowing down)
// ─────────────────────────────────────────────────────────────────────────────

const LANDING_INTERVALS = [60, 80, 100, 130, 170, 220, 280, 360, 460];

export {
  FACES,
  FACE_UNKNOWN,
  TILT,
  BLUR,
  ROLL_CYCLE,
  LANDING_INTERVALS,
  getFrame,
};
