import type {
    OverrideValueDescription, PrefabSyncReport, PrefabTargetInfo, SceneMethods, SceneResult
} from '../scene-contract';
import { findNodeByUuid, requireActiveScene } from './engine';

declare const cce: any;

/** Nearest ancestor carrying a PrefabInstance — the node a property override actually belongs to. */
function findPrefabInstanceRoot(node: any): any {
    let cur = node && node.parent;
    while (cur) {
        if (cur._prefab && cur._prefab.instance) return cur;
        cur = cur.parent;
    }
    return null;
}

/**
 * fileId -> descriptor for every node and component under a prefab instance root. A
 * CCPropertyOverrideInfo names its target by that fileId alone, so this is what turns a
 * record into something a reader can act on.
 */
function mapPrefabFileIds(root: any): Record<string, PrefabTargetInfo> {
    const map: Record<string, PrefabTargetInfo> = {};
    const walk = (n: any, path: string) => {
        const nodeId = n._prefab && n._prefab.fileId;
        if (nodeId) map[nodeId] = { kind: 'node', name: n.name, path, type: 'cc.Node' };
        for (const c of n.components || []) {
            const compId = c && c.__prefab && c.__prefab.fileId;
            if (compId) map[compId] = { kind: 'component', name: n.name, path, type: c.constructor && c.constructor.name };
        }
        (n.children || []).forEach((child: any) => walk(child, path + '/' + child.name));
    };
    walk(root, root.name);
    return map;
}

/** Classify an override value: primitive, asset ref, node/component ref, or engine value type. */
function describeOverrideValue(value: any): OverrideValueDescription {
    if (value === null || value === undefined) return { valueKind: 'null', value: null };
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return { valueKind: 'primitive', value };
    if (Array.isArray(value)) return { valueKind: 'array', length: value.length };
    const cc = require('cc');
    const typeName = (value.constructor && value.constructor.name) || 'object';
    if (cc.Asset && value instanceof cc.Asset) {
        return { valueKind: 'asset', valueType: typeName, assetUuid: value._uuid || null, assetName: value.name };
    }
    if (cc.Node && value instanceof cc.Node) return { valueKind: 'node', refUuid: value.uuid, refName: value.name };
    if (cc.Component && value instanceof cc.Component) {
        return { valueKind: 'component', valueType: typeName, refUuid: value.uuid, refName: value.node && value.node.name };
    }
    if (cc.ValueType && value instanceof cc.ValueType) {
        return { valueKind: 'valueType', valueType: typeName, value: JSON.parse(JSON.stringify(value)) };
    }
    // An asset whose uuid no longer resolves can survive as the raw serialized stub.
    const stubUuid = value._uuid || value.__uuid__;
    if (stubUuid) return { valueKind: 'asset', valueType: typeName, assetUuid: stubUuid };
    return { valueKind: 'object', valueType: typeName };
}

/**
 * Generate faithful prefab JSON from a scene node using the editor's own serializer
 * (`cce.Prefab.generatePrefabDataFromNode`). Unlike the hand-rolled serializer this
 * preserves ALL component refs — MeshRenderer `_mesh`/`_materials`, asset uuids, node
 * links — because it is the exact path the editor uses when you drag a node to Assets.
 * Returns the prefab file content; the caller (panel process) writes it via asset-db.
 */
export const createPrefabFromNode2: SceneMethods['createPrefabFromNode2'] = (nodeUuid) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        if (typeof cce === 'undefined' || !cce?.Prefab?.generatePrefabDataFromNode) {
            return { success: false, error: 'cce.Prefab.generatePrefabDataFromNode is unavailable in this editor build' };
        }
        const gen = cce.Prefab.generatePrefabDataFromNode(node);
        const prefabData: string = (gen && typeof gen.prefabData === 'string')
            ? gen.prefabData
            : (typeof gen === 'string' ? gen : JSON.stringify(gen));
        if (!prefabData || prefabData.length < 2) {
            return { success: false, error: 'Generated prefab data was empty' };
        }
        return { success: true, data: { prefabData, nodeName: node.name } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Apply and revert go through `cce.Prefab` rather than an editor message: `scene:revert-prefab`
 * is not a message this editor registers at all, and `scene:apply-prefab` is undocumented and
 * declares no argument shape, while `cce.Prefab.applyPrefab(nodeUuid)` /
 * `cce.Prefab.revertPrefab(nodeUuid)` are the calls those messages exist to reach. Neither
 * records an undo step, as with every other write this bridge makes.
 */
async function syncPrefabInstance(
    nodeUuid: string,
    operation: 'applyPrefab' | 'revertPrefab'
): Promise<SceneResult<PrefabSyncReport>> {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const prefab = node._prefab;
        if (!prefab || !prefab.instance) {
            const root = findPrefabInstanceRoot(node);
            const hint = root
                ? ` The enclosing prefab instance root is '${root.name}' (uuid ${root.uuid}) — pass that.`
                : ' This node is not the root of a prefab instance.';
            return { success: false, error: `Node '${node.name}' carries no PrefabInstance.${hint}` };
        }
        if (typeof cce === 'undefined' || typeof cce?.Prefab?.[operation] !== 'function') {
            return { success: false, error: `cce.Prefab.${operation} is unavailable in this editor build` };
        }
        const accepted = await cce.Prefab[operation](node.uuid);
        return {
            success: true,
            data: {
                nodeUuid: node.uuid,
                nodeName: node.name,
                prefabAsset: (prefab.asset && prefab.asset._uuid) || null,
                instanceRoot: true,
                accepted: accepted !== false
            }
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
}

export const applyPrefabToAsset: SceneMethods['applyPrefabToAsset'] =
    (nodeUuid) => syncPrefabInstance(nodeUuid, 'applyPrefab');

export const revertPrefabInstance: SceneMethods['revertPrefabInstance'] =
    (nodeUuid) => syncPrefabInstance(nodeUuid, 'revertPrefab');

/**
 * Describe every property override on a prefab-instance node. The records live on
 * `node._prefab.instance.propertyOverrides` as CCPropertyOverrideInfo: a `targetInfo.localID`
 * chain naming the node or component inside the instance, a `propertyPath`, and the overriding
 * `value`. The editor appends them as the scene is edited and never re-derives them from a diff
 * on save, so a record outlives the value it was written for — an asset ref whose uuid stopped
 * resolving keeps being serialised into the .scene and keeps failing to load at runtime.
 * Asset liveness is deliberately NOT judged here: the engine cache still hands back a reimported
 * asset under its old uuid, so the caller resolves each `assetUuid` against the asset database.
 */
export const listPrefabOverrides: SceneMethods['listPrefabOverrides'] = (nodeUuid) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const instance = node._prefab && node._prefab.instance;
        if (!instance) {
            const root = findPrefabInstanceRoot(node);
            const hint = root
                ? ` The enclosing prefab instance root is '${root.name}' (uuid ${root.uuid}) — pass that.`
                : ' This node is not part of a prefab instance.';
            return { success: false, error: `Node '${node.name}' carries no PrefabInstance.${hint}` };
        }
        const targets = mapPrefabFileIds(node);
        const overrides = (instance.propertyOverrides || []).map((o: any, index: number) => {
            const localID: string[] = (o.targetInfo && o.targetInfo.localID) || [];
            const propertyPath: string[] = o.propertyPath || [];
            return {
                index,
                propertyPath: propertyPath.join('.'),
                propertyPathParts: propertyPath,
                localID,
                target: targets[localID[localID.length - 1]] || null,
                ...describeOverrideValue(o.value)
            };
        });
        return {
            success: true,
            data: {
                nodeUuid: node.uuid,
                nodeName: node.name,
                prefabAsset: node._prefab.asset && node._prefab.asset._uuid,
                overrideCount: overrides.length,
                removedComponents: (instance.removedComponents || []).length,
                mountedChildren: (instance.mountedChildren || []).length,
                overrides
            }
        };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Drop ONE CCPropertyOverrideInfo from a prefab instance, leaving every other override
 * (transform, materials, designer-added components) untouched — which is what separates this
 * from restore-prefab, which discards the lot. The record is spliced off the live
 * `propertyOverrides` array and the editor serialises what remains on the next save, so the
 * file's `__id__` numbering is regenerated by the serialiser rather than patched by hand.
 * A propertyPath that matches several records (the same path on two child nodes) is refused
 * with the candidates listed; disambiguate with `localID` or `index`.
 */
export const removePrefabOverride: SceneMethods['removePrefabOverride'] = (nodeUuid, propertyPath, localID, index) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const instance = node._prefab && node._prefab.instance;
        if (!instance) return { success: false, error: `Node '${node.name}' carries no PrefabInstance` };
        const all = instance.propertyOverrides || [];
        const wanted = Array.isArray(propertyPath) ? propertyPath.join('.') : String(propertyPath);
        const targets = mapPrefabFileIds(node);

        const matches = all
            .map((o: any, i: number) => ({ o, i }))
            .filter(({ o, i }: any) => {
                if (typeof index === 'number' && i !== index) return false;
                if ((o.propertyPath || []).join('.') !== wanted) return false;
                if (!localID) return true;
                const chain = (o.targetInfo && o.targetInfo.localID) || [];
                return chain[chain.length - 1] === localID || chain.join('/') === localID;
            });

        if (!matches.length) {
            const paths = all.map((o: any) => (o.propertyPath || []).join('.'));
            return { success: false, error: `No override with propertyPath '${wanted}'${localID ? ` for localID '${localID}'` : ''} on '${node.name}'. Present: ${paths.join(', ') || '(none)'}` };
        }
        if (matches.length > 1) {
            const candidates = matches.map(({ o, i }: any) => {
                const chain = (o.targetInfo && o.targetInfo.localID) || [];
                const t = targets[chain[chain.length - 1]];
                return `index ${i} (localID ${chain.join('/')}${t ? `, ${t.kind} ${t.path}` : ''})`;
            });
            return { success: false, error: `propertyPath '${wanted}' matches ${matches.length} overrides — pass localID or index. Candidates: ${candidates.join('; ')}` };
        }

        const { o, i } = matches[0];
        const chain = (o.targetInfo && o.targetInfo.localID) || [];
        const removed = {
            index: i,
            propertyPath: wanted,
            localID: chain,
            target: targets[chain[chain.length - 1]] || null,
            ...describeOverrideValue(o.value)
        };
        instance.propertyOverrides = all.filter((_x: any, k: number) => k !== i);
        return { success: true, data: { nodeUuid: node.uuid, removed, remaining: instance.propertyOverrides.length } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};
