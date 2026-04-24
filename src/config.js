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
    // Real slug format: "btc-updown-15m-{unix_timestamp}" — e.g. btc-updown-15m-1777049100
    // The timestamp suffix increments by 900 s per market; match the invariant prefix.
    slugPattern: process.env.POLYMARKET_SLUG_PATTERN ?? 'btc-updown-15m',
    // How often to poll the Gamma API for new / expired markets (ms).
    intervalMs: Number(process.env.POLYMARKET_DISCOVER_INTERVAL_MS ?? 60_000),
  },
});
