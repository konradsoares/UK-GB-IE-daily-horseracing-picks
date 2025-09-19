// archive-picks.js
// Copies today's picks into docs/picks/YYYY/MM/YYYY-MM-DD.json
// and (re)generates docs/picks/index.json

const fs = require('fs');
const path = require('path');

function pad(n){ return String(n).padStart(2,'0'); }

function findLatestPicksFile(cwd='.') {
  const files = fs.readdirSync(cwd)
    .filter(f => /^betfair-racecards-picks-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort(); // lexicographic = chronological
  if (!files.length) throw new Error('No betfair-racecards-picks-YYYY-MM-DD.json found');
  return files[files.length - 1];
}

function ensureDir(p){ fs.mkdirSync(p, { recursive: true }); }

function buildIndex(root) {
  // scan docs/picks/**/**.json (excluding index.json)
  const out = { months: {} };
  const years = fs.existsSync(root) ? fs.readdirSync(root).filter(x => /^\d{4}$/.test(x)) : [];
  for (const y of years) {
    const yDir = path.join(root, y);
    const months = fs.readdirSync(yDir).filter(x => /^\d{2}$/.test(x));
    for (const m of months) {
      const mDir = path.join(yDir, m);
      const days = fs.readdirSync(mDir).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x));
      if (!days.length) continue;
      const key = `${y}-${m}`;
      out.months[key] = days
        .map(f => ({ date: f.replace('.json',''), path: `picks/${y}/${m}/${f}` }))
        .sort((a,b) => a.date.localeCompare(b.date));
    }
  }
  return out;
}

(function main() {
  const latest = findLatestPicksFile('.');
  const raw = fs.readFileSync(latest, 'utf8');
  const data = JSON.parse(raw);

  // derive date from filename; fallback to generated_at if needed
  const m = latest.match(/(\d{4})-(\d{2})-(\d{2})/);
  let yyyy, mm, dd;
  if (m) { yyyy = m[1]; mm = m[2]; dd = m[3]; }
  else {
    const d = new Date(data.generated_at || Date.now());
    yyyy = String(d.getFullYear()); mm = pad(d.getMonth()+1); dd = pad(d.getDate());
  }

  const dstDir = path.join('docs', 'picks', yyyy, mm);
  ensureDir(dstDir);
  const dstFile = path.join(dstDir, `${yyyy}-${mm}-${dd}.json`);
  fs.writeFileSync(dstFile, JSON.stringify(data, null, 2));

  // also keep docs/latest.json up to date
  ensureDir('docs');
  fs.writeFileSync(path.join('docs', 'latest.json'), JSON.stringify(data, null, 2));

  // rebuild index
  const idx = buildIndex(path.join('docs', 'picks'));
  fs.writeFileSync(path.join('docs', 'picks', 'index.json'), JSON.stringify(idx, null, 2));

  console.log('Archived →', dstFile);
})();
