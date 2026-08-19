/**
 * Addressing a node by its path in the scene instead of by uuid.
 *
 * A node uuid identifies an editor session, not a scene. Reloading the scene, refreshing the
 * asset database or recompiling scripts re-creates prefab-instance roots under fresh uuids
 * while ordinary nodes keep theirs, so a list captured by an earlier `scene_dump` goes stale
 * in patches and nothing announces it. A path is a property of the scene and survives all
 * three, so every tool taking a node uuid also takes the matching path and resolves it at the
 * moment of the call.
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

/** Custom JSON-Schema keyword: the uuid/path parameter pairs a tool accepts. */
export const UUID_OR_PATH_KEY = 'x-uuid-or-path';

export interface UuidPathPair {
    /** The uuid parameter as the handler reads it. */
    uuid: string;
    /** The path parameter accepted in its place. */
    path: string;
    /** Both are arrays: each element resolves independently. */
    array: boolean;
    /** The uuid parameter was declared required before the path spelling was added. */
    required: boolean;
}

/**
 * Tools whose bare `uuid` parameter names a node in the open scene.
 *
 * `uuid` alone is spelled by three different kinds of tool — a node, an asset
 * (`query_asset_url`, `get_asset_details`) and a component (`reset_component`,
 * `execute_component_method`) — so unlike the unambiguous `nodeUuid` spelling it cannot be
 * paired everywhere it appears. These are the ones that mean a node.
 */
const BARE_UUID_NODE_TOOLS = new Set([
    'get_node_info', 'set_node_property', 'set_node_transform', 'delete_node',
    'duplicate_node',
    'reset_node_property', 'reset_node_transform', 'move_array_element', 'remove_array_element'
]);

/** Every uuid parameter across the tool surface that names a node in the open scene. */
const PAIR_SPELLINGS: Array<{ uuid: string; path: string; array: boolean; tools?: Set<string> }> = [
    { uuid: 'nodeUuid', path: 'nodePath', array: false },
    { uuid: 'targetUuid', path: 'targetPath', array: false },
    { uuid: 'parentUuid', path: 'parentPath', array: false },
    { uuid: 'newParentUuid', path: 'newParentPath', array: false },
    { uuid: 'rootUuid', path: 'rootPath', array: false },
    { uuid: 'targetUuids', path: 'targetPaths', array: true },
    { uuid: 'uuid', path: 'nodePath', array: false, tools: BARE_UUID_NODE_TOOLS }
];

const PATH_EXAMPLE = 'InteractivePoints/InteractionPad_01';

function pathDescription(uuidParam: string, array: boolean): string {
    const one = array
        ? `Scene paths to use instead of ${uuidParam}, e.g. ["${PATH_EXAMPLE}/interactive_frame_progressbar"].`
        : `Scene path to use instead of ${uuidParam}, e.g. "${PATH_EXAMPLE}".`;
    return `${one} Resolved against the open scene at call time, and WINS when ${uuidParam} is also `
        + 'given. A path matching no node, or matching several, is an error naming what was found. '
        + 'Same-named siblings are addressed with a #2 / #3 suffix, as printed by scene_dump.';
}

/**
 * A copy of the tool definition that also accepts paths. Adding the parameters here rather
 * than in each of the ~160 schemas keeps one spelling of the rule and covers tools added
 * later without anyone remembering to.
 *
 * The uuid parameter stops being `required`, because a caller supplying only the path has
 * supplied everything the tool needs; the pair is checked instead, after resolution, so
 * "neither spelling given" is still rejected before dispatch.
 */
export function augmentToolDefinition<T extends { name: string; description: string; inputSchema: any }>(def: T): T {
    const properties = (def.inputSchema && def.inputSchema.properties) || {};
    const required: string[] = Array.isArray(def.inputSchema && def.inputSchema.required)
        ? def.inputSchema.required
        : [];

    const pairs: UuidPathPair[] = [];
    for (const spelling of PAIR_SPELLINGS) {
        if (!(spelling.uuid in properties)) continue;
        if (spelling.path in properties) continue;   // a tool that already spells it out keeps its own
        if (spelling.tools && !spelling.tools.has(def.name)) continue;
        pairs.push({
            uuid: spelling.uuid, path: spelling.path, array: spelling.array,
            required: required.includes(spelling.uuid)
        });
    }
    if (!pairs.length) return def;

    const addedProperties: Record<string, any> = {};
    for (const pair of pairs) {
        addedProperties[pair.path] = pair.array
            ? { type: 'array', items: { type: 'string' }, description: pathDescription(pair.uuid, true) }
            : { type: 'string', description: pathDescription(pair.uuid, false) };
    }

    const spelled = pairs.map(p => `${p.path} for ${p.uuid}`).join(', ');
    return {
        ...def,
        description: `${def.description} Node arguments also accept a SCENE PATH instead of a uuid `
            + `(${spelled}) — resolved at call time, and preferred when both are given. Uuids go stale `
            + 'silently across scene reloads and script recompiles; paths do not.',
        inputSchema: {
            ...def.inputSchema,
            properties: { ...properties, ...addedProperties },
            required: required.filter(name => !pairs.some(p => p.uuid === name)),
            [UUID_OR_PATH_KEY]: pairs
        }
    };
}

/** The uuid/path pairs a (possibly augmented) schema declares. */
export function pairsOf(schema: any): UuidPathPair[] {
    const pairs = schema && schema[UUID_OR_PATH_KEY];
    return Array.isArray(pairs) ? pairs : [];
}

/** Every path spelling present in `args`, deduplicated, in the order the resolver should see them. */
export function requestedPaths(schema: any, args: Record<string, any>): string[] {
    const out: string[] = [];
    for (const pair of pairsOf(schema)) {
        const value = args[pair.path];
        if (value === undefined || value === null) continue;
        const list = pair.array ? (Array.isArray(value) ? value : [value]) : [value];
        for (const entry of list) {
            if (typeof entry === 'string' && entry.trim() && !out.includes(entry)) out.push(entry);
        }
    }
    return out;
}

export interface PathResolved {
    uuid: string;
    /** The canonical spelling the path resolved through, echoed back so the caller sees the match. */
    matchedPath: string;
}

export type PathResolution = PathResolved | { error: string };

export interface ApplyOk {
    ok: true;
    args: Record<string, any>;
    /** path -> canonical spelling, for echoing which node each argument landed on. */
    resolved: Array<{ parameter: string; path: string; uuid: string; matchedPath: string }>;
}

export interface ApplyError {
    ok: false;
    error: string;
}

/**
 * Write resolved uuids into the arguments, and reject a call that named neither spelling of a
 * parameter the tool cannot run without.
 *
 * Every failing path is reported at once. Resolving one argument, dispatching, and letting the
 * handler discover the second is how a half-applied edit gets made.
 */
export function applyResolvedPaths(
    toolName: string,
    schema: any,
    args: Record<string, any>,
    resolutions: Record<string, PathResolution>
): ApplyOk | ApplyError {
    const pairs = pairsOf(schema);
    if (!pairs.length) return { ok: true, args, resolved: [] };

    const out = { ...args };
    const resolved: ApplyOk['resolved'] = [];
    const errors: string[] = [];

    for (const pair of pairs) {
        const value = out[pair.path];
        if (value === undefined || value === null) continue;

        const list = pair.array ? (Array.isArray(value) ? value : [value]) : [value];
        const uuids: string[] = [];
        for (const entry of list) {
            if (typeof entry !== 'string' || !entry.trim()) {
                errors.push(`${pair.path}: '${String(entry)}' is not a path`);
                continue;
            }
            const resolution = resolutions[entry];
            if (!resolution) {
                errors.push(`${pair.path}: '${entry}' was not resolved`);
                continue;
            }
            if ('error' in resolution) {
                errors.push(`${pair.path}: ${resolution.error}`);
                continue;
            }
            uuids.push(resolution.uuid);
            resolved.push({ parameter: pair.path, path: entry, uuid: resolution.uuid, matchedPath: resolution.matchedPath });
        }
        if (errors.length) continue;
        // the path spelling wins outright: a caller who passed both meant the one that cannot go stale
        out[pair.uuid] = pair.array ? uuids : uuids[0];
        delete out[pair.path];
    }

    if (errors.length) {
        return { ok: false, error: `${toolName}: ${errors.join('; ')}` };
    }

    const unaddressed = pairs.filter(pair => pair.required && isBlank(out[pair.uuid]));
    if (unaddressed.length) {
        const spelled = unaddressed.map(p => `'${p.uuid}' or '${p.path}'`).join(', ');
        return { ok: false, error: `${toolName}: missing required argument(s) — pass ${spelled}.` };
    }

    return { ok: true, args: out, resolved };
}

function isBlank(value: any): boolean {
    if (value === undefined || value === null) return true;
    if (typeof value === 'string') return value.trim() === '';
    if (Array.isArray(value)) return value.length === 0;
    return false;
}

// ----- the tree side, shared with the scene script ------------------------------------

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

/** Strip the decoration a caller may reasonably type: surrounding blanks and slashes. */
export function normalizePath(path: string): string {
    return String(path).trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Address labels for one sibling list: a unique name stands alone, a repeated one carries its
 * 1-based position in child order on EVERY occurrence. The single rule behind every path this
 * bridge prints or accepts — `scene_dump` and `scene_find_component_owners` label with it too,
 * so a path copied out of a dump is a path the resolver takes.
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
