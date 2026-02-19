import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCeeLo } from './rules.js';

// ── auto-win / auto-lose ──────────────────────────────────────────────────────

test('4-5-6 automatic win — any order', () => {
  for (const perm of [[4,5,6],[4,6,5],[5,4,6],[5,6,4],[6,4,5],[6,5,4]]) {
    const r = evaluateCeeLo(perm);
    assert.equal(r.category, 'auto-win',   `perm ${perm}`);
    assert.equal(r.rank,     4,            `perm ${perm}`);
    assert.equal(r.score,    400,          `perm ${perm}`);
    assert.equal(r.point,    null,         `perm ${perm}`);
  }
});

test('1-2-3 automatic loss — any order', () => {
  for (const perm of [[1,2,3],[1,3,2],[2,1,3],[2,3,1],[3,1,2],[3,2,1]]) {
    const r = evaluateCeeLo(perm);
    assert.equal(r.category, 'auto-lose',  `perm ${perm}`);
    assert.equal(r.rank,     0,            `perm ${perm}`);
    assert.equal(r.score,    0,            `perm ${perm}`);
    assert.equal(r.point,    null,         `perm ${perm}`);
  }
});

// ── triples ───────────────────────────────────────────────────────────────────

test('all six triples have category=triple and correct point/score', () => {
  for (let face = 1; face <= 6; face++) {
    const r = evaluateCeeLo([face, face, face]);
    assert.equal(r.category, 'triple',       `triple ${face}`);
    assert.equal(r.rank,     3,              `triple ${face}`);
    assert.equal(r.point,    face,           `triple ${face}`);
    assert.equal(r.score,    300 + face,     `triple ${face}`);
  }
});

test('triples rank strictly by face value', () => {
  const scores = [1,2,3,4,5,6].map(f => evaluateCeeLo([f,f,f]).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] > scores[i-1], `triple ${i+1} should beat triple ${i}`);
  }
});

test('triple always beats a point', () => {
  const lowestTriple = evaluateCeeLo([1,1,1]);
  const highestPoint = evaluateCeeLo([6,6,5]); // point 5 — highest possible point
  assert.ok(lowestTriple.score > highestPoint.score, 'triple-1 > point-5');
});

// ── points ────────────────────────────────────────────────────────────────────

test('point kicker equals the lone die', () => {
  // pair of 3, kicker 6
  assert.equal(evaluateCeeLo([3,3,6]).point, 6);
  // pair of 6, kicker 1
  assert.equal(evaluateCeeLo([6,6,1]).point, 1);
  // pair of 2, kicker 4 — unordered input
  assert.equal(evaluateCeeLo([4,2,2]).point, 4);
});

test('all valid kicker values 1-6 produce category=point', () => {
  // Build a pair that doesn't clash with the kicker
  const pairFace = (kicker) => kicker === 1 ? 2 : 1;
  for (let kicker = 1; kicker <= 6; kicker++) {
    const p = pairFace(kicker);
    const r = evaluateCeeLo([p, p, kicker]);
    assert.equal(r.category, 'point', `kicker ${kicker}`);
    assert.equal(r.rank,     2,       `kicker ${kicker}`);
    assert.equal(r.point,    kicker,  `kicker ${kicker}`);
    assert.equal(r.score,    200 + kicker, `kicker ${kicker}`);
  }
});

test('higher kicker beats lower kicker', () => {
  const p1 = evaluateCeeLo([2,2,6]); // point 6
  const p2 = evaluateCeeLo([2,2,3]); // point 3
  assert.ok(p1.score > p2.score, 'point-6 > point-3');
});

test('point always beats non-scoring', () => {
  const lowestPoint = evaluateCeeLo([2,2,1]); // point 1
  const nonScoring  = evaluateCeeLo([1,4,6]);
  assert.ok(lowestPoint.score > nonScoring.score, 'point-1 > non-scoring');
});

// ── non-scoring ───────────────────────────────────────────────────────────────

test('non-scoring combos — various all-different faces', () => {
  const combos = [[1,2,4],[1,3,5],[1,3,6],[2,3,4],[2,4,5],[2,5,6],[3,4,6]];
  for (const c of combos) {
    const r = evaluateCeeLo(c);
    assert.equal(r.category, 'non-scoring', `combo ${c}`);
    assert.equal(r.rank,     1,             `combo ${c}`);
  }
});

// ── ranking order ─────────────────────────────────────────────────────────────

test('full ranking order: auto-win > triple-6 > … > triple-1 > point-6 > … > point-1 > non-scoring > auto-lose', () => {
  const results = [
    evaluateCeeLo([4,5,6]),          // auto-win   400
    ...([6,5,4,3,2,1].map(f => evaluateCeeLo([f,f,f]))), // triples 6..1
    ...[6,5,4,3,2,1].map(k => {     // points 6..1
      const p = k === 1 ? 2 : 1;
      return evaluateCeeLo([p,p,k]);
    }),
    evaluateCeeLo([1,4,6]),          // non-scoring
    evaluateCeeLo([1,2,3]),          // auto-lose
  ];
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i-1].score >= results[i].score,
      `results[${i-1}] (score ${results[i-1].score}) should be >= results[${i}] (score ${results[i].score})`,
    );
  }
});

// ── input validation ──────────────────────────────────────────────────────────

test('throws on wrong length', () => {
  assert.throws(() => evaluateCeeLo([1, 2]),       /three integers/);
  assert.throws(() => evaluateCeeLo([1, 2, 3, 4]), /three integers/);
  assert.throws(() => evaluateCeeLo([]),            /three integers/);
});

test('throws on non-array', () => {
  assert.throws(() => evaluateCeeLo('nope'),        /array/);
  assert.throws(() => evaluateCeeLo(null),          /array/);
  assert.throws(() => evaluateCeeLo(123),           /array/);
});
