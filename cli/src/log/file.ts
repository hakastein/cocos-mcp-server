import * as fs from 'fs';
import * as path from 'path';

export interface LogFileInfo {
    path: string;
    size: number;
    /** ISO-8601, so a log that stopped being written is distinguishable from one with nothing to say. */
    modified: string;
    totalLines: number;
}

export interface ProjectLogFile extends LogFileInfo {
    lines: string[];
}

export function projectLogPath(projectPath: string): string {
    return path.join(projectPath, 'temp', 'logs', 'project.log');
}

/**
 * The editor writes the log with CRLF on Windows. A carriage return left on the end of every line
 * reaches `--json` verbatim and makes a `$`-anchored `--regex` search match nothing.
 */
export function splitLogLines(text: string): string[] {
    return text.split(/\r?\n/);
}

export function readProjectLog(projectPath: string): ProjectLogFile {
    const file = projectLogPath(projectPath);
    let stats: fs.Stats;
    let text: string;
    try {
        stats = fs.statSync(file);
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        throw new Error(
            `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lines = splitLogLines(text);
    return {
        path: file,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        totalLines: lines.length,
        lines
    };
}
