import type { SkeletalSocketList } from '@cocos-cli/shared';
import { columnWidth, padRight } from './columns.ts';

/**
 * A class the scene's engine knows. `path` and `assetUuid` come only from the Add Component menu;
 * the class registry answers a bare name, which is why every column but the first is optional.
 */
export interface ClassEntry {
    name: string;
    cid?: string;
    /** Where the Add Component menu puts it. */
    path?: string;
    /** The script asset the class was registered from. */
    assetUuid?: string;
}

/** The padding is trimmed off the end of each line: a registry listing has one column and is grepped. */
export function renderClassList(classes: readonly ClassEntry[]): string {
    if (!classes.length) return 'no class matched';
    const rows = classes.map(entry => [
        entry.name,
        entry.path || '',
        entry.cid && entry.cid !== entry.name ? entry.cid : ''
    ]);
    const widths = [0, 1].map(column => columnWidth(rows, column));
    return rows
        .map(row => `${padRight(row[0], widths[0])}  ${padRight(row[1], widths[1])}  ${row[2]}`.trimEnd())
        .join('\n');
}

/**
 * The base is what separates the two listings: with one, this is the class registry under it; with
 * none, it is what the editor offers to add, which is a shorter and differently chosen set.
 */
export function classListSummary(count: number, base?: string): string {
    return base === undefined
        ? `components offered: ${count}`
        : `classes extending ${base}: ${count}`;
}

/**
 * A socket is a `cc.SkeletalAnimation` entry, addressed through the node carrying that component.
 * The children of the target node are listed because they are the point of the socket — a weapon
 * parented under it is what the bone ends up carrying.
 */
export function renderSockets(list: SkeletalSocketList): string {
    if (!list.sockets.length) return 'no socket on this node';
    const rows = list.sockets.map(socket => [
        socket.path,
        socket.targetUuid ? `${socket.targetName || 'unnamed'}  ${socket.targetUuid}` : 'no target node',
        socket.targetChildren.length ? `  carries: ${socket.targetChildren.join(', ')}` : ''
    ]);
    const width = columnWidth(rows, 0);
    return rows.map(row => `${padRight(row[0], width)}  ${row[1]}${row[2]}`).join('\n');
}

export function socketsSummary(list: SkeletalSocketList): string {
    return `sockets: ${list.sockets.length}  useBakedAnimation=${list.useBakedAnimation}`;
}
