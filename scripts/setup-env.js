#!/usr/bin/env node
/**
 * setup-env.js
 *
 * Discovers active BTC 15-min Polymarket markets via the Gamma API and
 * writes their token IDs into POLYMARKET_TOKEN_IDS in .env — creating the
 * file from .env.example if it doesn't exist yet.
 *
 * Usage:
 *   npm run setup                              # default slug pattern
 *   npm run setup -- 'btc-updown-15m'         # explicit pattern
 *   LOG_LEVEL=debug npm run setup             # verbose (shows matched slugs)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath }                            from 'url';
import path                                         from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const ENV_PATH  = path.join(ROOT, '.env');

const slugPattern = process.argv[2]
  ?? process.env.POLYMARKET_SLUG_PATTERN
  ?? 'btc-updown-15m';

// Silence pino JSON logs so CLI output stays human-readable.
// Dynamic import guarantees LOG_LEVEL is set before pino initialises inside
// discovery.js (static imports are hoisted; dynamic imports are not).
process.env.LOG_LEVEL ??= 'silent';
const { discoverTokenIds } = await import('../src/discovery.js');

// ─── .env writer ───────────────────────────────────────────────────────────

function upsertEnvLine(filePath, key, value) {
  const examplePath = path.join(ROOT, '.env.example');
  let content = '';

  if (existsSync(filePath)) {
    content = readFileSync(filePath, 'utf8');
  } else if (existsSync(examplePath)) {
    content = readFileSync(examplePath, 'utf8');
    console.log('  (.env not found — created from .env.example)');
  }

  const line  = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, 'm');

  // Replace existing line in-place or append if missing
  content = regex.test(content)
    ? content.replace(regex, line)
    : content.trimEnd() + '\n' + line + '\n';

  writeFileSync(filePath, content, 'utf8');
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log(`Slug pattern : "${slugPattern}"`);
console.log(`Target file  : ${ENV_PATH}`);
console.log('');

const tokenIds = await discoverTokenIds(slugPattern);

if (tokenIds.size === 0) {
  console.error(
    'No active markets found.\n\n' +
    'The series may be between rounds (each round lasts 15 min).\n' +
    'Verify live slugs:\n\n' +
    '  curl -s "https://gamma-api.polymarket.com/markets?' +
    'active=true&closed=false&enableOrderBook=true&limit=20" | jq \'.[].slug\'\n'
  );
  process.exit(1);
}

const value = [...tokenIds].join(',');

console.log(`Found ${tokenIds.size} token ID(s):`);
for (const id of tokenIds) console.log(`  ${id}`);
console.log('');

upsertEnvLine(ENV_PATH, 'POLYMARKET_TOKEN_IDS', value);
console.log(`Wrote to .env:`);
console.log(`  POLYMARKET_TOKEN_IDS=${value}`);
