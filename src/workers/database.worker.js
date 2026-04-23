/**
 * database.worker.js — The Memory
 *
 * Receives normalized market records from ingestion.worker.js over the shared
 * MessageChannel port and persists them to QuestDB using the InfluxDB Line
 * Protocol (ILP) over a raw TCP socket.
 *
 * Buffer strategy — High-Water Mark:
 *   Records accumulate in an in-memory array. A flush is triggered when either:
 *     a) the periodic timer fires every 250 ms, or
 *     b) the buffer reaches 1,000 records (whichever comes first).
 *   If the QuestDB socket is unavailable, data stays in the buffer and the
 *   connection is retried with exponential backoff (1 s → 32 s).
 *
 * QuestDB schema (auto-created via ILP on first write):
 *
 *   CREATE TABLE market_data (
 *     symbol        SYMBOL,               -- indexed tag
 *     price         DOUBLE,
 *     best_bid      DOUBLE,
 *     best_ask      DOUBLE,
 *     bid_depth_sum DOUBLE,
 *     ask_depth_sum DOUBLE,
 *     ts_exchange   LONG,                 -- exchange nanosecond timestamp
 *     timestamp     TIMESTAMP             -- designated timestamp (arrival ns)
 *   ) timestamp(timestamp) PARTITION BY DAY;
 */

import { workerData, parentPort } from 'worker_threads';
import net                         from 'net';
import pino                        from 'pino';
import { config }                  from '../config.js';

const log = pino({ name: 'database', level: process.env.LOG_LEVEL ?? 'info' });

// Data arrives from the ingestion worker via this port.
const { port } = workerData;

// ─── In-memory buffer ──────────────────────────────────────────────────────

const buffer = [];

// Hard cap to prevent unbounded memory growth during a prolonged QuestDB outage.
const MAX_BUFFER = 100_000;

// ─── QuestDB TCP socket ────────────────────────────────────────────────────

let socket           = null;
let socketReady      = false;
let reconnectDelay   = 1_000;
const MAX_RECONNECT  = 32_000;

function connectQuestDB() {
  socket = new net.Socket();

  // Disable Nagle — we write in bulk batches and don't want extra latency.
  socket.setNoDelay(true);
  // Detect dead connections without application-level ping traffic.
  socket.setKeepAlive(true, 5_000);

  socket.connect(config.questdb.ilpPort, config.questdb.host, () => {
    log.info(
      { host: config.questdb.host, port: config.questdb.ilpPort },
      'QuestDB ILP socket connected'
    );
    socketReady    = true;
    reconnectDelay = 1_000;
    flush(); // Drain anything that buffered while we were disconnected.
  });

  socket.on('error', (err) => {
    log.error({ err }, 'QuestDB socket error');
    socketReady = false;
    // 'close' will fire after 'error'; the reconnect is handled there.
  });

  socket.on('close', () => {
    socketReady = false;
    log.warn({ nextRetryMs: reconnectDelay }, 'QuestDB socket closed — reconnecting');
    setTimeout(connectQuestDB, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
  });
}

// ─── ILP serialization ─────────────────────────────────────────────────────
//
// ILP wire format (one record per line, LF-terminated):
//
//   measurement,tag_key=tag_value field_key=value,... timestamp_ns\n
//
// Rules applied here:
//   - SYMBOL column is mapped to an ILP tag (indexed, stored as enum-like).
//   - Floating-point fields have no suffix (QuestDB infers DOUBLE).
//   - Integer fields (ts_exchange) carry the "i" suffix.
//   - The trailing timestamp is the epoch-nanosecond arrival time and becomes
//     the table's designated TIMESTAMP column.

function toILP(record) {
  const {
    symbol,
    price,
    best_bid,
    best_ask,
    bid_depth_sum,
    ask_depth_sum,
    timestamp_exchange,
    timestamp_arrival,
  } = record;

  // BigInt is preserved across Worker postMessage (structured clone).
  const tsArrival  = BigInt(timestamp_arrival);
  const tsExchange = BigInt(timestamp_exchange);

  // Reject NaN / Infinity to avoid emitting a malformed ILP line.
  if (!Number.isFinite(price) || !Number.isFinite(best_bid) || !Number.isFinite(best_ask)) {
    throw new TypeError(`Non-finite numeric field in record for symbol=${symbol}`);
  }

  return (
    `market_data,symbol=${symbol} ` +
    `price=${price},` +
    `best_bid=${best_bid},` +
    `best_ask=${best_ask},` +
    `bid_depth_sum=${bid_depth_sum},` +
    `ask_depth_sum=${ask_depth_sum},` +
    `ts_exchange=${tsExchange}i ` +
    `${tsArrival}\n`
  );
}

// ─── Flush ─────────────────────────────────────────────────────────────────

function flush() {
  if (buffer.length === 0 || !socketReady) return;

  // Drain the entire buffer in one shot.
  const records = buffer.splice(0, buffer.length);

  let payload = '';
  let skipped = 0;
  for (const r of records) {
    try {
      payload += toILP(r);
    } catch (err) {
      skipped += 1;
      log.warn({ err, symbol: r.symbol }, 'Skipping malformed record');
    }
  }

  if (!payload) return;

  socket.write(payload, 'utf8', (err) => {
    if (err) {
      log.error({ err, count: records.length }, 'Write failed — re-buffering records');
      // Reinsert at the front to preserve temporal ordering.
      if (buffer.length + records.length <= MAX_BUFFER) {
        buffer.splice(0, 0, ...records);
      } else {
        log.warn({ dropped: records.length }, 'Buffer at capacity — records dropped');
      }
    } else {
      log.debug({ written: records.length - skipped, skipped }, 'Flushed to QuestDB');
    }
  });
}

// ─── Incoming data ─────────────────────────────────────────────────────────

port.on('message', (record) => {
  if (buffer.length >= MAX_BUFFER) {
    log.warn({ symbol: record.symbol }, 'Buffer full — dropping record');
    return;
  }
  buffer.push(record);

  // High-water mark: don't wait for the timer if we're accumulating fast.
  if (buffer.length >= config.buffer.highWaterMark) flush();
});

// ─── Interval flush ────────────────────────────────────────────────────────

const flushTimer = setInterval(flush, config.buffer.flushIntervalMs);

// ─── Orchestrator commands ─────────────────────────────────────────────────

parentPort.on('message', (msg) => {
  if (msg.type !== 'shutdown') return;

  log.info({ remaining: buffer.length }, 'Shutdown received — flushing final buffer');
  clearInterval(flushTimer);

  // Issue the final flush synchronously; give the socket write time to land.
  flush();
  setTimeout(() => {
    parentPort.postMessage({ type: 'shutdown_ack' });
  }, 500);
});

// ─── Heartbeat to orchestrator ─────────────────────────────────────────────

setInterval(() => {
  parentPort.postMessage({ type: 'heartbeat' });
}, config.watchdog.heartbeatIntervalMs);

// ─── Boot ──────────────────────────────────────────────────────────────────

connectQuestDB();
parentPort.postMessage({ type: 'ready' });
