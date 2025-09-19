#!/usr/bin/env node
/**
 * Betfair racecards scraper (Playwright)
 * Outputs: betfair-racecards-YYYY-MM-DD.json
 * Runners now include: name, jockey, trainer, form (F), odds { sbk, exc }
 */

const fs = require('fs/promises');
const { chromium, devices } = require('playwright');

const BASE = 'https://betting.betfair.com';
const START_URL = `${BASE}/horse-racing/racecards/`;

const CONCURRENCY = 2;                 // keep it low
const BASE_DELAY_MS = 400;             // human-ish pacing
const RETRY_ON_EMPTY = 1;              // one retry if no runners

const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const todayISO = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
};

// tiny promise pool
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0, running = 0;
  return await new Promise((resolve, reject) => {
    const launch = () => {
      while (running < limit && i < items.length) {
        const idx = i++; running++;
        Promise.resolve(fn(items[idx], idx))
          .then(v => out[idx] = v)
          .catch(reject)
          .finally(() => { running--; (i >= items.length && running === 0) ? resolve(out) : launch(); });
      }
    };
    launch();
  });
}

async function getRaceLinks(page) {
  // Don’t block CSS here.
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // cookie banner (best effort)
  try { const btn = await page.$('button:has-text("Accept")'); if (btn) await btn.click({ timeout: 1000 }); } catch {}

  // wait for any meeting list
  await page.waitForSelector('h2.typography-h280', { timeout: 15000 });

  // extract all a-tags under each course list
  const links = await page.evaluate(() => {
    const out = [];
    const toAbs = href => new URL(href, location.origin).href;
    for (const h2 of document.querySelectorAll('h2.typography-h280')) {
      const course = (h2.textContent || '').trim();
      // pick the UL immediately following or the next UL with race_navigation
      let ul = h2.nextElementSibling;
      while (ul && !(ul.tagName === 'UL' && ul.classList.contains('race_navigation'))) {
        ul = ul.nextElementSibling;
      }
      if (!ul) continue;
      for (const a of ul.querySelectorAll('li.race_navigation__item a')) {
        const time = (a.textContent || '').trim();
        const href = a.getAttribute('href') || '';
        if (href) out.push({ course, time, url: toAbs(href) });
      }
    }
    // dedupe
    const seen = new Set();
    return out.filter(r => {
      const key = `${r.course}|${r.time}|${r.url}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });

  return links.map(r => ({ course: clean(r.course), time: clean(r.time), url: r.url }));
}

// async function getRunnersForRace(context, race, attempt = 0) {
//   const page = await context.newPage();

//   // Block heavy stuff but allow **stylesheets** and **xhr**.
//   await page.route('**/*', route => {
//     const t = route.request().resourceType();
//     if (t === 'image' || t === 'font' || t === 'media') return route.abort();
//     return route.continue();
//   });

//   try {
//     await page.goto(race.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

//     // Accept cookie if it reappears
//     try { const btn = await page.$('button:has-text("Accept")'); if (btn) await btn.click({ timeout: 1000 }); } catch {}

//     // Wait for runner cards to exist
//     await page.waitForSelector('.featured_runner', { timeout: 60000 });
//     await page.waitForTimeout(500)
//     // Extract full runner objects
//     const runners = await page.$$eval('.featured_runner', blocks => {
//       const clean = s => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

//       const pickTeamField = (ul, titleFragment) => {
//         if (!ul) return null;
//         const li = Array.from(ul.querySelectorAll('li')).find(li => {
//           const ab = li.querySelector('abbr');
//           const t = ab?.getAttribute('title')?.toLowerCase() || '';
//           return t.includes(titleFragment);
//         });
//         if (!li) return null;
//         const copy = li.cloneNode(true);
//         const ab2 = copy.querySelector('abbr');
//         if (ab2) ab2.remove(); // drop the "J:", "T:", "F:" label
//         return clean(copy.textContent);
//       };

//       const parseOdds = root => {
//         const sbkBtn = root.querySelector('.market_odds__sbk .price_button');
//         const excBtn = root.querySelector('.market_odds__exc .price_button--exc');
//         const textTail = el => {
//           if (!el) return null;
//           // The price text is in text nodes after the label span
//           const txt = Array.from(el.childNodes)
//             .filter(n => n.nodeType === Node.TEXT_NODE)
//             .map(n => n.textContent)
//             .join(' ');
//           const val = clean(txt);
//           return val || null;
//         };
//         const sbk = textTail(sbkBtn);       // e.g. "5/2"
//         const excStr = textTail(excBtn);    // e.g. "3.7"
//         const exc = excStr && !Number.isNaN(parseFloat(excStr)) ? parseFloat(excStr) : null;
//         return { sbk, exc };
//       };

//       return Array.from(blocks).map(block => {
//         const nameEl = block.querySelector('.featured_runner__details h4.name a, h4.name a');
//         const team = block.querySelector('.featured_runner__details ul.team, ul.team');
//         const odds = parseOdds(block);

//         const name = clean(nameEl ? nameEl.textContent : '');
//         const jockey = pickTeamField(team, 'jock');     // matches their "Jocky" too
//         const trainer = pickTeamField(team, 'trainer');
//         const form = pickTeamField(team, 'form');       // F: recent form string

//         return { name, jockey, trainer, form, odds };
//       }).filter(r => r.name);
//     });

//     if (runners.length === 0 && attempt < RETRY_ON_EMPTY) {
//       // soft retry after a short wait (some races lazy-populate)
//       await new Promise(r => setTimeout(r, 1200));
//       return await getRunnersForRace(context, race, attempt + 1);
//     }

//     return { ...race, runners };
//   } catch (e) {
//     console.error(`Race failed [${race.course} ${race.time}] ${race.url}: ${e.message}`);
//     return { ...race, runners: [] };
//   } finally {
//     await page.close().catch(() => {});
//   }
// }
async function getRunnersForRace(context, race, attempt = 0) {
  const page = await context.newPage();

  await page.route('**/*', route => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'font' || t === 'media') return route.abort();
    return route.continue();
  });

  try {
    await page.goto(race.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // If Betfair redirected us to /results/, this race is already off/finished.
    const landed = page.url();
    if (landed.includes('/results/')) {
      console.warn(`Redirected to results → skipping finished race: ${race.course} ${race.time}`);
      return { ...race, runners: [], _note: 'skipped_finished' };
    }

    // Cookie click (best effort)
    try { const btn = await page.$('button:has-text("Accept")'); if (btn) await btn.click({ timeout: 1000 }); } catch {}

    await page.waitForSelector('.featured_runner', { timeout: 15000 });

    const runners = await page.$$eval(
      '.featured_runner',
      cards => cards.map(card => {
        const getText = (sel) => (card.querySelector(sel)?.textContent || '').replace(/\u00a0/g,' ').replace(/\s+/g,' ').trim();
        const name = getText('h4.name a, h4.name');
        const jockey = getText('ul.team li:nth-child(1)');
        const trainer = getText('ul.team li:nth-child(2)');
        const form = getText('ul.team li:nth-child(3)');
        // odds
        const sbkEl = card.querySelector('.market_odds__sbk .price_button');
        const excEl = card.querySelector('.market_odds__exc .price_button--exc');
        const sbk = sbkEl ? sbkEl.textContent.replace(/SBK/i,'').trim() : '';
        const exc = excEl ? excEl.textContent.replace(/EXC/i,'').trim() : '';
        return { name, jockey: jockey.replace(/^J:\s*/,'').trim(), trainer: trainer.replace(/^T:\s*/,'').trim(), form: (form.replace(/^F:\s*/,'') || '').trim(), odds: { sbk, exchange: exc } };
      })
    );

    if ((!runners || runners.length === 0) && attempt < RETRY_ON_EMPTY) {
      await new Promise(r => setTimeout(r, 1200));
      return await getRunnersForRace(context, race, attempt + 1);
    }

    return { ...race, runners };
  } catch (e) {
    console.error(`Race failed [${race.course} ${race.time}] ${race.url}: ${e.message}`);
    return { ...race, runners: [], _error: e.message };
  } finally {
    await page.close().catch(() => {});
  }
}
async function main() {
  const date = todayISO();
  const device = devices['Desktop Chrome'];

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...device,
    locale: 'en-GB',
    timezoneId: 'Europe/Dublin',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });

  const indexPage = await context.newPage();
  const raceLinks = await getRaceLinks(indexPage);
  await indexPage.close();

  if (!raceLinks.length) throw new Error('No race links found on index.');

  console.log(`Found ${raceLinks.length} race links. Scraping runners…`);

  const results = await mapPool(raceLinks, CONCURRENCY, async (race, idx) => {
    // gentle jitter
    const jitter = BASE_DELAY_MS + Math.floor(Math.random() * 300);
    await new Promise(r => setTimeout(r, jitter));
    return await getRunnersForRace(context, race);
  });

  await browser.close();

  const payload = { date, races: results };
  const file = `betfair-racecards-${date}.json`;
  await fs.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');

  const withRunners = results.filter(r => r.runners && r.runners.length).length;
  console.log(`Saved ${results.length} races (${withRunners} with runners) → ${file}`);
}

main().catch(e => {
  console.error('SCRAPE FAILED:', e?.message || e);
  process.exit(1);
});
