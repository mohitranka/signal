export class AbortedError extends Error {
  constructor() {
    super('aborted');
  }
}

interface Entry<T = unknown> {
  key: string;
  task: (signal: AbortSignal) => Promise<T>;
  ctrl: AbortController;
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  started: boolean;
  /** Callers currently waiting for this request (deduplicated run() calls for the same key). */
  waiters: number;
}

/** FIFO queue with bounded concurrency, in-flight deduplication by key, per-key release, and cancel-all. */
export class TaskQueue {
  private pending: Entry[] = [];
  private byKey = new Map<string, Entry>();
  private running = 0;

  constructor(private concurrency = 3) {}

  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, n);
    this.pump();
  }

  get size(): number {
    return this.byKey.size;
  }

  run<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.byKey.get(key);
    if (existing) {
      existing.waiters++;
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry<T> = { key, task, ctrl: new AbortController(), promise, resolve, reject, started: false, waiters: 1 };
    this.byKey.set(key, entry as Entry);
    this.pending.push(entry as Entry);
    this.pump();
    return promise;
  }

  /**
   * One waiter no longer needs this request (e.g. the post's text grew). Only when nobody else waits for it is the
   * request dropped (if still queued: it is never started) or aborted (if in flight). Unknown keys are ignored.
   */
  release(key: string): void {
    const e = this.byKey.get(key);
    if (!e || --e.waiters > 0) return;
    if (!e.started) {
      this.pending = this.pending.filter((x) => x !== e);
      this.byKey.delete(key);
      e.reject(new AbortedError());
    } else {
      e.ctrl.abort();
    }
  }

  /** Reject everything queued and abort everything in flight (stale after navigation or settings change). */
  cancelAll(): void {
    const queued = this.pending;
    this.pending = [];
    for (const e of queued) {
      this.byKey.delete(e.key);
      e.reject(new AbortedError());
    }
    for (const e of this.byKey.values()) e.ctrl.abort();
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length > 0) {
      const e = this.pending.shift()!;
      e.started = true;
      this.running++;
      e.task(e.ctrl.signal)
        .then(e.resolve, e.reject)
        .finally(() => {
          this.running--;
          if (this.byKey.get(e.key) === e) this.byKey.delete(e.key);
          this.pump();
        });
    }
  }
}
