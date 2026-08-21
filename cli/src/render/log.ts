import { table } from './columns.ts';
import type { LogWindow, ProjectLogEntry } from '../log/entries.ts';
import type { LogFileInfo } from '../log/file.ts';
import type { LogSearchResult } from '../log/search.ts';

export function renderLogEntries(entries: readonly ProjectLogEntry[], detail: boolean): string {
    if (!entries.length) return 'nothing in the log matches this window';

    const rows = entries.map(entry => [
        String(entry.lineNumber),
        entry.time || '',
        entry.level,
        detail || !entry.detail ? entry.message : `${entry.message}  +${entry.detail.length} lines`
    ]);
    const lines: string[] = [];
    table(rows).forEach((line, index) => {
        lines.push(line);
        if (detail) lines.push(...(entries[index].detail || []).map(frame => `    ${frame.trim()}`));
    });
    return lines.join('\n');
}

function fileLine(file: LogFileInfo): string {
    return `${file.path}  ${file.size} bytes  modified ${file.modified}`;
}

function windowTail(window: LogWindow): string {
    return [
        window.level ? `level>=${window.level}` : '',
        window.since ? `since ${window.since}` : '',
        window.contains ? `containing '${window.contains}'` : ''
    ].filter(Boolean).join('  ');
}

export function logTailSummary(file: LogFileInfo, window: LogWindow, returned: number): string {
    return [
        fileLine(file),
        [
            `entries: ${returned} of ${window.entriesInWindow} in the window, `
            + `${window.entriesTotal} in the file`,
            windowTail(window)
        ].filter(Boolean).join('  ')
    ].join('\n');
}

export function renderLogMatches(result: LogSearchResult): string {
    if (!result.matches.length) return `no line matches ${JSON.stringify(result.pattern)}`;

    const groups = result.matches.map(match => table(
        match.context.map(line => [line.isMatch ? '>' : '', String(line.lineNumber), line.content])));
    return groups.map(group => group.join('\n')).join('\n\n');
}

export function logSearchSummary(
    file: LogFileInfo, window: LogWindow, result: LogSearchResult
): string {
    return [
        fileLine(file),
        [
            `matches: ${result.returned} of ${result.totalMatches}`,
            `pattern '${result.pattern}'`,
            result.regex ? 'regex' : '',
            result.caseSensitive ? 'case-sensitive' : '',
            windowTail(window),
            result.truncated ? `raise -n above ${result.maxResults} for the rest` : ''
        ].filter(Boolean).join('  ')
    ].join('\n');
}
