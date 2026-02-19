'use strict';

import { useState, useEffect, useRef } from 'react';
import { ROLL_CYCLE, LANDING_INTERVALS, FACES, FACE_UNKNOWN, getFrame } from '../dice-frames.js';

const FAST_INTERVAL = 60; // ms per frame during full roll

function randomFace() {
  return Math.floor(Math.random() * 6) + 1;
}

function initialDieState() {
  return { framePos: 0, face: randomFace() };
}

export function useDiceAnimation(phase, finalDice) {
  const [frames, setFrames] = useState([FACE_UNKNOWN, FACE_UNKNOWN, FACE_UNKNOWN]);

  // Refs don't go stale inside setInterval/setTimeout callbacks
  const dieState     = useRef([initialDieState(), initialDieState(), initialDieState()]);
  const landingStep  = useRef(0);
  const timerRef     = useRef(null);
  const finalDiceRef = useRef(finalDice);
  finalDiceRef.current = finalDice; // always current inside callbacks

  function clearTimer() {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function frozenFrames() {
    const fd = finalDiceRef.current;
    return (fd && fd.length === 3)
      ? fd.map(f => FACES[f] || FACE_UNKNOWN)
      : [FACE_UNKNOWN, FACE_UNKNOWN, FACE_UNKNOWN];
  }

  // Advance all 3 dice one step; dice are offset in the cycle by +3 each
  // so they're always showing different phases simultaneously.
  function advanceRollFrame() {
    const ds = dieState.current;
    const cycleLen = ROLL_CYCLE.length;
    const next = ds.map((d, i) => {
      const pos  = (d.framePos + 1) % cycleLen;
      const spec = ROLL_CYCLE[(pos + i * 3) % cycleLen];
      const face = spec.type === 'face' ? randomFace() : d.face;
      return { framePos: pos, face };
    });
    dieState.current = next;
    setFrames(next.map((d, i) => {
      const spec = ROLL_CYCLE[(d.framePos + i * 3) % cycleLen];
      return getFrame(spec.type, spec.idx, d.face);
    }));
  }

  // Deceleration chain: each step schedules the next with a longer delay.
  // Dice lock in left-to-right as we approach the end.
  function doLandingStep() {
    const step  = landingStep.current;
    const total = LANDING_INTERVALS.length;
    const cycleLen = ROLL_CYCLE.length;

    if (step >= total) {
      setFrames(frozenFrames());
      return;
    }

    // Lock dice progressively: first die locks at step 3, second at 6, third at 8
    const lockedCount = step < 3 ? 0 : step < 6 ? 1 : step < 8 ? 2 : 3;
    const fd = finalDiceRef.current;

    setFrames(dieState.current.map((d, i) => {
      if (i < lockedCount && fd && fd[i]) {
        return FACES[fd[i]] || FACE_UNKNOWN;
      }
      // Still rolling but decelerating
      const newPos  = (d.framePos + 1) % cycleLen;
      const spec    = ROLL_CYCLE[(newPos + i * 3) % cycleLen];
      const newFace = spec.type === 'face' ? randomFace() : d.face;
      dieState.current[i] = { framePos: newPos, face: newFace };
      return getFrame(spec.type, spec.idx, newFace);
    }));

    landingStep.current = step + 1;
    const nextInterval = LANDING_INTERVALS[step + 1];
    if (nextInterval !== undefined) {
      timerRef.current = setTimeout(doLandingStep, nextInterval);
    } else {
      timerRef.current = setTimeout(() => setFrames(frozenFrames()), 80);
    }
  }

  useEffect(() => {
    clearTimer();

    switch (phase) {
      case 'idle':
        setFrames([FACE_UNKNOWN, FACE_UNKNOWN, FACE_UNKNOWN]);
        break;

      case 'rolling':
        dieState.current = [initialDieState(), initialDieState(), initialDieState()];
        timerRef.current = setInterval(advanceRollFrame, FAST_INTERVAL);
        break;

      case 'landing':
        landingStep.current = 0;
        timerRef.current = setTimeout(doLandingStep, LANDING_INTERVALS[0]);
        break;

      case 'frozen':
        setFrames(frozenFrames());
        break;
    }

    return clearTimer;
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  return frames;
}
