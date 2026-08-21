/**
 * `new RegExp(undefined)` is the empty pattern `/(?:)/`, which matches every line — so a search
 * that failed to supply one used to answer with the first N lines of the log as confident matches.
 * A blank pattern therefore throws here, matching is literal unless `regex` is asked for, and an
 * invalid regex throws rather than being re-read as literal text, which made a typo'd pattern look
 * like a legitimate zero-result search.
 *
 * `totalMatches` counts every match in the file; `maxResults` only bounds what is returned.
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

function buildPredicate(
    pattern: string, useRegex: boolean, caseSensitive: boolean
): (line: string) => boolean {
    if (useRegex) {
        let compiled: RegExp;
        try {
            // deliberately no /g: RegExp.test with /g advances lastIndex between calls and would
            // drop every other matching line
            compiled = new RegExp(pattern, caseSensitive ? '' : 'i');
        } catch (error) {
            throw new Error(
                `Invalid regular expression /${pattern}/: ${
                    error instanceof Error ? error.message : String(error)}. `
                + 'Drop --regex to search for this text literally.');
        }
        return line => compiled.test(line);
    }
    if (caseSensitive) return line => line.indexOf(pattern) !== -1;

    const needle = pattern.toLowerCase();
    return line => line.toLowerCase().indexOf(needle) !== -1;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(number)));
}

export function searchLines(
    lines: readonly string[], options: LogSearchOptions
): LogSearchResult {
    const pattern = typeof options.pattern === 'string' ? options.pattern.trim() : '';
    if (!pattern) {
        throw new Error("A non-empty 'pattern' is required — refusing to run a match-all search.");
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
        if (matches.length >= maxResults) continue;
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        matches.push({
            lineNumber: i + 1,
            matchedLine: lines[i],
            context: Array.from({ length: end - start + 1 }, (_, offset) => ({
                lineNumber: start + offset + 1,
                content: lines[start + offset],
                isMatch: start + offset === i
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
