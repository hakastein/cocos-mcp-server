/**
 * Line search over project.log, kept free of `fs` and the editor globals so it can be
 * tested directly.
 *
 * The previous implementation compiled the caller's pattern with `new RegExp(pattern, 'gi')`
 * and fell back to an escaped literal only when that *threw*. An absent pattern does not
 * throw — `new RegExp(undefined)` is the empty pattern `/(?:)/`, which matches every line —
 * so a call that failed to supply a pattern returned the first N lines of the log as
 * confident matches. Two consequences are designed out here:
 *
 *   - a blank pattern is an error, never a match-all;
 *   - matching is literal by default, so `a.b` finds `a.b`. Regex is opt-in, and an invalid
 *     one is reported instead of being quietly re-read as literal text, which used to make
 *     a typo'd pattern look like a legitimate zero-result search.
 *
 * `totalMatches` counts every match in the file; `maxResults` only bounds what is returned.
 * Reporting the capped count as the total made a truncated search indistinguishable from a
 * complete one.
 */

export interface LogSearchOptions {
    pattern?: string | null;
    maxResults?: number;
    contextLines?: number;
    regex?: boolean;
    caseSensitive?: boolean;
}

export interface LogSearchContextLine {
    lineNumber: number;
    content: string;
    isMatch: boolean;
}

export interface LogSearchMatch {
    lineNumber: number;
    matchedLine: string;
    context: LogSearchContextLine[];
}

export interface LogSearchResult {
    pattern: string;
    regex: boolean;
    caseSensitive: boolean;
    /** Every matching line in the file, not just the returned ones. */
    totalMatches: number;
    returned: number;
    truncated: boolean;
    maxResults: number;
    contextLines: number;
    matches: LogSearchMatch[];
}

/** Predicate for one line, built once per search. */
function buildPredicate(pattern: string, useRegex: boolean, caseSensitive: boolean): (line: string) => boolean {
    if (useRegex) {
        let re: RegExp;
        try {
            // deliberately no /g: RegExp.test with /g advances lastIndex between calls and
            // would drop every other matching line
            re = new RegExp(pattern, caseSensitive ? '' : 'i');
        } catch (err: any) {
            throw new Error(`Invalid regular expression /${pattern}/: ${err.message}. `
                + 'Omit regex:true to search for this text literally.');
        }
        return (line: string) => re.test(line);
    }
    if (caseSensitive) {
        return (line: string) => line.indexOf(pattern) !== -1;
    }
    const needle = pattern.toLowerCase();
    return (line: string) => line.toLowerCase().indexOf(needle) !== -1;
}

function clampInt(value: any, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}

export function searchLines(lines: string[], options: LogSearchOptions): LogSearchResult {
    const pattern = typeof options.pattern === 'string' ? options.pattern.trim() : '';
    if (!pattern) {
        throw new Error("A non-empty 'pattern' is required — refusing to run a match-all search. "
            + "Pass the text to look for, e.g. { pattern: '_sealed' }.");
    }

    const maxResults = clampInt(options.maxResults, 20, 1, 1000);
    const contextLines = clampInt(options.contextLines, 2, 0, 10);
    const useRegex = options.regex === true;
    const caseSensitive = options.caseSensitive === true;

    const isMatch = buildPredicate(pattern, useRegex, caseSensitive);

    const matches: LogSearchMatch[] = [];
    let totalMatches = 0;

    for (let i = 0; i < lines.length; i++) {
        if (!isMatch(lines[i])) continue;
        totalMatches++;
        if (matches.length >= maxResults) continue;   // keep counting, stop collecting
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
            lineNumber: i + 1,
            matchedLine: lines[i],
            context: Array.from({ length: end - start + 1 }, (_, j) => ({
                lineNumber: start + j + 1,
                content: lines[start + j],
                isMatch: start + j === i
            }))
        });
    }

    return {
        pattern,
        regex: useRegex,
        caseSensitive,
        totalMatches,
        returned: matches.length,
        truncated: totalMatches > matches.length,
        maxResults,
        contextLines,
        matches
    };
}
