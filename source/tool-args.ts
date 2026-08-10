export const ALIAS_KEY = 'x-aliases';

/** Levenshtein distance, used only to suggest a rename in an error message. */
function distance(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[n];
}

/** Split camelCase / snake_case into lowercase words: assetUri -> ['asset', 'uri']. */
function tokens(name: string): string[] {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
        .filter(Boolean).map(t => t.toLowerCase());
}

export function closestSpelling(name: string, candidates: string[]): string | undefined {
    const lower = name.toLowerCase();
    const nameTokens = tokens(name);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const c of candidates) {
        const cl = c.toLowerCase();
        let score: number;
        if (cl.includes(lower) || lower.includes(cl)) {
            score = 1;
        } else {
            // best single-word match against the candidate as a whole
            const tokenScore = Math.min(...nameTokens.map(t => distance(t, cl)), Infinity);
            score = Math.min(distance(lower, cl), tokenScore + 1);
        }
        if (score < bestScore) { bestScore = score; best = c; }
    }
    // allow roughly a third of the name to differ before the suggestion becomes noise
    return bestScore <= Math.max(2, Math.ceil(name.length / 3)) ? best : undefined;
}
