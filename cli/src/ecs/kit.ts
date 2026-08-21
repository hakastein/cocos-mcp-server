import * as fs from 'fs';
import * as path from 'path';
import type { CensusSource } from './census.ts';

/**
 * The project's own asset tree: where a kit lives when the caller names none, and the only `db://`
 * mount that maps onto a directory without asking the editor.
 */
export const DEFAULT_KIT = 'db://assets';

/**
 * `library/` is the editor's imported copy of every script asset, so walking it counts each site a
 * second time; the rest hold no source of the project's own.
 */
const SKIPPED = new Set(['node_modules', 'library', 'temp', 'build', 'dist', '.git']);

export interface UnreadableFile {
    file: string;
    message: string;
}

export interface KitScan {
    sources: CensusSource[];
    unreadable: UnreadableFile[];
}

export function kitRoot(projectPath: string, kit: string = DEFAULT_KIT): string {
    if (!kit.startsWith('db://')) return path.resolve(kit);
    if (kit !== DEFAULT_KIT && !kit.startsWith(`${DEFAULT_KIT}/`)) {
        throw new Error(`only ${DEFAULT_KIT} resolves to a directory on disk here; `
            + `pass a path for '${kit}'`);
    }
    return path.join(projectPath, 'assets', ...kit.slice(DEFAULT_KIT.length).split('/').filter(Boolean));
}

/**
 * A shared kit is mounted into a project's `assets/` as a directory junction, and the editor imports
 * it as part of the project — so a walk that stops at the link sees none of the kit at all.
 */
function entryKind(full: string, entry: fs.Dirent): 'directory' | 'file' | null {
    if (entry.isDirectory()) return 'directory';
    if (entry.isFile()) return 'file';
    if (!entry.isSymbolicLink()) return null;
    try {
        const target = fs.statSync(full);
        return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : null;
    } catch {
        return null;
    }
}

export function readKit(root: string): KitScan {
    const sources: CensusSource[] = [];
    const unreadable: UnreadableFile[] = [];
    const walked = new Set<string>();

    const walk = (directory: string): void => {
        const real = fs.realpathSync(directory);
        if (walked.has(real)) return;
        walked.add(real);
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            const kind = entryKind(full, entry);
            if (kind === 'directory') {
                if (!SKIPPED.has(entry.name)) walk(full);
                continue;
            }
            if (kind !== 'file' || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
            const address = path.relative(root, full).split(path.sep).join('/');
            try {
                sources.push({ path: address, text: fs.readFileSync(full, 'utf8') });
            } catch (error) {
                unreadable.push({ file: address, message: error instanceof Error ? error.message : String(error) });
            }
        }
    };

    try {
        walk(root);
    } catch (error) {
        throw new Error(`could not sweep ${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { sources, unreadable };
}
