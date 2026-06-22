export interface WaitForOpts<T> {
  timeoutMs?: number;
  intervalMs?: number;
  onTimeout?: () => string;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_INTERVAL_MS = 5;

export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  opts: WaitForOpts<T> = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined | null | false;
  while (Date.now() < deadline) {
    last = predicate();
    if (last) return last as T;
    await sleep(intervalMs);
  }
  const tail = opts.onTimeout ? `; ${opts.onTimeout()}` : "";
  throw new Error(`waitFor timed out after ${timeoutMs}ms${tail}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
