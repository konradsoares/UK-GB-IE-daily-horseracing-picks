// postbuild.js
const fs = require('fs');
const path = require('path');

const d = new Date();
const p = n => String(n).padStart(2, '0');
const file = `betfair-racecards-picks-${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}.json`;

if (!fs.existsSync('docs')) fs.mkdirSync('docs', { recursive: true });

if (fs.existsSync(file)) {
  fs.copyFileSync(file, path.join('docs', 'latest.json'));
  console.log('Copied', file, '→ docs/latest.json');
} else {
  console.log('No file to copy:', file);
  process.exitCode = 0; // don’t fail CI if there’s nothing today
}
