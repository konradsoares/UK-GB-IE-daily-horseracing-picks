/**
 * select-top3.js
 *
 * Reads the daily Perplexity-analyzed picks JSON and outputs a refined version
 * containing only the top 3 profitable horses per race (expected value > 0).
 *
 * Usage:
 *   node select-top3.js betfair-racecards-picks-2025-10-10.json
 */

const fs = require('fs');
const path = require('path');

// ---------- Helpers ----------
function toDec(odds) {
  if (!odds) return null;
  const s = String(odds).trim();

  // Decimal format
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);

  // Fractional like 5/2 → 3.5
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) {
    const a = +frac[1], b = +frac[2];
    if (b > 0) return a / b + 1;
  }

  // Extract from strings like "EXC 4.8"
  const num = s.match(/(\d+(?:\.\d+)?)(?:\s*\/\s*(\d+))?/);
  if (num) {
    if (num[2]) {
      const a = +num[1], b = +num[2];
      if (b > 0) return a / b + 1;
    }
    return parseFloat(num[1]);
  }
  return null;
}

function impliedProb(odds) {
  const d = toDec(odds);
  return d && d > 1 ? 1 / d : 0;
}

function adjustedProb(pick) {
  let p = impliedProb(pick.exchange || pick.exc_dec || pick.odds || pick.odds_note);
  const conf = (pick.confidence || '').toLowerCase();
  if (conf.includes('high')) p *= 1.1;
  else if (conf.includes('medium')) p *= 1.05;

  // Simple form bonus/penalty
  if (pick.form && /1/.test(pick.form)) p *= 1.05;
  if (pick.form && /0/.test(pick.form)) p *= 0.95;
  return Math.min(p, 0.99);
}

function expectedValue(prob, oddsDec) {
  if (!oddsDec || !prob) return -1;
  return (prob * (oddsDec - 1)) - (1 - prob);
}

function calcPotentialProfit(picks) {
  // 1€ stake each, one winner → profit = (winnerOdds - 3)
  for (const p of picks) {
    if (p.oddsDec && p.oddsDec - 3 > 0) return p.oddsDec - 3;
  }
  return -1;
}

// ---------- Main ----------
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

  // keep only EV > 0
  let profitable = picks.filter(p => p.expected_value > 0);

  // sort by adjusted probability descending
  profitable.sort((a, b) => b.probability - a.probability);

  // 🔥 enforce hard cap of 3 no matter what
  profitable = profitable.slice(0, 3);

  // if we ended up with fewer than 1–2 picks, skip
  if (profitable.length === 0) continue;

  // recalc potential profit
  const potential = calcPotentialProfit(profitable);
  if (potential <= 0) continue;

  refined.races.push({
    course,
    time,
    url: race.url,
    shortlist: profitable.map(p => ({
      name: p.name,
      odds: p.exchange || p.odds || p.odds_note || `${p.oddsDec?.toFixed(2)} (dec)`,
      oddsDec: p.oddsDec,
      probability: +(p.probability * 100).toFixed(1),
      expected_value: +p.expected_value.toFixed(3),
      rationale: p.rationale,
      trainer: p.trainer,
      jockey: p.jockey,
      confidence: p.confidence
    })),
    combo_profit_check: potential.toFixed(2)
  });

  console.log(`${course} ${time} → ${profitable.length} profitable picks (combo +${potential.toFixed(2)}€)`);
}

if (!refined.races.length) {
  console.warn('⚠️ No races qualified for profitable top3 selection.');
}

// === Save output ===
const d = new Date(refined.date || new Date());
const Y = d.getFullYear(), M = String(d.getMonth() + 1).padStart(2, '0');
const archiveDir = path.join('docs', 'picks', Y.toString(), M);
fs.mkdirSync(archiveDir, { recursive: true });

// keep original archive naming (no "-top3" suffix)
const outFile = path.join(archiveDir, `${refined.date || toYMD(new Date())}.json`);
fs.writeFileSync(outFile, JSON.stringify(refined, null, 2));
console.log(`✅ Saved filtered (top3) archive: ${outFile}`);

// also copy to docs/latest.json for dashboard
fs.copyFileSync(outFile, path.join('docs', 'latest.json'));
console.log('📋 Updated docs/latest.json');
