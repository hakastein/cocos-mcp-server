/**
 * The five words an outcome line starts with, and what each becomes in the exit code. The set is
 * closed on purpose: a report kind that names no word from here does not compile — before this,
 * first words were spread over eight files and declared nowhere.
 */
export type Verdict = 'ok' | 'UNVERIFIED' | 'UNPERSISTED' | 'FAILED' | 'TIMEOUT';

/**
 * `UNVERIFIED` exits zero: it was done and the read-back did not confirm it, and a `&&` chain is
 * not broken on that.
 */
export function verdictFailed(verdict: Verdict): boolean {
    return verdict === 'UNPERSISTED' || verdict === 'FAILED' || verdict === 'TIMEOUT';
}
