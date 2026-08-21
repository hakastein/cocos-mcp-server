/**
 * Comparing a scene's serialized form against the file that holds it.
 *
 * The editor's dirty flag counts undo steps, not file contents: it stays set once a write has been
 * undone by writing the old value back, and a write the undo bracket did not carry never moves it.
 * Diffing what the save path would emit against what the file already holds does not depend on how
 * the change was made.
 */

export interface SerializedDiff {
    path: string;
    live: string;
    disk: string;
}

/**
 * The SceneAsset's `_name`, which the serializer leaves empty and the asset database fills in from
 * the filename on import. It is the only entry that differs between a freshly serialized scene and
 * the file that scene was just saved to, so it is the only one ignored.
 */
export const BENIGN_DIFF_PATHS = ['.0._name'];

/**
 * Every place two serialized scenes disagree, as dotted paths into the entry array. Capped at
 * `limit` so a wholesale mismatch reports its first findings instead of building a megabyte of
 * report; the caller only needs to know THAT they differ and roughly where.
 */
export function diffSerialized(
    live: any,
    disk: any,
    ignoredPaths: string[] = BENIGN_DIFF_PATHS,
    limit = 20
): SerializedDiff[] {
    const diffs: SerializedDiff[] = [];

    const brief = (value: any): string => {
        const text = JSON.stringify(value);
        return text === undefined ? 'undefined' : text.slice(0, 120);
    };

    const walk = (a: any, b: any, path: string): void => {
        if (diffs.length >= limit || a === b || ignoredPaths.indexOf(path) !== -1) return;
        const liveType = a === null ? 'null' : typeof a;
        const diskType = b === null ? 'null' : typeof b;
        if (liveType !== diskType || liveType !== 'object') {
            diffs.push({ path, live: brief(a), disk: brief(b) });
            return;
        }
        const keys = new Set(Object.keys(a).concat(Object.keys(b)));
        keys.forEach((key) => walk(a[key], b[key], `${path}.${key}`));
    };

    walk(live, disk, '');
    return diffs;
}
