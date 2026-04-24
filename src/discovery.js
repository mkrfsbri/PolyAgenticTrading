/**
 * discovery.js — Market Discovery
 *
 * Polls the Polymarket Gamma API to find active CLOB markets whose `slug`
 * matches a regex pattern. Slugs are machine-generated (kebab-case) and far
 * more reliable for programmatic matching than free-text question strings.
 *
 * Calls back with the delta (added / removed) whenever the active token set
 * changes. Uses the built-in `fetch` (Node.js 18+) — no extra dependencies.
 */

import pino from 'pino';

const log = pino({ name: 'discovery', level: process.env.LOG_LEVEL ?? 'info' });

const GAMMA_URL = 'https://gamma-api.polymarket.com/markets';
const PAGE_SIZE = 100;

// ─── Gamma API helpers ─────────────────────────────────────────────────────

async function fetchPage(offset) {
  const url = new URL(GAMMA_URL);
  url.searchParams.set('active',          'true');
  url.searchParams.set('closed',          'false');
  url.searchParams.set('archived',        'false');
  url.searchParams.set('enableOrderBook', 'true');
  url.searchParams.set('limit',           String(PAGE_SIZE));
  url.searchParams.set('offset',          String(offset));

  const res = await fetch(url.toString(), {
    headers: { Accept: 'application/json', 'User-Agent': 'poly-agentic-trading/1.0' },
    // Hard timeout — we don't want a slow Gamma API to stall the ingestion thread.
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) throw new Error(`Gamma API HTTP ${res.status} at offset ${offset}`);
  return res.json();
}

/**
 * clobTokenIds is returned by the Gamma API as a stringified JSON array
 * ("[\"..\",\"..\"]"), not a native array. Handle both formats defensively.
 */
function parseTokenIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Returns a Set of token IDs for all active CLOB markets whose `slug` field
 * matches `slugPattern` (compiled as a case-insensitive RegExp).
 *
 * Slugs are kebab-case, machine-generated identifiers — e.g.
 * "btc-up-or-down-in-15-minutes-jan-15-12-00". Matching on slug is more
 * precise than matching on the human-readable question text.
 *
 * Paginates the Gamma API automatically until the response is a partial page.
 *
 * @param {string} slugPattern  RegExp source string (flags: 'i' applied automatically)
 * @returns {Promise<Set<string>>}
 */
export async function discoverTokenIds(slugPattern) {
  const re    = new RegExp(slugPattern, 'i');
  const found = new Set();
  let   offset = 0;

  while (true) {
    const page = await fetchPage(offset);
    if (!Array.isArray(page) || page.length === 0) break;

    for (const market of page) {
      const slug = market.slug ?? '';
      if (!slug || !re.test(slug)) continue;

      const ids = parseTokenIds(market.clobTokenIds);
      for (const id of ids) found.add(id);

      log.debug({ slug, question: market.question, ids }, 'Slug matched');
    }

    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return found;
}

/**
 * Polls the Gamma API at a fixed interval and invokes `onUpdate` whenever the
 * active token set changes.
 *
 * `onUpdate(added: Set<string>, removed: Set<string>, all: Set<string>)`
 *
 * Start with `await discovery.start()` — the first poll runs immediately so the
 * caller gets a populated set before the ingestion WebSocket subscribes.
 */
export class MarketDiscovery {
  constructor({ slugPattern, intervalMs, onUpdate }) {
    this._slugPattern = slugPattern;
    this._intervalMs  = intervalMs;
    this._onUpdate    = onUpdate;
    this._current     = new Set();
    this._timer       = null;
  }

  /** Runs the first poll inline, then starts the background interval. */
  async start() {
    await this._poll();
    this._timer = setInterval(
      () => this._poll().catch((err) => log.error({ err }, 'Discovery poll error')),
      this._intervalMs
    );
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  async _poll() {
    log.debug({ slugPattern: this._slugPattern }, 'Polling Gamma API for active markets');

    let discovered;
    try {
      discovered = await discoverTokenIds(this._slugPattern);
    } catch (err) {
      // Transient API failure — retain the last known set and retry next interval.
      log.warn({ err }, 'Gamma API fetch failed — retaining current market set');
      return;
    }

    const added   = new Set([...discovered].filter((id) => !this._current.has(id)));
    const removed = new Set([...this._current].filter((id) => !discovered.has(id)));

    if (added.size === 0 && removed.size === 0) {
      log.debug({ total: discovered.size }, 'Market set unchanged');
      return;
    }

    log.info(
      { added: [...added], removed: [...removed], total: discovered.size },
      'Market set changed'
    );

    this._current = discovered;
    this._onUpdate(added, removed, discovered);
  }
}
