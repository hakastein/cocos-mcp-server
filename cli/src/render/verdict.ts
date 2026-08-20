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

/**
 * Severity, so one bracket that carried several writes leads with the worst of them: a reader takes
 * the head word from the first line, and `ok` there over an `UNPERSISTED` further down is the
 * defect this ordering exists to stop.
 */
const SEVERITY: Record<Verdict, number> = {
    ok: 0, UNVERIFIED: 1, UNPERSISTED: 2, TIMEOUT: 3, FAILED: 4
};

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
    return verdicts.reduce<Verdict>(
        (worst, verdict) => SEVERITY[verdict] > SEVERITY[worst] ? verdict : worst, 'ok');
}
