import type { AssetRecord } from './query.ts';

export interface AssetFingerprint {
    uuid: string;
    url: string;
    mtime: number | null;
    imported: boolean;
}

export function fingerprintOf(asset: AssetRecord): AssetFingerprint {
    return {
        uuid: asset.uuid,
        url: asset.url,
        mtime: typeof asset.mtime === 'number' ? asset.mtime : null,
        imported: asset.imported === true
    };
}

export interface DbSnapshot {
    assets: AssetFingerprint[];
    /** `null` means the scene did not answer, and there is nothing to compare the registered-class delta against. */
    classes: string[] | null;
}

/**
 * The order the database lists assets in is its own business and shifts by itself between two polls;
 * the key is sorted so a reshuffle does not read as an import still running.
 */
export function snapshotKey(snapshot: DbSnapshot): string {
    const assets = snapshot.assets
        .map(asset => `${asset.uuid}\t${asset.url}\t${asset.mtime ?? ''}\t${asset.imported ? '1' : '0'}`)
        .sort()
        .join('\n');
    const classes = snapshot.classes === null ? '?' : snapshot.classes.slice().sort().join(',');
    return `${assets}\n--\n${classes}`;
}

export interface Sample {
    key: string;
    ready: boolean;
    at: number;
}

/**
 * `refresh-asset` and `reimport-asset` answer before the import finishes, so their answer alone is
 * not enough — and neither is `query-ready` alone: between two phases of one import the database
 * reports itself ready. Settled means ready plus a fingerprint that held unchanged for `quietForMs`;
 * a not-ready sample breaks the quiet run rather than merely postponing the verdict.
 */
export function settled(samples: readonly Sample[], quietForMs: number): boolean {
    if (!samples.length) return false;
    const last = samples[samples.length - 1];
    if (!last.ready) return false;

    let runStart = last;
    for (let index = samples.length - 2; index >= 0; index--) {
        const sample = samples[index];
        if (sample.key !== last.key || !sample.ready) break;
        runStart = sample;
    }
    return last.at - runStart.at >= quietForMs;
}

export interface AssetDiff {
    added: string[];
    removed: string[];
    changed: string[];
}

export function assetDiffEmpty(diff: AssetDiff): boolean {
    return !diff.added.length && !diff.removed.length && !diff.changed.length;
}

/**
 * Compared by uuid rather than by url: a uuid survives a rename and a move, so such an asset is the
 * same one, changed, instead of a `removed` and an `added` pair.
 */
export function diffAssets(
    before: readonly AssetFingerprint[], after: readonly AssetFingerprint[]
): AssetDiff {
    const was = new Map(before.map(asset => [asset.uuid, asset]));
    const diff: AssetDiff = { added: [], removed: [], changed: [] };

    for (const asset of after) {
        const previous = was.get(asset.uuid);
        if (!previous) {
            diff.added.push(asset.url);
            continue;
        }
        was.delete(asset.uuid);
        if (previous.url !== asset.url || previous.mtime !== asset.mtime
            || previous.imported !== asset.imported) {
            diff.changed.push(asset.url);
        }
    }
    for (const asset of was.values()) diff.removed.push(asset.url);
    return diff;
}

export interface ClassDiff {
    added: string[];
    removed: string[];
}

/** `null` on either side means the question `did the class register` was never asked. */
export function diffClasses(
    before: readonly string[] | null, after: readonly string[] | null
): ClassDiff | null {
    if (before === null || after === null) return null;
    const was = new Set(before);
    const now = new Set(after);
    return {
        added: Array.from(new Set(after.filter(name => !was.has(name)))),
        removed: Array.from(new Set(before.filter(name => !now.has(name))))
    };
}

/**
 * What an asset-database operation did. There is no `persisted` here: an asset file is written at
 * once and outside the scene's undo stack, so a three-state field that is always inapplicable would
 * be a lie in the type. `landedAt` is what takes its place — under the default rename-on-conflict
 * the address an asset reaches is not always the one it was sent to.
 */
export interface AssetReport {
    /** What the editor was told to do, in the past tense: `refreshed`, `moved from db://…`. */
    action: string;
    /** The address the operation was aimed at. */
    target: string;
    /** Where the asset is now, asked of the database afterwards; `null` is at no address at all. */
    landedAt: string | null;
    settled: boolean;
    elapsedMs: number;
    assets: AssetDiff;
    classes: ClassDiff | null;
    /** The operation's own failure, apart from `did not go quiet`: what was promised did not happen. */
    failure?: string;
}

/**
 * Where a copy landed, read off what the database gained. Asking the target address instead would
 * answer with whatever asset already sat there: `copy-asset` renames on conflict by default,
 * checked live 2026-08-20 — `a.txt` onto a taken `b.txt` lands at `b-001.txt`. Only additions
 * carrying the target's own stem are considered, so an unrelated import finishing in the same
 * folder is not mistaken for the copy.
 */
export function copiedAddress(to: string, added: readonly string[]): string | null {
    if (added.includes(to)) return to;
    const dot = to.lastIndexOf('.');
    const stem = dot > to.lastIndexOf('/') ? to.slice(0, dot) : to;
    const renamed = added.filter(url => url.startsWith(`${stem}-`));
    return renamed.length
        ? renamed.reduce((shortest, url) => url.length < shortest.length ? url : shortest)
        : null;
}
