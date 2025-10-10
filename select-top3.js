/**
 * select-top3.js
 * 
 * Reads the daily Perplexity-analyzed picks JSON and outputs a refined version
 * containing only the top 3 profitable horses per race (expected value > 0).
 * 
 * Usage:
 *   node select-top3.js ./picks/2025/10/10/betfair-racecards-picks-2025-10-10.json
 */

const fs = require('fs');
const path = require('path');


function toDec(odds) {
  if (!odds) return null;
  const s = String(odds).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const a = parseFloat(frac[1]), b = parseFloat(frac[2]);
    if (b > 0) return a / b + 1;
  }
  const num = s.match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (num) {
    if (num[2]) {
      const a = +num[1], b = +num[2];
      if (b) return a / b + 1;
    }
    return parseFloat(num[1]);
  }
  return null;
}

// basic market-based probability
function impliedProb(odds) {
  const d = toDec(odds);
  return d && d > 1 ? 1 / d : 0;
}

// adjust probability slightly using model confidence
function adjustedProb(pick) {
  let p = impliedProb(pick.exchange || pick.exc_dec || pick.odds || pick.odds_note);
  const conf = (pick.confidence || '').toLowerCase();
  if (conf.includes('high')) p *= 1.10;
  else if (conf.includes('medium')) p *= 1.05;
  // slight form influence
  if (pick.form && /1/.test(pick.form)) p *= 1.05;
  if (pick.form && /0/.test(pick.form)) p *= 0.95;
  return Math.min(p, 0.99);
}

// expected value calculation
function expectedValue(prob, oddsDec) {
  if (!oddsDec || !prob) return -1;
  return (prob * (oddsDec - 1)) - (1 - prob);
}

function calcPotentialProfit(picks) {
  // assume 1€ stake per horse, only one winner
  for (const p of picks) {
    const dec = toDec(p.oddsDec);
    const profit = dec - 3; // one wins, two lose
    if (profit > 0) return profit;
  }
  return -1;
}

// === MAIN ===
const inFile = process.argv[2];
if (!inFile) {
  console.error('Usage: node select-top3.js <input-file>');
  process.exit(1);
}
const text = fs.readFileSync(inFile, 'utf8');
const data = JSON.parse(text);

const refined = {
  ...data,
  races: [],
  generated_at: new Date().toISOString(),
  note: 'Filtered to top 3 profitable picks per race'
};

for (const race of data.races || []) {
  const course = race.course?.trim() || '';
  const time = race.time?.trim() || '';
  const picks = (race.shortlist || []).map(p => {
    const dec = toDec(p.exchange || p.exc_dec || p.odds || p.odds_note);
    const prob = adjustedProb(p);
    const ev = expectedValue(prob, dec);
    return { ...p, oddsDec: dec, probability: prob, expected_value: ev };
  });

  const profitable = picks.filter(p => p.expected_value > 0);
  if (profitable.length < 3) continue; // skip unprofitable races

  // sort by adjusted probability desc
  profitable.sort((a, b) => b.probability - a.probability);

  // pick top 3
  const top3 = profitable.slice(0, 3);
  const potential = calcPotentialProfit(top3);

  if (potential <= 0) continue; // skip if no combo profit

  refined.races.push({
    course,
    time,
    best_3_picks: top3.map(p => ({
      name: p.name,
      odds: p.oddsDec,
      probability: +(p.probability * 100).toFixed(1),
      expected_value: +p.expected_value.toFixed(3),
      rationale: p.rationale,
      trainer: p.trainer,
      jockey: p.jockey
    })),
    combo_profit_check: potential.toFixed(2)
  });

  console.log(`${course} ${time} → ${top3.length} profitable picks (combo +${potential.toFixed(2)}€)`);
}

if (!refined.races.length) {
  console.warn('No races qualified for profitable top3 selection.');
}

const dir = path.dirname(inFile);
const base = path.basename(inFile).replace('.json', '');
const outFile = path.join(dir, `${base}-top3.json`);
fs.writeFileSync(outFile, JSON.stringify(refined, null, 2));
console.log(`✅ Saved filtered file: ${outFile}`);
