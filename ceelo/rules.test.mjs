import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCeeLo } from './rules.js';

test('4-5-6 automatic win', () => {
  const r = evaluateCeeLo([4, 6, 5]);
  assert.equal(r.category, 'auto-win');
  assert.equal(r.rank, 4);
  assert.equal(r.score, 400);
});

test('1-2-3 automatic loss', () => {
  const r = evaluateCeeLo([3, 1, 2]);
  assert.equal(r.category, 'auto-lose');
  assert.equal(r.rank, 0);
});

test('triples rank by face value', () => {
  const t2 = evaluateCeeLo([2, 2, 2]);
  const t5 = evaluateCeeLo([5, 5, 5]);
  assert.equal(t2.category, 'triple');
  assert.ok(t5.score > t2.score);
});

test('point from pair + kicker', () => {
  const r = evaluateCeeLo([3, 3, 6]);
  assert.equal(r.category, 'point');
  assert.equal(r.point, 6);
  assert.equal(r.rank, 2);
});

test('non-scoring combo', () => {
  const r = evaluateCeeLo([1, 4, 6]);
  assert.equal(r.category, 'non-scoring');
  assert.equal(r.rank, 1);
});

test('invalid inputs throw', () => {
  assert.throws(() => evaluateCeeLo([1, 2]), /three integers/);
  assert.throws(() => evaluateCeeLo('nope'), /array/);
});
