const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface NodeSelector {
    nodeName?: string;
    nodePath?: string;
    nodeId?: number;
}

/** The shape compressUuid produces: the uuid's first 5 hex chars verbatim, then 9 base64 pairs. */
export const PACKED_CID = /^[0-9a-f]{5}[0-9a-zA-Z+/]{18}$/;

/** Component `__type__` for a user script is its script-asset uuid packed to 23 chars (5 hex + 9 hex-triples). */
export function compressUuid(uuid: string): string {
    const hex = uuid.replace(/-/g, '');
    if (hex.length !== 32) throw new Error(`Not a 32-hex uuid: ${uuid}`);
    let out = hex.slice(0, 5);
    for (let i = 5; i < 32; i += 3) {
        const h0 = parseInt(hex[i], 16);
        const h1 = parseInt(hex[i + 1], 16);
        const h2 = parseInt(hex[i + 2], 16);
        out += BASE64[(h0 << 2) | (h1 >> 2)] + BASE64[((h1 & 3) << 4) | h2];
    }
    return out;
}

const BASE64_VALUES: Record<string, number> = {};
for (let i = 0; i < BASE64.length; i++) BASE64_VALUES[BASE64[i]] = i;

/** Inverse of compressUuid: 23-char class id back to a dashed uuid. */
export function decompressUuid(cid: string): string {
    if (cid.length !== 23) return cid;
    let hex = cid.slice(0, 5);
    for (let i = 5; i < 23; i += 2) {
        const lhs = BASE64_VALUES[cid[i]];
        const rhs = BASE64_VALUES[cid[i + 1]];
        if (lhs === undefined || rhs === undefined) return cid;
        hex += (lhs >> 2).toString(16) + ((((lhs & 3) << 2) | (rhs >> 4)) & 15).toString(16) + (rhs & 15).toString(16);
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface PrefabDumpNode {
    path: string;
    name: string;
    active: boolean;
    id: number;
    components: { type: string; scriptUuid: string | null; fileId: string | null; id: number }[];
}

/** The node/component tree of a .prefab asset, so callers never hand-walk the entry array. */
export function dumpPrefabTree(data: any[]): PrefabDumpNode[] {
    const out: PrefabDumpNode[] = [];
    const walk = (id: number, prefix: string) => {
        const node = data[id];
        if (!isNode(node)) return;
        const path = prefix ? `${prefix}/${node._name}` : node._name;
        out.push({
            path,
            name: node._name,
            active: node._active !== false,
            id,
            components: (node._components || []).map((ref: any) => {
                const comp = data[ref && ref.__id__];
                const type = comp ? comp.__type__ : 'missing';
                const info = comp && comp.__prefab && data[comp.__prefab.__id__];
                return {
                    type,
                    scriptUuid: typeof type === 'string' && !type.startsWith('cc.') ? decompressUuid(type) : null,
                    fileId: info && info.fileId ? info.fileId : null,
                    id: ref && ref.__id__
                };
            })
        });
        for (const ref of node._children || []) {
            if (ref && typeof ref.__id__ === 'number') walk(ref.__id__, path);
        }
    };
    walk(rootNodeId(data), '');
    return out;
}

export function generateFileId(rand: () => number = Math.random): string {
    let id = '';
    for (let i = 0; i < 22; i++) id += BASE64[Math.floor(rand() * BASE64.length) % BASE64.length];
    return id;
}

function isNode(entry: any): boolean {
    return !!entry && entry.__type__ === 'cc.Node';
}

function rootNodeId(data: any[]): number {
    if (data[0] && data[0].__type__ === 'cc.Prefab' && data[0].data && typeof data[0].data.__id__ === 'number') {
        return data[0].data.__id__;
    }
    const idx = data.findIndex(isNode);
    if (idx < 0) throw new Error('No cc.Node entry in this prefab');
    return idx;
}

function pathsOf(data: any[]): Map<string, number> {
    const paths = new Map<string, number>();
    const walk = (id: number, prefix: string) => {
        const node = data[id];
        if (!isNode(node)) return;
        const path = prefix ? `${prefix}/${node._name}` : node._name;
        if (!paths.has(path)) paths.set(path, id);
        for (const ref of node._children || []) {
            if (ref && typeof ref.__id__ === 'number') walk(ref.__id__, path);
        }
    };
    walk(rootNodeId(data), '');
    return paths;
}

export function findNodeEntry(data: any[], selector: NodeSelector): { id: number; node: any } {
    if (typeof selector.nodeId === 'number') {
        if (!isNode(data[selector.nodeId])) throw new Error(`Entry ${selector.nodeId} is not a cc.Node`);
        return { id: selector.nodeId, node: data[selector.nodeId] };
    }
    if (selector.nodePath) {
        const paths = pathsOf(data);
        const id = paths.get(selector.nodePath);
        if (id === undefined) {
            throw new Error(`No node at path '${selector.nodePath}'. Known paths: ${[...paths.keys()].join(', ')}`);
        }
        return { id, node: data[id] };
    }
    if (selector.nodeName) {
        const matches: number[] = [];
        data.forEach((entry, i) => { if (isNode(entry) && entry._name === selector.nodeName) matches.push(i); });
        if (!matches.length) throw new Error(`No node named '${selector.nodeName}' in this prefab`);
        if (matches.length > 1) throw new Error(`${matches.length} nodes named '${selector.nodeName}' — pass nodePath instead`);
        return { id: matches[0], node: data[matches[0]] };
    }
    const id = rootNodeId(data);
    return { id, node: data[id] };
}

function componentIdsOnNode(data: any[], node: any, cid: string): number[] {
    return (node._components || [])
        .map((ref: any) => (ref && typeof ref.__id__ === 'number' ? ref.__id__ : -1))
        .filter((id: number) => id >= 0 && data[id] && data[id].__type__ === cid);
}

/**
 * Components a prefab mounts onto a nested prefab instance, in document order.
 *
 * They hang off `cc.MountedComponentsInfo.components` instead of any node's `_components`, and the
 * node they land on carries no `_name` of its own — its name comes from the nested prefab — so no
 * path or name reaches them. Indexing them across the prefab is the only address they have.
 */
export function mountedComponentIds(data: any[], cid: string): number[] {
    const ids: number[] = [];
    for (const entry of data) {
        if (!entry || entry.__type__ !== 'cc.MountedComponentsInfo') continue;
        for (const ref of entry.components || []) {
            const id = ref && typeof ref.__id__ === 'number' ? ref.__id__ : -1;
            if (id >= 0 && data[id] && data[id].__type__ === cid) ids.push(id);
        }
    }
    return ids.sort((a, b) => a - b);
}

/**
 * The entry a node reference must point at: a node inside this prefab, addressed by its path.
 *
 * A node reference cannot leave the prefab it is written in, so the path is resolved here rather
 * than against the scene. `findNodeEntry` names the paths that do exist when one does not.
 */
export function nodeRefInPrefabData(data: any[], nodePath: string): { __id__: number } {
    return { __id__: findNodeEntry(data, { nodePath }).id };
}

/** The entry a component reference must point at: one component of `cid` on the node at `nodePath`. */
export function componentRefInPrefabData(data: any[], nodePath: string, cid: string): { __id__: number } {
    const { node } = findNodeEntry(data, { nodePath });
    const matches = componentIdsOnNode(data, node, cid);
    if (!matches.length) throw new Error(`Node '${nodePath}' has no '${cid}' component in this prefab`);
    return { __id__: matches[0] };
}

export function addComponentToPrefabData(
    data: any[],
    selector: NodeSelector,
    cid: string,
    props: Record<string, any> = {},
    fileId?: string
): { data: any[]; componentId: number; fileId: string } {
    const out = data.slice();
    const { id, node } = findNodeEntry(out, selector);
    const componentId = out.length;
    const infoId = componentId + 1;
    const actualFileId = fileId || generateFileId();

    out.push({
        __type__: cid,
        _name: '',
        _objFlags: 0,
        __editorExtras__: {},
        _id: '',
        ...props,
        node: { __id__: id },
        _enabled: props._enabled !== undefined ? props._enabled : true,
        __prefab: { __id__: infoId }
    });
    out.push({ __type__: 'cc.CompPrefabInfo', fileId: actualFileId });

    const patched = { ...node, _components: [...(node._components || []), { __id__: componentId }] };
    out[id] = patched;
    return { data: out, componentId, fileId: actualFileId };
}

const DROPPED = Symbol('dropped-ref');

/** Splicing entries shifts every index, so each surviving `__id__` has to be rewritten. */
export function remapIds(data: any[], remap: Map<number, number>): any[] {
    // A dropped ref is spliced out of `_components` (a set) but nulled anywhere else, since every
    // other ref array is positional and shrinking it would shift the remaining indices.
    const rewrite = (value: any, key?: string): any => {
        if (Array.isArray(value)) {
            const mapped = value.map((v) => rewrite(v));
            // `components` is MountedComponentsInfo's own set of mounted components — a set like
            // `_components`, not a positional list, so a dropped ref is spliced rather than nulled.
            return key === '_components' || key === 'components'
                ? mapped.filter((v) => v !== DROPPED)
                : mapped.map((v) => (v === DROPPED ? null : v));
        }
        if (value && typeof value === 'object') {
            if (typeof value.__id__ === 'number' && Object.keys(value).length === 1) {
                const next = remap.get(value.__id__);
                return next === undefined ? DROPPED : { __id__: next };
            }
            const out: any = {};
            for (const k of Object.keys(value)) {
                const rewritten = rewrite(value[k], k);
                out[k] = rewritten === DROPPED ? null : rewritten;
            }
            return out;
        }
        return value;
    };
    return data.map((entry) => rewrite(entry));
}

export function removeComponentFromPrefabData(
    data: any[],
    selector: NodeSelector,
    cid: string,
    occurrence = 0,
    mounted = false
): { data: any[]; removedFileId: string | null; removedIds: number[] } {
    let componentId: number | undefined;
    if (mounted) {
        const matches = mountedComponentIds(data, cid);
        if (!matches.length) throw new Error(`No '${cid}' component is mounted onto a nested prefab instance here`);
        componentId = matches[occurrence];
        if (componentId === undefined) {
            throw new Error(`${matches.length} mounted '${cid}' component(s) in this prefab; occurrence ${occurrence} is out of range`);
        }
    } else {
        const { node } = findNodeEntry(data, selector);
        const matches = componentIdsOnNode(data, node, cid);
        if (!matches.length) {
            const alsoMounted = mountedComponentIds(data, cid).length;
            throw new Error(`Node '${node._name}' has no '${cid}' component`
                + (alsoMounted ? `, but ${alsoMounted} of them are mounted onto nested prefab instances — pass mounted:true to reach those` : ''));
        }
        componentId = matches[occurrence];
        if (componentId === undefined) {
            throw new Error(`Node '${node._name}' has ${matches.length} '${cid}' component(s); occurrence ${occurrence} is out of range`);
        }
    }

    const component = data[componentId];
    const infoId = component.__prefab && typeof component.__prefab.__id__ === 'number' ? component.__prefab.__id__ : -1;
    const info = infoId >= 0 ? data[infoId] : null;
    const removed = new Set<number>([componentId]);
    if (info && info.__type__ === 'cc.CompPrefabInfo') removed.add(infoId);

    const remap = new Map<number, number>();
    let next = 0;
    data.forEach((_entry, i) => {
        if (removed.has(i)) return;
        remap.set(i, next++);
    });

    const survivors = data.filter((_entry, i) => !removed.has(i));
    return {
        data: remapIds(survivors, remap),
        removedFileId: info && info.fileId ? info.fileId : null,
        removedIds: [...removed].sort((a, b) => a - b)
    };
}

/**
 * The value a property already holds, read without any of the write-time checks.
 *
 * The setter refuses several shapes outright — a dotted path through a scalar, a plain object over
 * a nested block — so it cannot be used to look before writing, which is exactly what deciding a
 * value's type needs. `undefined` means the property is not in the prefab.
 */
export function getComponentPropertyInPrefabData(
    data: any[],
    selector: NodeSelector,
    cid: string,
    property: string,
    occurrence = 0
): any {
    const { node } = findNodeEntry(data, selector);
    const matches = componentIdsOnNode(data, node, cid);
    const componentId = matches[occurrence];
    if (componentId === undefined) return undefined;

    let owner: any = data[componentId];
    const segments = property.split('.');
    for (let i = 0; i < segments.length - 1; i++) {
        const step = owner[segments[i]];
        if (!isSerializedRef(step)) return undefined;
        owner = data[step.__id__];
        if (!owner) return undefined;
    }
    return owner[segments[segments.length - 1]];
}

export function setComponentPropertyInPrefabData(
    data: any[],
    selector: NodeSelector,
    cid: string,
    property: string,
    value: any,
    occurrence = 0
): { data: any[]; previous: any; componentId: number } {
    const out = data.slice();
    const { node } = findNodeEntry(out, selector);
    const matches = componentIdsOnNode(out, node, cid);
    if (!matches.length) throw new Error(`Node '${node._name}' has no '${cid}' component`);
    const componentId = matches[occurrence];
    if (componentId === undefined) {
        throw new Error(`Node '${node._name}' has ${matches.length} '${cid}' component(s); occurrence ${occurrence} is out of range`);
    }
    const segments = property.split('.');
    let ownerId = componentId;
    let owner: any = { ...out[ownerId] };
    out[ownerId] = owner;

    for (let i = 0; i < segments.length - 1; i++) {
        const step = owner[segments[i]];
        if (!isSerializedRef(step)) {
            throw new Error(
                `'${segments.slice(0, i + 1).join('.')}' is not a nested block in this prefab `
                + `(it holds ${JSON.stringify(step)}), so '${property}' has no target. A dotted path only `
                + `resolves through a serializable @ccclass, which is stored as its own object.`
            );
        }
        ownerId = step.__id__;
        owner = { ...out[ownerId] };
        out[ownerId] = owner;
    }

    const leaf = segments[segments.length - 1];
    const previous = owner[leaf];

    // An inline @ccclass lives in its own entry and is referenced by `{__id__}`. Overwriting the
    // reference with the plain object would orphan that entry and leave a prefab the engine
    // cannot load, so a block is patched member by member instead.
    //
    // A node or component reference is stored the same way and is NOT that: repointing it, or
    // clearing it to null, is an ordinary assignment. Which of the two `{__id__}` means is decided
    // by the entry it names, never by the shape of the incoming value.
    if (isSerializedRef(previous) && isInlineBlock(out[previous.__id__])) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(
                `'${property}' is a nested block stored by reference; it takes an object of its members, `
                + `got ${JSON.stringify(value)}`
            );
        }
        const blockId = previous.__id__;
        const block = out[blockId];
        const unknown = Object.keys(value).filter((member) => !(member in block));
        if (unknown.length) {
            throw new Error(
                `'${property}' (${block.__type__}) has no member(s) ${unknown.join(', ')}. `
                + `Members: ${Object.keys(block).filter((k) => !k.startsWith('__')).join(', ')}`
            );
        }
        out[blockId] = { ...block, ...value };
        return { data: out, previous: block, componentId };
    }

    if (segments.length > 1 && !(leaf in owner)) {
        throw new Error(
            `'${property}' does not exist in this prefab — '${leaf}' is not a member of `
            + `${owner.__type__ || 'the target block'}. Members: `
            + `${Object.keys(owner).filter((k) => !k.startsWith('__')).join(', ')}`
        );
    }

    owner[leaf] = value;
    return { data: out, previous, componentId };
}

/** `{"__id__": 12}` — how the serializer stores a nested object, an inline @ccclass included. */
function isSerializedRef(value: any): value is { __id__: number } {
    return !!value && typeof value === 'object' && typeof value.__id__ === 'number';
}

/**
 * An entry that is a VALUE the property owns, rather than something it points at.
 *
 * Nodes announce themselves by `__type__`; a component is anything carrying a `node` back-link,
 * which is the same test the scene side uses. Everything else stored in its own entry is an inline
 * serializable @ccclass — the block that must be patched member by member instead of replaced.
 */
function isInlineBlock(entry: any): boolean {
    if (!entry || typeof entry !== 'object') return false;
    if (entry.__type__ === 'cc.Node') return false;
    return !Object.prototype.hasOwnProperty.call(entry, 'node');
}
