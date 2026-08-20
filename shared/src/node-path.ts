/**
 * Addressing a node by its path in the scene instead of by uuid.
 *
 * A node uuid identifies an editor session, not a scene. Reloading the scene, refreshing the
 * asset database or recompiling scripts re-creates prefab-instance roots under fresh uuids
 * while ordinary nodes keep theirs, so a list captured by an earlier dump goes stale in
 * patches and nothing announces it. A path is a property of the scene and survives all three,
 * so a node argument is resolved against the open scene at the moment of the call.
 *
 * Two failures are errors here rather than empty results, because both were silent before:
 * a path matching nothing, and a path matching more than one node. Picking the first match
 * would put the write on whichever node the walk happened to reach first.
 *
 * Same-named siblings — crowds, bone rigs, repeated pads — are suffixed `#1`, `#2`, `#3` in
 * child order, and every member of the group carries a suffix. Leaving the first one bare, the
 * obvious spelling, is what made the first version of this resolve `Crowd/Gangster/Hat` to the
 * first gangster's hat without a word: that string is simultaneously the exact address of one
 * node and the ambiguous name of two, and exactness won. With the whole group suffixed no
 * address can collide with a bare name, so ambiguity is decidable rather than shadowed.
 *
 * A bare name is still accepted wherever exactly one node answers to it, which is the ordinary
 * case for almost every node in a scene.
 */

export interface PathIndexNode {
    name: string;
    uuid: string;
    children?: PathIndexNode[];
}

export interface PathIndex {
    /** canonical path (same-named siblings suffixed) -> uuid */
    canonical: Map<string, string>;
    /** name-only path -> every canonical path spelling it */
    plain: Map<string, string[]>;
    /** canonical path of a parent ('' at the root) -> its children's labels, in order */
    childLabels: Map<string, string[]>;
}

export interface PathResolved {
    uuid: string;
    /** The canonical spelling the path resolved through, echoed back so the caller sees the match. */
    matchedPath: string;
}

export type PathResolution = PathResolved | { error: string };

/** Strip the decoration a caller may reasonably type: surrounding blanks and slashes. */
export function normalizePath(path: string): string {
    return String(path).trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Address labels for one sibling list: a unique name stands alone, a repeated one carries its
 * 1-based position in child order on EVERY occurrence. The single rule behind every path the
 * CLI prints or accepts — `scene tree` and `scene owners` label with it too, so a path copied
 * out of a dump is a path the resolver takes.
 */
export function siblingLabels(children: Array<{ name: string } | null | undefined>): string[] {
    const total = new Map<string, number>();
    for (const child of children) {
        if (child) total.set(child.name, (total.get(child.name) || 0) + 1);
    }
    const seen = new Map<string, number>();
    return children.map(child => {
        if (!child) return '';
        const nth = (seen.get(child.name) || 0) + 1;
        seen.set(child.name, nth);
        return (total.get(child.name) || 0) > 1 ? `${child.name}#${nth}` : child.name;
    });
}

/**
 * Index a node tree by path. Both spellings are kept: the canonical one that disambiguates
 * same-named siblings, and the plain one a human writes, which is accepted whenever it is
 * unambiguous.
 */
export function buildPathIndex(root: PathIndexNode | { children?: PathIndexNode[] }): PathIndex {
    const index: PathIndex = { canonical: new Map(), plain: new Map(), childLabels: new Map() };

    const walk = (parent: { children?: PathIndexNode[] }, prefix: string, plainPrefix: string) => {
        const children = (parent.children || []).filter(Boolean) as PathIndexNode[];
        const labels = siblingLabels(children);
        children.forEach((child, i) => {
            const path = prefix ? `${prefix}/${labels[i]}` : labels[i];
            const plainPath = plainPrefix ? `${plainPrefix}/${child.name}` : child.name;
            index.canonical.set(path, child.uuid);
            const bucket = index.plain.get(plainPath);
            if (bucket) bucket.push(path); else index.plain.set(plainPath, [path]);
            walk(child, path, plainPath);
        });
        index.childLabels.set(prefix, labels);
    };
    walk(root, '', '');
    return index;
}

/**
 * Resolve one path against the index.
 *
 * An unresolvable path reports the deepest prefix that DOES exist and what sits under it, so
 * the caller sees the actual spelling rather than being told only that nothing matched — that
 * is the difference between a one-call correction and a scene-wide dump.
 */
export function resolvePathInIndex(index: PathIndex, rawPath: string): PathResolution {
    const path = normalizePath(rawPath);
    if (!path) return { error: `'${rawPath}' is an empty path` };

    const exact = index.canonical.get(path);
    if (exact !== undefined) return { uuid: exact, matchedPath: path };

    const spellings = index.plain.get(path) || [];
    if (spellings.length === 1) {
        return { uuid: index.canonical.get(spellings[0])!, matchedPath: spellings[0] };
    }
    if (spellings.length > 1) {
        return {
            error: `path '${path}' matches ${spellings.length} nodes: ${spellings.join(', ')}. `
                + 'Pass one of those exact spellings — every member of a same-named sibling group '
                + 'carries its position as #1, #2, #3 in child order.'
        };
    }

    return { error: notFoundMessage(index, path) };
}

function notFoundMessage(index: PathIndex, path: string): string {
    const segments = path.split('/');
    for (let depth = segments.length - 1; depth > 0; depth--) {
        const prefix = segments.slice(0, depth).join('/');
        const canonicalPrefix = index.canonical.has(prefix)
            ? prefix
            : ((index.plain.get(prefix) || []).length === 1 ? index.plain.get(prefix)![0] : null);
        if (!canonicalPrefix) continue;
        const children = index.childLabels.get(canonicalPrefix) || [];
        return `path '${path}' does not resolve. '${canonicalPrefix}' exists; ${describeChildren(children)}`;
    }
    const roots = index.childLabels.get('') || [];
    return `path '${path}' does not resolve — not even its first segment '${segments[0]}'. `
        + (roots.length ? `The scene roots are: ${listOf(roots)}.` : 'The scene has no root nodes.');
}

function describeChildren(labels: string[]): string {
    return labels.length ? `its children are: ${listOf(labels)}.` : 'it has no children.';
}

/** Enough names to recognise the one that was meant, without pasting a whole crowd back. */
function listOf(labels: string[]): string {
    const shown = labels.slice(0, 40);
    return `${shown.join(', ')}${labels.length > shown.length ? `, … (${labels.length} total)` : ''}`;
}
