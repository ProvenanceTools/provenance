/**
 * A small `worker_threads` pool that offloads the expensive half of bundle
 * rebuilding — the JSZip serialization (`zipBundleEntries`) — off the ingest
 * staging main thread and across CPU cores.
 *
 * Why this exists: staging a large Gradescope export is single-threaded and its
 * per-bundle cost is dominated (~80%) by the pure-JS JSZip STORE serialization
 * running on the one staging worker's event loop, so throughput was capped at
 * one core no matter how many worker replicas or how much I/O concurrency we
 * added. The cheap selection (`selectBundleEntries`) stays on the producer; only
 * the CPU-heavy zip is farmed out here, so N bundles serialize in parallel.
 *
 * The worker is an **eval string**, not a separate module file, on purpose: the
 * server runs under `tsx` in dev and is bundled by esbuild into a single
 * `dist/index.js` in prod — a sibling worker file survives neither cleanly. The
 * string has no project-local or TypeScript imports; it dynamic-imports `jszip`
 * (an external dependency present in both dev and prod) and runs the identical
 * `new JSZip(); file(...); generateAsync({type:'arraybuffer'})` steps as
 * `zipBundleEntries`, so its output is byte-identical — the archive sha256 (the
 * Gradescope dedup key) is unchanged. `rebuild-pool.test.ts` pins that equality.
 *
 * Lifecycle: `createRebuildPool(size)` spawns `size` workers immediately;
 * `dispose()` terminates them all and rejects anything still queued. Callers
 * MUST `dispose()` (staging does so in a `finally`) — there is no implicit
 * shutdown.
 */

import { Worker } from 'node:worker_threads';
import type { BundleEntry } from '@provenance/analysis-core/scopes/select-entries.js';

// The worker body. Plain JS (no TS, no project imports). One request → one
// response; the parent serializes requests per worker (one in flight at a time).
const WORKER_SRC = `
import { parentPort } from 'node:worker_threads';
let JSZipMod;
parentPort.on('message', async (entries) => {
  try {
    if (JSZipMod === undefined) JSZipMod = (await import('jszip')).default;
    const zip = new JSZipMod();
    for (const e of entries) zip.file(e.name, e.data);
    const data = await zip.generateAsync({ type: 'arraybuffer' });
    parentPort.postMessage({ ok: true, data }, [data]);
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
`;

interface PendingTask {
  entries: BundleEntry[];
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  /** The task currently in flight on this worker, or null when idle. */
  current: PendingTask | null;
}

export interface RebuildPool {
  /**
   * Serialize `entries` into a flat STORE bundle ZIP on a worker thread.
   * Byte-identical to `zipBundleEntries(entries)`. Rejects if the pool is
   * disposed or the worker fails.
   */
  zip(entries: BundleEntry[]): Promise<Uint8Array>;
  /** Terminate all workers and reject any queued/in-flight tasks. */
  dispose(): Promise<void>;
}

export function createRebuildPool(size: number): RebuildPool {
  const poolSize = Math.max(1, Math.floor(size));
  const queue: PendingTask[] = [];
  const workers: PoolWorker[] = [];
  let disposed = false;

  const failInFlight = (pw: PoolWorker, err: Error): void => {
    if (pw.current !== null) {
      const task = pw.current;
      pw.current = null;
      task.reject(err);
    }
  };

  const pump = (pw: PoolWorker): void => {
    if (pw.current !== null) return; // busy
    const next = queue.shift();
    if (next === undefined) return; // nothing waiting
    pw.current = next;
    // Structured-clone the entries to the worker (correctness over zero-copy:
    // the source buffers may alias larger allocations). The result ArrayBuffer
    // is transferred back.
    pw.worker.postMessage(next.entries);
  };

  const pumpAny = (): void => {
    for (const pw of workers) {
      if (queue.length === 0) break;
      pump(pw);
    }
  };

  for (let i = 0; i < poolSize; i++) {
    const worker = new Worker(WORKER_SRC, { eval: true });
    const pw: PoolWorker = { worker, current: null };
    worker.on('message', (msg: { ok: true; data: ArrayBuffer } | { ok: false; error: string }) => {
      const task = pw.current;
      pw.current = null;
      if (task !== undefined && task !== null) {
        if (msg.ok) task.resolve(new Uint8Array(msg.data));
        else task.reject(new Error(`rebuild worker failed: ${msg.error}`));
      }
      pump(pw);
    });
    worker.on('error', (err) => failInFlight(pw, err));
    worker.on('exit', (code) => {
      if (!disposed && code !== 0) {
        failInFlight(pw, new Error(`rebuild worker exited with code ${code}`));
      }
    });
    workers.push(pw);
  }

  return {
    zip(entries) {
      return new Promise<Uint8Array>((resolve, reject) => {
        if (disposed) {
          reject(new Error('rebuild pool disposed'));
          return;
        }
        queue.push({ entries, resolve, reject });
        pumpAny();
      });
    },
    async dispose() {
      disposed = true;
      const err = new Error('rebuild pool disposed');
      for (const task of queue.splice(0)) task.reject(err);
      for (const pw of workers) failInFlight(pw, err);
      await Promise.all(workers.map((pw) => pw.worker.terminate()));
    },
  };
}
