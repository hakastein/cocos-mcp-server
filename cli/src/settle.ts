import pWaitFor from 'p-wait-for';

export async function settle(
    predicate: () => Promise<boolean> | boolean,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
    try {
        await pWaitFor(predicate, { timeout: opts.timeoutMs ?? 2000, interval: opts.intervalMs ?? 50 });
        return true;
    } catch {
        return false;
    }
}

/**
 * `promise` if it settles inside `timeoutMs`, the `timedOut` marker if it does not. The promise
 * itself is left running rather than cancelled — the editor keeps building past a caller who
 * stopped waiting — so its later rejection is swallowed instead of reaching the process unhandled.
 */
export function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timed out'> {
    let timer: NodeJS.Timeout;
    const cleared = promise.finally(() => clearTimeout(timer));
    cleared.catch(() => { });
    return Promise.race([
        cleared,
        new Promise<'timed out'>(resolve => { timer = setTimeout(() => resolve('timed out'), timeoutMs); })
    ]);
}
