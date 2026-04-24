import 'dotenv/config';

export const config = Object.freeze({
  binance: {
    wsUrl:
      process.env.BINANCE_WS_URL ??
      'wss://stream.binance.com:9443/ws/btcusdt@depth10@100ms',
  },

  polymarket: {
    // Polymarket CLOB WebSocket — provides real-time L2 order book via the
    // Central Limit Order Book API.
    wsUrl: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
    // Comma-separated ERC-1155 outcome token IDs; both the Up and Down tokens
    // for the active BTC 15-minute market should be listed.
    tokenIds: (process.env.POLYMARKET_TOKEN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  questdb: {
    host: process.env.QUESTDB_HOST ?? '127.0.0.1',
    ilpPort: Number(process.env.QUESTDB_ILP_PORT ?? 9009),
  },

  buffer: {
    // Flush to QuestDB every 250 ms …
    flushIntervalMs: 250,
    // … or immediately when this many records have accumulated (whichever first).
    highWaterMark: 1_000,
  },

  watchdog: {
    // Workers emit a heartbeat at this cadence.
    heartbeatIntervalMs: 5_000,
    // If the orchestrator sees no heartbeat within this window, restart all workers.
    timeoutMs: 15_000,
  },

  discovery: {
    // Set POLYMARKET_AUTO_DISCOVER=false to rely solely on POLYMARKET_TOKEN_IDS.
    enabled: process.env.POLYMARKET_AUTO_DISCOVER !== 'false',
    // Regex matched against each market's `slug` field (case-insensitive, no flags needed).
    // Slugs are kebab-case: e.g. "btc-up-or-down-in-15-minutes-jan-15-12-00".
    // Default targets BTC 15-minute markets; refine via POLYMARKET_SLUG_PATTERN.
    slugPattern: process.env.POLYMARKET_SLUG_PATTERN ?? 'btc.*15',
    // How often to poll the Gamma API for new / expired markets (ms).
    intervalMs: Number(process.env.POLYMARKET_DISCOVER_INTERVAL_MS ?? 60_000),
  },
});
