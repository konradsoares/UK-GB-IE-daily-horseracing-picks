// scrape-results.js
// Scrape winners from Betfair results and update docs.
// Usage: node scrape-results.js [--date YYYY-MM-DD]
//
// Default date = "yesterday" in Europe/Dublin.
// Reads:  docs/picks/YYYY/MM/YYYY-MM-DD.json  (your archived picks)
// Writes: docs/results/YYYY/MM/YYYY-MM-DD.json (winners only)
//         updates docs/picks/YYYY/MM/YYYY-MM-DD.json with { result, hit } per race

const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');

const BASE = 'https://betting.betfair.com';

function pad(n){ return String(n).padStart(2,'0'); }
function toYMD(d){ return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }

// figure date (default: yesterday in Europe/Dublin)
function getTargetDateFromArgs() {
  const arg = process.argv.find(a => a.startsWith('--date='));
  if (arg) return arg.split('=')[1];
  // crude “yesterday in Dublin” without tz libs: shift 24h
  const now = new Date();
  const y = new Date(now.getTime() - 24*60*60*1000);
  return toYMD(y);
}

function archivePathFor(dateStr){
  const [Y, M] = dateStr.split('-');
  return path.join('docs', 'picks', Y, M, `${dateStr}.json`);
}

function resultsPathFor(dateStr){
  const [Y, M] = dateStr.split('-');
  return path.join('docs', 'results', Y, M, `${dateStr}.json`);
}

// Best-effort transform: racecards → results; keep the rest of the path intact
function toResultsUrl(url) {
  try {
    const u = new URL(url);
    return new URL(u.pathname.replace('/racecards/', '/results/'), u.origin).href;
  } catch { return url.replace('/racecards/', '/results/'); }
}

// Robust-ish winner extraction across possible layouts
async function extractWinner(page) {
  // We’ll try a few patterns. We want row with position "1" or "1st".
  const winner = await page.evaluate(() => {
    const clean = s => (s||'').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();

    // helpers
    const pickFromRow = (row) => {
      if (!row) return null;
      const pos = clean(row.querySelector('td:nth-child(1), .position, .pos')?.textContent || '');
      if (!/^1(st)?$/i.test(pos) && !/^1\/\d+/.test(pos)) return null;

      const nameEl = row.querySelector('a[href*="/horse-racing/horse/"], .name a, .runner_name a, .horse a');
      const name = clean(nameEl?.textContent || '');
      if (!name) return null;

      // SP odds (if present)
      const sp = clean(
        row.querySelector('td.sp, td.price, .sp, .odds, .returned_sp')?.textContent || ''
      ) || null;

      // jockey/trainer (if present)
      const j = clean(
        row.querySelector('.jockey, td.jockey, .runner_jockey')?.textContent || ''
      ) || null;
      const t = clean(
        row.querySelector('.trainer, td.trainer, .runner_trainer')?.textContent || ''
      ) || null;

      return { name, sp: sp || null, jockey: j || null, trainer: t || null };
    };

    // Strategy 1: tabular results
    for (const tbl of document.querySelectorAll('table, .results_table, .result_table')) {
      // find header to guess pos/name columns…
      const rows = Array.from(tbl.querySelectorAll('tbody tr')).filter(r => r.querySelector('td,th'));
      for (const r of rows) {
        const got = pickFromRow(r);
        if (got) return got;
      }
    }

    // Strategy 2: card list with a position badge
    for (const card of document.querySelectorAll('.result_runner, .runner, .card, .result__runner')) {
      const pos = clean(card.querySelector('.position, .pos, .badge')?.textContent || '');
      if (!/^1(st)?$/i.test(pos)) continue;
      const a = card.querySelector('a[href*="/horse-racing/horse/"], .name a');
      const name = clean(a?.textContent || '');
      if (!name) continue;

      const sp = clean(
        card.querySelector('.sp, .odds, .price')?.textContent || ''
      ) || null;
      const j = clean(card.querySelector('.jockey')?.textContent || '') || null;
      const t = clean(card.querySelector('.trainer')?.textContent || '') || null;

      return { name, sp: sp || null, jockey: j, trainer: t };
    }

    // Strategy 3: fallback — first “result” item
    const fallback = document.querySelector('a[href*="/horse-racing/horse/"]');
    if (fallback) {
      return { name: clean(fallback.textContent || '') || null, sp: null, jockey: null, trainer: null };
    }

    return null;
  });
  return winner;
}

(async function main() {
  const date = getTargetDateFromArgs();
  const picksFile = archivePathFor(date);
  if (!fs.existsSync(picksFile)) {
    console.error('No archived picks file:', picksFile);
    process.exit(0);
  }
  const picks = JSON.parse(fs.readFileSync(picksFile, 'utf8'));
  const device = devices['Desktop Chrome'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...device,
    locale: 'en-GB',
    timezoneId: 'Europe/Dublin',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari',
  });

  const outResults = [];
  const updatedRaces = [];

  for (const race of picks.races || []) {
    const resultsUrl = toResultsUrl(race.url);
    const page = await context.newPage();
    try {
      await page.route('**/*', route => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'font' || t === 'media') return route.abort();
        route.continue();
      });

      await page.goto(resultsUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // cookie
      try { const btn = await page.$('button:has-text("Accept")'); if (btn) await btn.click({ timeout: 1000 }); } catch {}

      // Give it a little time for any lazy content
      await page.waitForTimeout(800);

      const winner = await extractWinner(page);

      const norm = s => (s||'').toLowerCase().replace(/\s+/g,' ').trim();
      const shortlist = race.shortlist || [];
      const hit = winner
        ? shortlist.some(p => norm(p.name) === norm(winner.name))
        : false;

      outResults.push({
        course: race.course,
        time: race.time,
        url: resultsUrl,
        winner: winner ? {
          name: winner.name,
          sp: winner.sp || null,
          jockey: winner.jockey || null,
          trainer: winner.trainer || null
        } : null,
        hit
      });

      // also attach to race record
      updatedRaces.push({
        ...race,
        result: winner ? {
          name: winner.name,
          sp: winner.sp || null,
          jockey: winner.jockey || null,
          trainer: winner.trainer || null
        } : null,
        hit
      });

      await page.close();
      // gentle pacing
      await new Promise(r => setTimeout(r, 300 + Math.floor(Math.random()*300)));
    } catch (e) {
      console.error(`Result failed [${race.course} ${race.time}] ${resultsUrl}: ${e.message}`);
      try { await page.close(); } catch {}
      outResults.push({ course: race.course, time: race.time, url: resultsUrl, winner: null, hit: false, _error: e.message });
      updatedRaces.push({ ...race, result: null, hit: false });
    }
  }

  await context.close();
  await browser.close();

  // Write results file
  const resFile = resultsPathFor(date);
  fs.mkdirSync(path.dirname(resFile), { recursive: true });
  fs.writeFileSync(resFile, JSON.stringify({ date, results: outResults }, null, 2));

  // Update archived picks file (in-place)
  const updated = { ...picks, races: updatedRaces };
  fs.writeFileSync(picksFile, JSON.stringify(updated, null, 2));

  console.log('Saved results →', resFile);

  // Optional: if the date is “yesterday” equals today’s “latest”, don’t touch latest.json.
  // You can choose to also reflect results in docs/latest.json by uncommenting:
  // fs.writeFileSync(path.join('docs','latest.json'), JSON.stringify(updated, null, 2));
})();
