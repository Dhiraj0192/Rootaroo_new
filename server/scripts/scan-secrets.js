'use strict';
// Blocks commits that contain Stripe secret/restricted keys or webhook secrets.
// Usage: node scripts/scan-secrets.js --staged   (run from the server/ directory or repo root)
const { execFileSync } = require('child_process');

const PATTERN = /(sk|rk)_(live|test)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}/g;

function findSecrets(text) {
  const out = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    for (const m of lineText.matchAll(PATTERN)) out.push({ line: i + 1, match: m[0] });
  });
  return out;
}

function mask(s) {
  const prefix = s.startsWith('whsec_') ? 'whsec_' : s.slice(0, 8);
  return `${prefix}${s.slice(prefix.length, prefix.length + 2)}…`;
}

function stagedFiles() {
  const out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

function stagedContent(file) {
  try {
    return execFileSync('git', ['show', `:${file}`], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch {
    return '';
  }
}

function main() {
  let failed = false;
  for (const file of stagedFiles()) {
    if (/\.(png|jpe?g|gif|webp|pdf|zip|ttf|otf|woff2?|mp4|mov|lottie)$/i.test(file)) continue;
    for (const hit of findSecrets(stagedContent(file))) {
      failed = true;
      console.error(`secret-scan: ${file}:${hit.line} looks like a secret (${mask(hit.match)})`);
    }
  }
  if (failed) {
    console.error('secret-scan: commit blocked. Move the value to server/.env and reference the env var name.');
    process.exit(1);
  }
}

module.exports = { findSecrets, mask, PATTERN };
if (require.main === module && process.argv.includes('--staged')) main();
