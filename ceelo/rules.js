'use strict';

// Evaluate a 3-dice Cee-Lo roll.
// Ranking (highest to lowest):
// 1) 4-5-6 automatic win
// 2) Triples (higher face wins)
// 3) Pair + kicker => point = kicker (higher point wins)
// 4) 1-2-3 automatic loss
// Anything else is non-scoring (reroll in traditional play)

function evaluateCeeLo(dice) {
  if (!Array.isArray(dice) || dice.length !== 3) {
    throw new Error('dice must be an array of three integers');
  }
  const sorted = [...dice].sort((a, b) => a - b);
  const counts = sorted.reduce((m, v) => {
    m[v] = (m[v] || 0) + 1;
    return m;
  }, {});

  const is456 = sorted[0] === 4 && sorted[1] === 5 && sorted[2] === 6;
  if (is456) {
    return {
      category: 'auto-win',
      rank: 4,
      score: 400,
      point: null,
      description: '4-5-6 automatic win',
    };
  }

  const is123 = sorted[0] === 1 && sorted[1] === 2 && sorted[2] === 3;
  if (is123) {
    return {
      category: 'auto-lose',
      rank: 0,
      score: 0,
      point: null,
      description: '1-2-3 automatic loss',
    };
  }

  const vals = Object.keys(counts).map(Number);
  if (vals.length === 1) {
    // triple
    const face = vals[0];
    return {
      category: 'triple',
      rank: 3,
      score: 300 + face, // higher face wins among triples
      point: face,
      description: `triple ${face}`,
    };
  }

  if (vals.length === 2) {
    // pair + kicker
    const kicker = vals.find(v => counts[v] === 1);
    const pairVal = vals.find(v => counts[v] === 2);
    return {
      category: 'point',
      rank: 2,
      score: 200 + kicker, // higher kicker wins
      point: kicker,
      description: `point ${kicker} (pair of ${pairVal})`,
    };
  }

  // non-scoring: reroll in real play
  return {
    category: 'non-scoring',
    rank: 1,
    score: 100,
    point: null,
    description: 'non-scoring combo (reroll required)',
  };
}

export { evaluateCeeLo };
