/**
 * main.js — Orchestrator
 *
 * Owns the lifecycle of the ingestion and database workers.
 *
 * Architecture:
 *   - A MessageChannel connects the two workers directly (zero-copy transfer).
 *     The ingestion worker writes to port1; the database worker reads from port2.
 *     The main thread never touches the data plane.
 *   - A watchdog timer polls worker heartbeats. Silence beyond the timeout
 *     triggers a full restart (both workers share a MessageChannel, so a crash
 *     in either side invalidates the channel).
 *   - SIGTERM / SIGINT trigger graceful shutdown: ingestion stops first (no
 *     new data), then the database worker is asked to flush, then terminated.
 */

import { Worker, MessageChannel } from 'worker_threads';
import { fileURLToPath }          from 'url';
import path                        from 'path';
import pino                        from 'pino';
import { config }                  from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const log = pino({
  name:  'orchestrator',
  level: process.env.LOG_LEVEL ?? 'info',
});

// ─── Worker state registry ─────────────────────────────────────────────────

const NAMES = /** @type {const} */ (['ingestion', 'database']);

const state = {
  ingestion: { worker: null, lastHeartbeat: 0, restarts: 0 },
  database:  { worker: null, lastHeartbeat: 0, restarts: 0 },
};

// ─── Flags ─────────────────────────────────────────────────────────────────

let isShuttingDown  = false;
let restartPending  = false;
let watchdogHandle  = null;

// ─── Worker creation ───────────────────────────────────────────────────────

function spawnWorkers() {
  // A fresh MessageChannel for this generation of workers.
  // port1 → ingestion worker (producer), port2 → database worker (consumer).
  const { port1, port2 } = new MessageChannel();

  // Database worker must be ready to receive before ingestion starts sending.
  spawnWorker('database',  'workers/database.worker.js',  port2);
  spawnWorker('ingestion', 'workers/ingestion.worker.js', port1);
}

function spawnWorker(name, relPath, port) {
  const workerPath = path.join(__dirname, relPath);

  const worker = new Worker(workerPath, {
    workerData:   { port },
    transferList: [port], // zero-copy ownership transfer
  });

  state[name].worker        = worker;
  state[name].lastHeartbeat = Date.now();

  worker.on('message', (msg) => onWorkerMessage(name, msg));
  worker.on('error',   (err) => log.error({ worker: name, err }, 'Worker runtime error'));
  worker.on('exit',    (code) => onWorkerExit(name, code));
}

// ─── Worker message handler ────────────────────────────────────────────────

function onWorkerMessage(name, msg) {
  switch (msg.type) {
    case 'heartbeat':
      state[name].lastHeartbeat = Date.now();
      break;
    case 'ready':
      log.info({ worker: name }, 'Worker ready');
      break;
    case 'shutdown_ack':
      log.info({ worker: name }, 'Worker acknowledged shutdown');
      break;
    default:
      log.warn({ worker: name, msg }, 'Unknown message from worker');
  }
}

// ─── Worker exit / restart ─────────────────────────────────────────────────

function onWorkerExit(name, code) {
  if (isShuttingDown)  return;
  if (restartPending)  return; // Another exit already scheduled the restart

  state[name].restarts += 1;
  restartPending = true;

  log.warn(
    { worker: name, code, totalRestarts: state[name].restarts },
    'Worker exited unexpectedly — restarting all workers in 2 s'
  );

  setTimeout(async () => {
    try {
      await restartAll();
    } finally {
      restartPending = false;
    }
  }, 2_000);
}

async function restartAll() {
  if (isShuttingDown) return;

  // Terminate whichever workers are still alive.
  for (const name of NAMES) {
    if (state[name].worker) {
      await state[name].worker.terminate().catch(() => {});
      state[name].worker = null;
    }
  }

  log.info('All workers terminated — spawning fresh generation');
  spawnWorkers();
}

// ─── Watchdog ─────────────────────────────────────────────────────────────

function startWatchdog() {
  watchdogHandle = setInterval(() => {
    if (isShuttingDown) return;

    const now = Date.now();
    for (const name of NAMES) {
      if (!state[name].worker) continue;

      const staleMs = now - state[name].lastHeartbeat;
      if (staleMs > config.watchdog.timeoutMs) {
        log.error(
          { worker: name, staleMs },
          'Heartbeat timeout — triggering restart'
        );
        // Mimic an exit so the existing restart logic handles it.
        if (!restartPending) onWorkerExit(name, 'watchdog-timeout');
        return;
      }
    }
  }, config.watchdog.heartbeatIntervalMs);
}

// ─── Graceful shutdown ─────────────────────────────────────────────────────

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, 'Graceful shutdown initiated');
  clearInterval(watchdogHandle);

  // 1. Kill ingestion — no more records will be produced.
  if (state.ingestion.worker) {
    await state.ingestion.worker.terminate().catch(() => {});
    state.ingestion.worker = null;
  }

  // 2. Tell the database worker to flush its in-memory buffer, then wait.
  if (state.database.worker) {
    state.database.worker.postMessage({ type: 'shutdown' });
    // 1.5 s is generous for a 250 ms flush cycle + QuestDB write RTT.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await state.database.worker.terminate().catch(() => {});
    state.database.worker = null;
  }

  log.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Boot ──────────────────────────────────────────────────────────────────

spawnWorkers();
startWatchdog();
log.info('Orchestrator running — workers spawned, watchdog active');
