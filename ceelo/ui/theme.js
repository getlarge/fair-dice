'use strict';

// Visual identity: Kool G Rap "4,5,6" (1995) — Cold Chillin' noir
// Deep black, gold/amber brand, blood red for loss, green felt for win

const GOLD    = '#D4AF37';
const FELT    = '#2D6A2D';
const BLOOD   = '#CC2200';
const SMOKE   = '#888888';
const CHALK   = '#DDDDDD';
const CEMENT  = '#444444';
const NEON    = '#00FFAA';  // MQTT connected indicator

const theme = {
  gold:    GOLD,
  felt:    FELT,
  blood:   BLOOD,
  smoke:   SMOKE,
  chalk:   CHALK,
  cement:  CEMENT,
  neon:    NEON,

  // semantic
  brand:      GOLD,
  primary:    CHALK,
  secondary:  SMOKE,
  success:    FELT,
  danger:     BLOOD,
  muted:      CEMENT,
  connected:  NEON,
  disconnected: BLOOD,

  // result category → color
  resultColor(category) {
    if (!category) return SMOKE;
    if (category === 'auto-win') return NEON;
    if (category === 'auto-lose') return BLOOD;
    if (category === 'triple') return GOLD;
    if (category === 'point') return CHALK;
    return SMOKE;
  },

  // log event type → color
  logColor(type) {
    if (type === 'proof') return NEON;
    if (type === 'error') return BLOOD;
    if (type === 'ack')   return GOLD;
    if (type === 'lobby') return GOLD;
    if (type === 'join')  return CHALK;
    if (type === 'reveal') return CHALK;
    return SMOKE;
  },
};

export { theme };
