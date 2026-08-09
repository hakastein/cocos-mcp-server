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
