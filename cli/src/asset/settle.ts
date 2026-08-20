import type { AssetRecord } from './query';

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
    /** `null` — сцена не ответила, и дельту зарегистрированных классов сравнивать не с чем. */
    classes: string[] | null;
}

/**
 * Порядок, в котором база перечисляет ассеты, её собственное дело и между двумя опросами меняется
 * сам по себе; ключ сортируется, чтобы перестановка не читалась как продолжающийся импорт.
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
 * `refresh-asset` и `reimport-asset` отвечают до того, как импорт закончится, поэтому одного их
 * ответа мало, а одного `query-ready` мало тоже: между двумя фазами импорта база успевает отчитаться
 * готовой. Улеглось — это готовность плюс неизменный отпечаток, продержавшийся `quietForMs`;
 * не-готовая проба рвёт полосу тишины, а не просто откладывает вердикт.
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
 * Сравнение по uuid, а не по url: переименование и перенос uuid переживают, и такой ассет — тот же
 * самый, изменившийся, а не пара «удалён и добавлен».
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

/** `null` с любой стороны — вопрос «зарегистрировался ли класс» остался незаданным. */
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
