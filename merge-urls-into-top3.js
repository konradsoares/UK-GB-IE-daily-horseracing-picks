const fs = require('fs');

const fullFile = 'betfair-racecards-picks-2025-10-10.json';
const top3File = 'betfair-racecards-picks-2025-10-10-top3.json';
const outputFile = 'betfair-racecards-picks-2025-10-10-top3-fixed.json';

const full = JSON.parse(fs.readFileSync(fullFile, 'utf8'));
const top3 = JSON.parse(fs.readFileSync(top3File, 'utf8'));

for (const r of top3.races) {
  const match = full.races.find(
    fr => fr.course === r.course && fr.time === r.time
  );
  if (match && match.url) r.url = match.url;
}

fs.writeFileSync(outputFile, JSON.stringify(top3, null, 2));
console.log('✅ Fixed file saved as', outputFile);
