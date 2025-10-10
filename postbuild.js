// postbuild.js
const fs = require('fs');
const path = require('path');

const d = new Date();
const p = n => String(n).padStart(2, '0');
const base = `betfair-racecards-picks-${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
const top3File = `${base}-top3.json`;
const fullFile = `${base}.json`;

if (!fs.existsSync('docs')) fs.mkdirSync('docs', { recursive: true });

// prefer the filtered Top3 file if it exists
let srcFile = null;
if (fs.existsSync(top3File)) {
  srcFile = top3File;
} else if (fs.existsSync(fullFile)) {
  srcFile = fullFile;
}

if (srcFile) {
  fs.copyFileSync(srcFile, path.join('docs', 'latest.json'));
  console.log(`✅ Copied ${srcFile} → docs/latest.json`);
} else {
  console.log(`⚠️ No picks file found for today (${base}). Nothing copied.`);
  process.exitCode = 0; // don't fail CI
}
