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
    // Set POLYMARKET_AUTO_DISCOVER=false to use only static POLYMARKET_TOKEN_IDS.
    enabled: process.env.POLYMARKET_AUTO_DISCOVER !== 'false',
    // AND-joined keywords — every keyword must appear in the market question.
    // Default targets BTC 15-minute markets; adjust via POLYMARKET_KEYWORDS.
    keywords: (process.env.POLYMARKET_KEYWORDS ?? 'BTC,15')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    // How often to poll the Gamma API for new / expired markets (ms).
    intervalMs: Number(process.env.POLYMARKET_DISCOVER_INTERVAL_MS ?? 60_000),
  },
});
