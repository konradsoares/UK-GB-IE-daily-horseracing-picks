#!/usr/bin/env node
/**
 * Analyze Betfair racecards with Perplexity (Sonar)
 * Input:  betfair-racecards-YYYY-MM-DD.json  (from your scraper; includes runners with J/T/Form/Odds)
 * Output: betfair-racecards-picks-YYYY-MM-DD.json
 */

'use strict';

const fs = require('fs/promises');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

const API_URL = 'https://api.perplexity.ai/chat/completions';
const MODEL   = 'sonar-pro';       // web-grounded model
const CONCURRENCY = 2;             // keep it gentle
const MAX_TOKENS  = 800;
const TEMPERATURE = 0.1;

const PPLX_KEY = process.env.PERPLEXITY_API_KEY || process.env.PPLX_API_KEY;
if (!PPLX_KEY) {
  console.error('Missing PERPLEXITY_API_KEY env var.');
  process.exit(1);
}

// ---------- helpers ---------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

const todayISO = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
};

const defaultInputFile = `betfair-racecards-${todayISO()}.json`;
const inputFile = process.argv[2] || defaultInputFile;

// Tiny promise pool (like in your scraper)
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0, running = 0, rejectOnce;
  return await new Promise((resolve, reject) => {
    rejectOnce = reject;
    const launch = () => {
      while (running < limit && i < items.length) {
        const idx = i++; running++;
        Promise.resolve(fn(items[idx], idx))
          .then(v => out[idx] = v)
          .catch(rejectOnce)
          .finally(() => {
            running--;
            if (i >= items.length && running === 0) resolve(out);
            else launch();
          });
      }
    };
    launch();
  });
}

async function callPerplexity(messages) {
  const body = {
    model: MODEL,                   // "sonar-pro"
    messages,                       // system + user
    max_tokens: MAX_TOKENS,         // 800
    temperature: TEMPERATURE,       // 0.1
    // remove response_format — this was causing 400
    // optional steering (harmless if ignored):
    return_citations: false,
    // Helps keep it on Betfair when it browses:
    // search_domain_filter: ["betting.betfair.com"]
  };

  const headers = {
    Authorization: `Bearer ${PPLX_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    const res = await axios.post(API_URL, body, { headers, timeout: 60000 });
    const content = res?.data?.choices?.[0]?.message?.content || '';

    // Try strict parse. If that fails, try to salvage the first JSON object.
    const parsed = tryParseJSON(content);
    return { parsed, api: res.data, raw: content };
  } catch (e) {
    // Surface Perplexity’s error details so you can see why it’s 400
    const status = e?.response?.status;
    const data = e?.response?.data;
    const msg = e?.message || String(e);
    const detail = typeof data === 'object' ? JSON.stringify(data) : String(data || '');
    throw new Error(`${msg}${detail ? ` | body: ${detail}` : ''}${status ? ` | status: ${status}` : ''}`);
  }
}

function tryParseJSON(text) {
  // 1) direct parse
  try { return JSON.parse(text); } catch {}

  // 2) find the first {...} block that parses
  const start = text.indexOf('{');
  if (start >= 0) {
    // naive scan to match braces
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(start, i + 1);
          try { return JSON.parse(candidate); } catch {}
        }
      }
    }
  }
  // 3) give up; keep raw for debugging
  return { _raw: text };
}

function buildMessages(race) {
  const system = {
    role: 'system',
    content: [
      'You are a professional horse racing analyst.',
      'Return only valid JSON matching the requested shape.',
      'Use current odds and form logic. Exclude longshots.',
      'Use the supplied race URL for context (web is enabled).'
    ].join(' ')
  };

  const schema = {
    type: 'object',
    properties: {
      race: {
        type: 'object',
        properties: {
          course: { type: 'string' },
          time:   { type: 'string' },
          url:    { type: 'string' }
        },
        required: ['course', 'time', 'url']
      },
      shortlist: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name:       { type: 'string' },
            jockey:     { type: 'string' },
            trainer:    { type: 'string' },
            form:       { type: 'string' },
            odds_note:  { type: 'string' },
            rationale:  { type: 'string' },
            confidence: { type: 'string' }
          },
          required: ['name', 'rationale']
        },
        minItems: 1
      }
    },
    required: ['race', 'shortlist'],
    additionalProperties: false
  };

  const user = {
    role: 'user',
    content: [
      'Given the following race JSON (course, time, url, runners with name, jockey, trainer, recent form "F", and odds), analyze the field as a professional.',
      'Rules:',
      '- Research each runner using the provided details and the race URL.',
      '- Exclude outsiders/longshots by current exchange/bookmaker odds.',
      '- From remaining runners, return ONLY your strongest potential winners with brief justifications (form, odds value, connections).',
      '- Do NOT include horses needing major improvement.',
      '',
      'Return strict JSON only, matching this shape:',
      JSON.stringify(schema, null, 2),
      '',
      'Race JSON:',
      JSON.stringify({
        race: { course: race.course, time: race.time, url: race.url },
        runners: race.runners
      }, null, 2)
    ].join('\n')
  };

  return [system, user];
}

// ---------- main ------------------------------------------------------------

(async () => {
  // Load input
  const inputPath = path.resolve(process.cwd(), inputFile);
  const raw = await fs.readFile(inputPath, 'utf8').catch(() => null);
  if (!raw) {
    console.error(`Input not found: ${inputPath}`);
    process.exit(1);
  }
  const input = JSON.parse(raw);
  const races = (input.races || []).map(r => {
    if (Array.isArray(r.runners) && typeof r.runners[0] === 'string') {
      r.runners = r.runners.map(name => ({ name, jockey: '', trainer: '', form: '', odds: {} }));
    }
    return r;
  });

  const out = {
    date: input.date || todayISO(),
    model: MODEL,
    generated_at: new Date().toISOString(),
    races: races.map(r => ({ course: r.course, time: r.time, url: r.url, shortlist: [], _status: 'pending' }))
  };

  // Do the calls with limited concurrency
  await mapPool(races, CONCURRENCY, async (race, idx) => {
    const target = out.races[idx];
    const messages = buildMessages(race);

    let attempt = 0;
    while (attempt < 3) {
      try {
        const { parsed, api } = await callPerplexity(messages);
        if (parsed && parsed.shortlist && Array.isArray(parsed.shortlist)) {
          target.shortlist = parsed.shortlist.map(item => ({
            name: item.name,
            jockey: item.jockey || race.runners.find(r => r.name === item.name)?.jockey || '',
            trainer: item.trainer || race.runners.find(r => r.name === item.name)?.trainer || '',
            form: item.form || race.runners.find(r => r.name === item.name)?.form || '',
            odds_note: item.odds_note || '',
            rationale: item.rationale || '',
            confidence: item.confidence || ''
          }));
          target._status = 'ok';
          target._usage = api?.usage || undefined;
          break;
        } else {
          target._status = 'bad_json';
          target._raw = parsed?._raw || null;
          break;
        }
      } catch (e) {
        attempt++;
        const code = e?.response?.status || 0;
        if (code === 429 || code >= 500) {
          await sleep(1000 * attempt);
          continue;
        }
        target._status = `error_${code || 'unknown'}`;
        target._error = e?.message || String(e);
        break;
      }
    }
  });

  const outFile = `betfair-racecards-picks-${out.date}.json`;
  await fs.writeFile(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`Saved picks → ${outFile}`);

  const ok = out.races.filter(r => r._status === 'ok').length;
  console.log(`Races analyzed: ${ok}/${out.races.length}`);
})().catch(err => {
  console.error('FAILED:', err?.message || err);
  process.exit(1);
});
