/**
 * ingestion.worker.js — The Eyes
 *
 * Maintains two persistent WebSocket connections:
 *   1. Binance — `btcusdt@depth10@100ms` partial book depth stream.
 *   2. Polymarket CLOB — L2 order book for auto-discovered outcome token IDs.
 *
 * Token IDs are managed dynamically by MarketDiscovery (src/discovery.js):
 *   - On startup: seeds from POLYMARKET_TOKEN_IDS env var (optional).
 *   - Every 60 s: polls the Gamma API, detects new / expired markets.
 *   - New markets are hot-subscribed on the live WebSocket without reconnecting.
 *   - Expired market order books are evicted from memory immediately.
 *
 * Reconnection uses exponential backoff (1 s → 32 s) per source.
 * A periodic ping/pong cycle detects silent-but-open ("ghost") connections.
 */

import { workerData, parentPort } from 'worker_threads';
import WebSocket                   from 'ws';
import pino                        from 'pino';
import { config }                  from '../config.js';
import { MarketDiscovery }         from '../discovery.js';

const log = pino({ name: 'ingestion', level: process.env.LOG_LEVEL ?? 'info' });

// The port goes directly to database.worker.js — postMessage here bypasses main.
const { port } = workerData;

// ─── High-precision epoch clock ────────────────────────────────────────────
//
// process.hrtime.bigint() gives nanosecond resolution but is not epoch-based.
// We anchor it to Date.now() once at startup to produce epoch-nanosecond
// timestamps without repeated syscalls or drift accumulation.
const _hrtimeOriginNs = process.hrtime.bigint();
const _epochOriginNs  = BigInt(Date.now()) * 1_000_000n;

function nowNs() {
  return _epochOriginNs + (process.hrtime.bigint() - _hrtimeOriginNs);
}

// ─── Reconnect helpers ─────────────────────────────────────────────────────

const MIN_RECONNECT_MS = 1_000;
const MAX_RECONNECT_MS = 32_000;

const _reconnectDelay  = { binance: MIN_RECONNECT_MS, polymarket: MIN_RECONNECT_MS };
const _reconnectTimers = {};

function scheduleReconnect(source, connectFn) {
  clearTimeout(_reconnectTimers[source]);
  const delay = _reconnectDelay[source];
  log.info({ source, delayMs: delay }, 'Reconnecting after delay');
  _reconnectTimers[source] = setTimeout(connectFn, delay);
  _reconnectDelay[source]  = Math.min(delay * 2, MAX_RECONNECT_MS);
}

function resetReconnectDelay(source) {
  _reconnectDelay[source] = MIN_RECONNECT_MS;
}

// ─── Ping / pong factory ───────────────────────────────────────────────────
//
// Creates a self-contained ping/pong keeper for a single WebSocket instance.
// If the remote peer doesn't answer a ping within PONG_TIMEOUT_MS, the socket
// is terminated to force a reconnect.

const PING_INTERVAL_MS = 20_000;
const PONG_TIMEOUT_MS  = 10_000;

function createPingPong(ws, label) {
  let pingTimer = null;
  let pongTimer = null;

  function start() {
    stop();
    pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.ping();
      pongTimer = setTimeout(() => {
        log.warn({ label }, 'Pong timeout — terminating stale connection');
        ws.terminate();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on('pong', () => {
      clearTimeout(pongTimer);
      pongTimer = null;
    });
  }

  function stop() {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = null;
    pongTimer = null;
  }

  return { start, stop };
}

// ═══════════════════════════════════════════════════════════════════════════
// BINANCE
// ═══════════════════════════════════════════════════════════════════════════

let binanceWs = null;
let binancePP = null; // ping/pong keeper

function connectBinance() {
  log.info({ url: config.binance.wsUrl }, 'Connecting to Binance WebSocket');

  binanceWs = new WebSocket(config.binance.wsUrl, {
    perMessageDeflate: false, // Saves CPU; bandwidth is not a constraint here
  });

  binanceWs.once('open', () => {
    // noDelay disables Nagle's algorithm — critical for 100 ms update streams.
    binanceWs._socket?.setNoDelay(true);
    log.info('Binance WebSocket open');
    resetReconnectDelay('binance');
    binancePP = createPingPong(binanceWs, 'binance');
    binancePP.start();
  });

  binanceWs.on('message', (raw) => {
    const arrivalTs = nowNs();
    try {
      const record = normalizeBinance(JSON.parse(raw), arrivalTs);
      if (record) port.postMessage(record);
    } catch (err) {
      log.warn({ err }, 'Binance message parse error');
    }
  });

  binanceWs.on('close', (code, reason) => {
    log.warn({ code, reason: reason.toString() }, 'Binance WS closed');
    binancePP?.stop();
    scheduleReconnect('binance', connectBinance);
  });

  binanceWs.on('error', (err) => {
    log.error({ err }, 'Binance WS error');
    binanceWs.terminate();
  });
}

/**
 * Normalize a Binance depth10 message.
 *
 * Wire format:
 *   { lastUpdateId, bids: [["price","qty"], ...], asks: [["price","qty"], ...] }
 *
 * Bids are sorted descending (best bid first); asks ascending (best ask first).
 * The depth stream carries no server-side timestamp, so timestamp_exchange
 * equals timestamp_arrival.
 */
function normalizeBinance(msg, arrivalTs) {
  const { bids, asks } = msg;
  if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
    return null;
  }

  const bestBid = parseFloat(bids[0][0]);
  const bestAsk = parseFloat(asks[0][0]);

  let bidDepthSum = 0;
  for (const [p, q] of bids) bidDepthSum += parseFloat(p) * parseFloat(q);

  let askDepthSum = 0;
  for (const [p, q] of asks) askDepthSum += parseFloat(p) * parseFloat(q);

  return {
    symbol:             'BTCUSDT',
    price:              (bestBid + bestAsk) / 2,
    best_bid:           bestBid,
    best_ask:           bestAsk,
    bid_depth_sum:      bidDepthSum,
    ask_depth_sum:      askDepthSum,
    timestamp_exchange: arrivalTs, // No exchange timestamp in this stream
    timestamp_arrival:  arrivalTs,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POLYMARKET CLOB
// ═══════════════════════════════════════════════════════════════════════════

// ─── Live token ID registry ────────────────────────────────────────────────
//
// Seeded from the static env var; MarketDiscovery updates it on every poll.
// connectPolymarket() always reads THIS set when subscribing, so reconnects
// automatically pick up the latest market set without extra logic.
let activeTokenIds = new Set(config.polymarket.tokenIds);

function onMarketsUpdated(added, removed, all) {
  // Evict order book state for expired markets to free memory immediately.
  for (const id of removed) {
    orderBooks.delete(id);
    log.info({ tokenId: id }, 'Market expired — order book evicted');
  }

  // Atomically update the registry BEFORE sending subscribe, so any concurrent
  // reconnect that fires between the two lines sees the complete new set.
  activeTokenIds = all;

  // Hot-subscribe to new markets on the open WebSocket — no reconnect needed.
  if (added.size > 0 && polyWs?.readyState === WebSocket.OPEN) {
    polyWs.send(JSON.stringify({ type: 'subscribe', assets_ids: [...added] }));
    log.info({ count: added.size, ids: [...added] }, 'Hot-subscribed to new markets');
  }
  // If the WebSocket is not open, the pending reconnect will subscribe to
  // the full activeTokenIds set when it calls connectPolymarket().
}

// ─── Order book state ──────────────────────────────────────────────────────

// Local order book state, keyed by asset (outcome token) ID.
// Maintained as a mutable Map so incremental price_change events can be
// applied without a full snapshot on every tick.
const orderBooks = new Map(); // tokenId → { bids: Map<priceStr, qty>, asks: Map<priceStr, qty> }

// ─── Order book pruning ────────────────────────────────────────────────────
//
// Prediction market prices are bounded [0, 1]. In a volatile market a
// continuous stream of price_change events can grow each Map to thousands of
// entries that are economically irrelevant (far from the BBO). After every
// BBO computation we delete any level outside this window.
// 0.15 (15 cents) is wide enough to capture meaningful depth in a 15-minute
// market while keeping each Map bounded to a few dozen entries in practice.
const MAX_BOOK_SPREAD = 0.15;

function pruneBook(book, bestBid, bestAsk) {
  const bidFloor = bestBid - MAX_BOOK_SPREAD;
  const askCeil  = bestAsk + MAX_BOOK_SPREAD;

  for (const p of book.bids.keys()) {
    if (parseFloat(p) < bidFloor) book.bids.delete(p);
  }
  for (const p of book.asks.keys()) {
    if (parseFloat(p) > askCeil) book.asks.delete(p);
  }
}

let polyWs = null;
let polyPP = null;

function connectPolymarket() {
  log.info({ url: config.polymarket.wsUrl }, 'Connecting to Polymarket CLOB WebSocket');

  polyWs = new WebSocket(config.polymarket.wsUrl, {
    perMessageDeflate: false,
  });

  polyWs.once('open', () => {
    polyWs._socket?.setNoDelay(true);
    log.info('Polymarket CLOB WebSocket open');
    resetReconnectDelay('polymarket');

    if (activeTokenIds.size > 0) {
      // Subscribe to all currently known token IDs. This covers both the
      // initial static list and any IDs discovered before this connect fired.
      polyWs.send(JSON.stringify({ type: 'subscribe', assets_ids: [...activeTokenIds] }));
      log.info({ count: activeTokenIds.size }, 'Subscribed to active markets');
    } else {
      // No IDs yet — discovery will hot-subscribe via onMarketsUpdated once
      // the first Gamma API poll completes.
      log.info('No token IDs yet — awaiting first discovery poll');
    }

    polyPP = createPingPong(polyWs, 'polymarket');
    polyPP.start();
  });

  polyWs.on('message', (raw) => {
    const arrivalTs = nowNs();
    try {
      // Polymarket may batch multiple events in a single frame.
      const payload = JSON.parse(raw);
      const events  = Array.isArray(payload) ? payload : [payload];
      for (const event of events) {
        const record = normalizePolymarket(event, arrivalTs);
        if (record) port.postMessage(record);
      }
    } catch (err) {
      log.warn({ err }, 'Polymarket message parse error');
    }
  });

  polyWs.on('close', (code, reason) => {
    log.warn({ code, reason: reason.toString() }, 'Polymarket WS closed');
    polyPP?.stop();
    scheduleReconnect('polymarket', connectPolymarket);
  });

  polyWs.on('error', (err) => {
    log.error({ err }, 'Polymarket WS error');
    polyWs.terminate();
  });
}

/**
 * Apply a Polymarket CLOB event to the local order book and return a
 * normalized record.
 *
 * Supported event_type values:
 *   "book"         — Full snapshot; rebuilds the local order book.
 *   "price_change" — Incremental update applied to the existing book.
 *
 * All other event types (last_trade_price, tick_size_change, …) are ignored.
 */
function normalizePolymarket(event, arrivalTs) {
  const { event_type, asset_id } = event;
  if (!event_type || !asset_id) return null;

  if (event_type === 'book') {
    const book = { bids: new Map(), asks: new Map() };
    for (const { price, size } of event.bids ?? []) {
      const qty = parseFloat(size);
      if (qty > 0) book.bids.set(price, qty);
    }
    for (const { price, size } of event.asks ?? []) {
      const qty = parseFloat(size);
      if (qty > 0) book.asks.set(price, qty);
    }
    orderBooks.set(asset_id, book);
    return buildRecord(asset_id, book, event.timestamp, arrivalTs);
  }

  if (event_type === 'price_change') {
    const book = orderBooks.get(asset_id);
    if (!book) return null; // Missed the initial snapshot; wait for the next one

    for (const { price, side, size } of event.changes ?? []) {
      const map = side === 'BUY' ? book.bids : book.asks;
      const qty = parseFloat(size);
      if (qty === 0) map.delete(price);
      else           map.set(price, qty);
    }
    return buildRecord(asset_id, book, event.timestamp, arrivalTs);
  }

  return null;
}

function buildRecord(assetId, book, exchangeTsSecs, arrivalTs) {
  // Walk bids: find best (highest) price and accumulate notional depth.
  let bestBid    = 0;
  let bidDepth   = 0;
  for (const [p, qty] of book.bids) {
    const price = parseFloat(p);
    if (price > bestBid) bestBid = price;
    bidDepth += price * qty;
  }

  // Walk asks: find best (lowest) price and accumulate notional depth.
  let bestAsk  = 0;
  let askDepth = 0;
  let foundAsk = false;
  for (const [p, qty] of book.asks) {
    const price = parseFloat(p);
    if (!foundAsk || price < bestAsk) { bestAsk = price; foundAsk = true; }
    askDepth += price * qty;
  }

  if (!foundAsk) return null; // Empty ask side — unusable snapshot

  // Evict stale levels now that we have a fresh BBO. This is the right place
  // to prune because we've already finished iterating the Maps for this tick.
  pruneBook(book, bestBid, bestAsk);

  // Polymarket timestamps are Unix seconds (string). Convert to nanoseconds
  // using BigInt to avoid float precision loss at this magnitude.
  const tsExchange = parsePolyTimestampNs(exchangeTsSecs);

  return {
    // Use first 10 chars of the token ID as a stable, short symbol suffix.
    symbol:             `POLY_${assetId.slice(0, 10)}`,
    price:              (bestBid + bestAsk) / 2,
    best_bid:           bestBid,
    best_ask:           bestAsk,
    bid_depth_sum:      bidDepth,
    ask_depth_sum:      askDepth,
    timestamp_exchange: tsExchange,
    timestamp_arrival:  arrivalTs,
  };
}

/** Convert a Unix-seconds timestamp string to epoch nanoseconds (BigInt). */
function parsePolyTimestampNs(ts) {
  if (!ts) return 0n;
  // Drop any fractional seconds — Polymarket sends integer seconds.
  const secs = ts.toString().split('.')[0];
  return BigInt(secs) * 1_000_000_000n;
}

// ─── Heartbeat to orchestrator ─────────────────────────────────────────────

setInterval(() => {
  parentPort.postMessage({ type: 'heartbeat' });
}, config.watchdog.heartbeatIntervalMs);

// ─── Boot ──────────────────────────────────────────────────────────────────

connectBinance();

if (config.discovery.enabled) {
  // Connect the WebSocket first so it's ready to receive subscribe messages the
  // moment the first discovery poll returns (typically within a few seconds).
  connectPolymarket();

  const discovery = new MarketDiscovery({
    keywords:   config.discovery.keywords,
    intervalMs: config.discovery.intervalMs,
    onUpdate:   onMarketsUpdated,
  });

  // Await the first poll inline — if it succeeds we subscribe immediately on the
  // open WebSocket; if it fails we log the error and fall back to the static IDs.
  discovery.start().catch((err) => log.error({ err }, 'Initial market discovery failed'));
} else if (activeTokenIds.size > 0) {
  // Static mode: IDs come entirely from POLYMARKET_TOKEN_IDS in .env.
  connectPolymarket();
} else {
  log.warn('Auto-discovery disabled and POLYMARKET_TOKEN_IDS not set — Polymarket feed disabled');
}

parentPort.postMessage({ type: 'ready' });
