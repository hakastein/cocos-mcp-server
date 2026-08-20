import {
    projectAfterReload, contradictedOverrides, liveNodesBySerializedIndex
} from '@cocos-cli/shared';
import type { ReferenceOverride } from '@cocos-cli/shared';
import type { SceneMethods } from '@cocos-cli/shared';
import {
    componentClassName, ctorIsA, declaredPropertyCtor, findComponentByUuid,
    findNodeByUuid, findNodeByUuidOrNull, requireActiveScene, serializedEntityUuid
} from './engine.ts';

/**
 * Every `cc.TargetOverrideInfo` in the scene, with the object holding it. They sit on the scene's
 * own PrefabInfo and on each prefab instance root, and the engine replays all of them, so reading
 * one holder answers for a subset.
 */
function collectTargetOverrides(scene: any): Array<{ holder: any; override: any }> {
    const found: Array<{ holder: any; override: any }> = [];
    const collect = (holder: any) => {
        const list = holder && holder._prefab && holder._prefab.targetOverrides;
        if (Array.isArray(list)) for (const override of list) found.push({ holder, override });
    };
    collect(scene);
    const stack: any[] = [...(scene.children || [])];
    while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        collect(node);
        if (node.children && node.children.length) stack.push(...node.children);
    }
    return found;
}

/**
 * What an override points at in the scene as it stands, resolved through the engine's own
 * `getTarget` rather than a second reading of the fileId chain.
 */
function resolveOverrideTarget(override: any): string | null {
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    if (!utils || typeof utils.getTarget !== 'function') return null;
    const instance = override.target && override.target._prefab && override.target._prefab.instance;
    if (!instance || !instance.targetMap || !override.targetInfo) return null;
    const target = utils.getTarget(override.targetInfo.localID, instance.targetMap);
    return target ? target.uuid : null;
}

/**
 * The object an override names as its source. A source that lives inside a prefab instance is
 * recorded as the instance ROOT plus a fileId chain, so comparing `override.source` alone answers
 * "not mine" for every component inside an instance.
 */
function overrideSource(override: any): any {
    if (!override.sourceInfo) return override.source;
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    const instance = override.source && override.source._prefab && override.source._prefab.instance;
    if (!utils || typeof utils.getTarget !== 'function' || !instance || !instance.targetMap) return null;
    return utils.getTarget(override.sourceInfo.localID, instance.targetMap);
}

/**
 * The overrides that replay onto one component field. A path deeper than `field` or `field.index`
 * addresses something `component set` does not write, and is left alone.
 */
function referenceOverridesFor(
    scene: any, owner: any, property: string
): Array<{ holder: any; override: any; slot: ReferenceOverride }> {
    const matched: Array<{ holder: any; override: any; slot: ReferenceOverride }> = [];
    for (const entry of collectTargetOverrides(scene)) {
        const path = entry.override.propertyPath;
        if (overrideSource(entry.override) !== owner || !Array.isArray(path) || path[0] !== property) continue;
        if (path.length > 2) continue;
        const segment = path.length > 1 ? String(path[1]) : null;
        if (segment !== null && !/^\d+$/.test(segment)) continue;
        matched.push({
            ...entry,
            slot: { index: segment === null ? null : Number(segment), uuid: resolveOverrideTarget(entry.override) }
        });
    }
    return matched;
}

/** The fileId a prefab stamps on a node or a component — the only id that survives re-instantiation. */
function prefabFileId(entity: any): string | null {
    const info = entity && (entity.__prefab || entity._prefab);
    return (info && info.fileId) || null;
}

/** fileId -> node or component, over a whole tree. Both the asset's copy and the instance index this way. */
function fileIdIndex(root: any): Record<string, any> {
    const index: Record<string, any> = {};
    const walk = (node: any) => {
        const nodeId = prefabFileId(node);
        if (nodeId) index[nodeId] = node;
        for (const comp of node.components || []) {
            const compId = prefabFileId(comp);
            if (compId) index[compId] = comp;
        }
        for (const child of node.children || []) walk(child);
    };
    if (root) walk(root);
    return index;
}

/** Nearest ancestor-or-self carrying a PrefabInstance. */
function enclosingPrefabInstance(node: any): any {
    let current = node;
    while (current) {
        if (current._prefab && current._prefab.instance) return current;
        current = current.parent;
    }
    return null;
}

/**
 * A reference field on a component the scene file does not carry, which is every component inside a
 * prefab instance: the instance is rebuilt from the prefab ASSET and then its property overrides are
 * replayed, so the answer is the asset's own value translated into the instance by fileId, with the
 * overrides laid on top. `known:false` means the asset was not readable and nothing is claimed.
 */
function prefabInstanceReferenceSlots(
    instanceRoot: any, owner: any, property: string
): { known: boolean; slots: Array<string | null> } {
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    const instance = instanceRoot._prefab.instance;
    const asset = instanceRoot._prefab.asset;
    const ownerFileId = prefabFileId(owner);
    if (!asset || !asset.data || !ownerFileId) return { known: false, slots: [] };

    const assetIndex = fileIdIndex(asset.data);
    const liveIndex = fileIdIndex(instanceRoot);
    const assetOwner = assetIndex[ownerFileId];
    if (!assetOwner) return { known: false, slots: [] };

    // A reference inside the asset points at the ASSET's own node; the same fileId names the
    // instance's copy of it, which is the object the reloaded scene will hold.
    const translate = (entry: any): string | null => {
        const fileId = prefabFileId(entry);
        const live = fileId ? liveIndex[fileId] : null;
        return live ? live.uuid : null;
    };
    const base = assetOwner[property];
    const slots: Array<string | null> = Array.isArray(base) ? base.map(translate) : [translate(base)];

    for (const override of instance.propertyOverrides || []) {
        const path = override.propertyPath;
        if (!override.targetInfo || !Array.isArray(path) || path[0] !== property) continue;
        if (!utils || typeof utils.getTarget !== 'function' || !instance.targetMap) continue;
        if (utils.getTarget(override.targetInfo.localID, instance.targetMap) !== owner) continue;
        const value = override.value;
        if (path.length === 1) {
            slots.length = 0;
            slots.push((value && value.uuid) || null);
        } else if (path[1] === 'length') {
            slots.length = Number(value) || 0;
        } else if (/^\d+$/.test(String(path[1]))) {
            slots[Number(path[1])] = (value && value.uuid) || null;
        }
    }
    return { known: true, slots: Array.from(slots, (uuid) => (uuid === undefined ? null : uuid)) };
}

/**
 * A reference field as the next load builds it before target overrides are replayed: from the scene
 * file for an ordinary component, from the prefab asset plus its property overrides for one inside
 * an instance. `checked:false` means a slot could not be read, and nothing is claimed about it.
 */
function serializedReferenceSlots(
    scene: any, owner: any, property: string
): { inSceneGraph: boolean; checked: boolean; slots: Array<string | null> } {
    const serialized = (globalThis as any).EditorExtends.serialize(scene, { stringify: false });
    const objects: any[] = Array.isArray(serialized) ? serialized : [serialized];
    const componentObject = objects.find((entry) => entry && entry._id === owner.uuid);
    if (!componentObject) {
        const instanceRoot = enclosingPrefabInstance(owner.node);
        if (!instanceRoot) return { inSceneGraph: false, checked: false, slots: [] };
        const fromPrefab = prefabInstanceReferenceSlots(instanceRoot, owner, property);
        return { inSceneGraph: false, checked: fromPrefab.known, slots: fromPrefab.slots };
    }

    const sceneIndex = objects.findIndex((entry) => entry && entry.__type__ === 'cc.Scene');
    const nodeIndex = liveNodesBySerializedIndex(objects, sceneIndex, scene);
    let unresolved = false;
    const uuidOf = (value: any): string | null => {
        if (!value || typeof value.__id__ !== 'number') return null;   // the field genuinely holds nothing
        const direct = serializedEntityUuid(objects[value.__id__]);
        if (direct) return direct;
        const live = nodeIndex.get(value.__id__);
        if (live) return live.uuid;
        unresolved = true;
        return null;
    };
    const raw = componentObject[property];
    const slots = Array.isArray(raw) ? raw.map(uuidOf) : [uuidOf(raw)];
    return { inSceneGraph: true, checked: !unresolved, slots };
}

/**
 * The serialized value with the target overrides that replay onto it laid on top. For a reference
 * crossing a prefab instance boundary the file holds null and the override holds the link, so the
 * file alone answers the wrong question.
 */
export function overlaidReferenceValue(scene: any, owner: any, property: string, value: any): any {
    const segments = property.split('.');
    const overrides = referenceOverridesFor(scene, owner, segments[0]);
    if (!overrides.length) return value;
    const uuidOf = (entry: any): string | null =>
        (entry && typeof entry === 'object' && typeof entry.uuid === 'string' && entry.uuid) ? entry.uuid : null;

    if (segments.length === 1 && Array.isArray(value)) {
        const projected = projectAfterReload(value.map(uuidOf), overrides.map((entry) => entry.slot));
        return projected.map((uuid) => (uuid === null ? null : { uuid }));
    }
    const wanted = segments.length === 1
        ? overrides.find((entry) => entry.slot.index === null)
        : (/^\d+$/.test(segments[1])
            ? overrides.find((entry) => entry.slot.index === Number(segments[1]))
            : undefined);
    return (wanted && wanted.slot.uuid) ? { uuid: wanted.slot.uuid } : value;
}

function componentAt(node: any, componentIndex: number): any {
    const owner = (node.components || [])[componentIndex];
    if (!owner) throw new Error(`Node '${node.name}' has no component at index ${componentIndex}`);
    return owner;
}

/** A reference field's live contents as uuids, in the same one-slot-per-entry shape. */
function liveReferenceSlots(owner: any, property: string): Array<string | null> {
    const value = owner[property];
    const slots = Array.isArray(value) ? value : [value];
    return slots.map((entry: any) => (entry && entry.uuid) || null);
}

interface ReferenceWritePlan {
    node: any;
    owner: any;
    componentIndex: number;
    property: string;
    isArray: boolean;
    dumpType: string;
    uuids: string[];
    expected: Array<string | null>;
    resolved: any[];
    assignedKind: string;
    declaredType: string | null;
    inferredType: string | null;
    warning?: string;
}

/**
 * Turn the caller's arguments into the write to perform, or the reason there isn't one. Every
 * refusal here is a refusal before anything is touched.
 */
function planReferenceWrite(scene: any, args: any): { error: string } | ReferenceWritePlan {
    const cc = require('cc');
    const { componentType, property } = args;
    const node = findNodeByUuid(scene, args.nodeUuid);

    let owner: any;
    if (args.componentIndex !== undefined && args.componentIndex !== null) {
        const sameType = (node.components || []).filter((c: any) => c && c.constructor
            && (c.constructor.name === componentType || cc.js.getClassName(c.constructor) === componentType));
        owner = sameType[args.componentIndex];
        if (!owner) return { error: `Node '${node.name}' has no '${componentType}' at componentIndex ${args.componentIndex} (found ${sameType.length})` };
    } else {
        owner = node.getComponent(componentType);
        if (!owner) return { error: `Node '${node.name}' has no '${componentType}' component` };
    }
    if (!(property in owner)) return { error: `Component '${componentType}' has no property '${property}'` };

    const componentIndex = (node.components || []).indexOf(owner);
    const fieldValue = owner[property];
    const fieldIsArray = Array.isArray(fieldValue);
    const declaredCtor = declaredPropertyCtor(owner, property);
    const sampleExisting = fieldIsArray ? fieldValue.find((v: any) => v) : fieldValue;
    const inferredCtor = (!declaredCtor && sampleExisting && sampleExisting.constructor) || null;
    const effectiveCtor = declaredCtor || inferredCtor;
    const nameOfCtor = (ctor: any): string | null => (ctor ? cc.js.getClassName(ctor) : null);

    if (args.clear === true) {
        return {
            node, owner, componentIndex, property,
            isArray: fieldIsArray,
            dumpType: nameOfCtor(effectiveCtor) || 'cc.Node',
            uuids: [],
            expected: fieldIsArray ? [] : [null],
            resolved: [],
            assignedKind: 'null',
            declaredType: nameOfCtor(declaredCtor),
            inferredType: declaredCtor ? null : nameOfCtor(inferredCtor)
        };
    }

    const callerGaveArray = Array.isArray(args.targetUuids);
    const uuids: string[] = callerGaveArray ? args.targetUuids : (args.targetUuid ? [args.targetUuid] : []);
    if (!uuids.length) return { error: 'Pass targetUuid, targetUuids, or clear:true' };
    // CCClass metadata reports the ELEMENT type for array fields, so the field's own value is
    // the only reliable signal of its shape.
    if (fieldIsArray && !callerGaveArray) {
        return { error: `'${property}' is an array field (currently ${fieldValue.length} entries) — pass targetUuids: [...]; a single targetUuid would replace the whole array` };
    }
    if (!fieldIsArray && fieldValue !== null && fieldValue !== undefined && callerGaveArray) {
        return { error: `'${property}' is a single-reference field — pass targetUuid, not targetUuids` };
    }

    const wantsNode = ctorIsA(effectiveCtor, cc.Node);
    const wantsComponent = ctorIsA(effectiveCtor, cc.Component);
    const resolved: any[] = [];
    for (const uuid of uuids) {
        const targetNode = findNodeByUuidOrNull(scene, uuid);
        if (targetNode) {
            if (args.targetComponentType) {
                const comp = targetNode.getComponent(args.targetComponentType);
                if (!comp) return { error: `Target node '${targetNode.name}' has no '${args.targetComponentType}' component` };
                resolved.push(comp);
            } else if (wantsComponent && effectiveCtor) {
                const comp = targetNode.getComponent(effectiveCtor);
                if (!comp) return { error: `Target node '${targetNode.name}' has no '${cc.js.getClassName(effectiveCtor)}' component (the field '${property}' ${declaredCtor ? 'declares' : 'currently holds'} that type)` };
                resolved.push(comp);
            } else {
                resolved.push(targetNode);
            }
            continue;
        }
        const targetComp = findComponentByUuid(scene, uuid);
        if (!targetComp) {
            return {
                error: `Target uuid '${uuid}' matched no node and no component in the open scene. `
                    + 'A uuid captured before a scene reload or a script recompile can name nothing while still '
                    + 'looking valid — pass targetPath instead and it is resolved against the scene as it is now.'
            };
        }
        resolved.push(wantsNode ? targetComp.node : targetComp);
    }

    if (declaredCtor) {
        const bad = resolved.find((v) => !(v instanceof declaredCtor));
        if (bad) {
            return { error: `'${property}' declares ${cc.js.getClassName(declaredCtor)} but the resolved target is ${bad.constructor && bad.constructor.name}` };
        }
    }
    // A destroyed object still answers with its uuid, so a read-back would agree with itself while
    // the serializer wrote a reference resolving to nothing — the red "Missing Node" in the Inspector.
    const dead = resolved.filter((v: any) => v.isValid === false)
        .map((v: any) => `${v.uuid} (${v.name || (v.node && v.node.name) || ''})`);
    if (dead.length) {
        return { error: `'${property}' cannot take a destroyed target: ${dead.join(', ')}. Re-address it by path.` };
    }

    const uuidsToWrite = resolved.map((v: any) => v.uuid);
    return {
        node, owner, componentIndex, property,
        isArray: fieldIsArray || callerGaveArray,
        dumpType: nameOfCtor(declaredCtor)
            || (resolved[0] instanceof cc.Node ? 'cc.Node' : componentClassName(resolved[0])),
        uuids: uuidsToWrite,
        expected: uuidsToWrite,
        resolved,
        assignedKind: resolved[0] instanceof cc.Node ? 'node' : 'component',
        declaredType: nameOfCtor(declaredCtor),
        inferredType: declaredCtor ? null : nameOfCtor(inferredCtor),
        warning: !effectiveCtor && resolved[0] instanceof cc.Node
            ? `No type metadata for '${property}' and it was empty — assigned the NODE. If a component was meant, pass targetComponentType.`
            : undefined
    };
}

/**
 * The decided shape of a reference write, with nothing touched: which component owns the field,
 * whether it is an array, what the editor dump must call the type, and the uuids to write.
 *
 * Resolution has to happen in the scene process — only here can a component uuid become an
 * object, a CCClass report a property's declared type, or a branch under an inactive parent be
 * seen — but the WRITE belongs to the editor's set-property channel, which is the only writer
 * that records the target override a reference into a prefab instance survives on.
 */
export const resolveComponentReference: SceneMethods['resolveComponentReference'] = (args: any = {}) => {
    try {
        const { nodeUuid, componentType, property } = args;
        if (!nodeUuid || !componentType || !property) {
            return { success: false, error: 'nodeUuid, componentType and property are required' };
        }
        const plan = planReferenceWrite(requireActiveScene(), args);
        if ('error' in plan) return { success: false, error: plan.error };
        return {
            success: true,
            data: {
                componentIndex: plan.componentIndex,
                property: plan.property,
                isArray: plan.isArray,
                dumpType: plan.dumpType,
                uuids: plan.uuids,
                expected: plan.expected,
                assignedKind: plan.assignedKind,
                assignedNames: plan.resolved.map((v: any) => v.name || (v.node && v.node.name) || ''),
                assignedTypes: plan.resolved.map((v: any) => v.constructor && v.constructor.name),
                declaredType: plan.declaredType,
                inferredType: plan.inferredType,
                warning: plan.warning
            }
        };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * Assign the reference on the LIVE component. This is the fallback for a field the editor's
 * set-property channel refuses: it reaches any component and needs no Inspector metadata, but it
 * records nothing, so a reference into a prefab instance written this way reads back perfectly
 * and is gone at the next load. Whether it survives is `componentReferenceOutcome`'s answer.
 */
export const applyComponentReference: SceneMethods['applyComponentReference'] = (args: any = {}) => {
    try {
        const { nodeUuid, componentType, property } = args;
        if (!nodeUuid || !componentType || !property) {
            return { success: false, error: 'nodeUuid, componentType and property are required' };
        }
        const plan = planReferenceWrite(requireActiveScene(), args);
        if ('error' in plan) return { success: false, error: plan.error };
        plan.owner[plan.property] = args.clear === true
            ? (plan.isArray ? [] : null)
            : (plan.isArray ? plan.resolved : plan.resolved[0]);
        return { success: true, data: { property: plan.property, assigned: plan.expected } };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * What a reference field holds now, what the scene file will carry, and what the next load will
 * build from the two. Only the last one answers "did the write survive": a reference crossing a
 * prefab instance boundary is never written into the file, so the live value agrees with itself
 * whether or not the target override that actually carries the link exists.
 */
export const componentReferenceOutcome: SceneMethods['componentReferenceOutcome'] = (
    nodeUuid, componentIndex, property,
) => {
    try {
        const scene = requireActiveScene();
        const owner = componentAt(findNodeByUuid(scene, nodeUuid), componentIndex);
        const file = serializedReferenceSlots(scene, owner, property);
        const overrides = referenceOverridesFor(scene, owner, property);
        return {
            success: true,
            data: {
                live: liveReferenceSlots(owner, property),
                serialized: file.slots,
                projected: projectAfterReload(file.slots, overrides.map((entry) => entry.slot)),
                projectionChecked: file.checked,
                componentInSceneGraph: file.inSceneGraph,
                overrides: overrides.map((entry) => ({
                    index: entry.slot.index,
                    uuid: entry.slot.uuid,
                    prefabInstance: entry.override.target ? entry.override.target.name : null
                }))
            }
        };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

interface Divergence {
    uncovered: string[];
    untyped: string[];
}

/**
 * The editor's own recorder diffs two objects only when their constructors match and both are
 * CCClasses; anything else it walks past, recording no override for the property above it. So a
 * class mismatch is reported here rather than treated as a plain difference.
 */
function diffAgainstAsset(live: any, base: any, path: string, out: Divergence, depth = 12): void {
    const cc = require('cc');
    if (depth <= 0) { out.uncovered.push(`${path} (too deeply nested to compare)`); return; }
    const missing = (value: any) => value === null || value === undefined;
    if (missing(live) || missing(base)) {
        if (missing(live) !== missing(base)) out.uncovered.push(path);
        return;
    }
    if (Array.isArray(live) || Array.isArray(base)) {
        if (!Array.isArray(live) || !Array.isArray(base)) { out.uncovered.push(path); return; }
        if (live.length !== base.length) out.uncovered.push(`${path}.length`);
        for (let index = 0; index < live.length; index++) {
            diffAgainstAsset(live[index], base[index], `${path}.${index}`, out, depth - 1);
        }
        return;
    }
    if (typeof live !== 'object' || typeof base !== 'object') {
        if (live !== base) out.uncovered.push(path);
        return;
    }
    if (live instanceof cc.Asset || base instanceof cc.Asset) {
        if (live._uuid !== base._uuid) out.uncovered.push(path);
        return;
    }
    if (live instanceof cc.Node || live instanceof cc.Component
        || base instanceof cc.Node || base instanceof cc.Component) {
        if (prefabFileId(live) !== prefabFileId(base)) out.uncovered.push(path);
        return;
    }
    if (live instanceof cc.ValueType || base instanceof cc.ValueType) {
        if (!(live instanceof cc.ValueType) || !live.equals(base)) out.uncovered.push(path);
        return;
    }

    const sameClass = live.constructor === base.constructor;
    const isClass = cc.CCClass && typeof cc.CCClass.isCCClassOrFastDefined === 'function'
        && cc.CCClass.isCCClassOrFastDefined(live.constructor);
    if (sameClass && isClass) {
        for (const member of live.constructor.__values__ || live.constructor.__props__ || []) {
            diffAgainstAsset(live[member], base[member], `${path}.${member}`, out, depth - 1);
        }
        return;
    }
    const keys = Array.from(new Set([...Object.keys(live), ...Object.keys(base)]));
    const before = out.uncovered.length;
    for (const key of keys) diffAgainstAsset(live[key], base[key], `${path}.${key}`, out, depth - 1);
    if (out.uncovered.length !== before || !sameClass) {
        out.untyped.push(`${path} (${classNameOfValue(live)} in the instance, `
            + `${classNameOfValue(base)} in the prefab asset)`);
    }
}

function classNameOfValue(value: any): string {
    const ctor = value && value.constructor;
    return (ctor && ctor.name) || typeof value;
}

function resolveMemberPath(owner: any, segments: string[]): any {
    let current = owner;
    for (const segment of segments) {
        if (current === null || current === undefined) return undefined;
        current = current[segment];
    }
    return current;
}

/** The overrides the instance records against one component, as dot-joined paths plus their value. */
function propertyOverridesFor(
    instance: any, owner: any, property: string
): Array<{ path: string; segments: string[]; value: any }> {
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    const found: Array<{ path: string; segments: string[]; value: any }> = [];
    for (const override of instance.propertyOverrides || []) {
        const path = override.propertyPath;
        if (!override.targetInfo || !Array.isArray(path) || path[0] !== property) continue;
        if (!utils || typeof utils.getTarget !== 'function' || !instance.targetMap) continue;
        if (utils.getTarget(override.targetInfo.localID, instance.targetMap) !== owner) continue;
        found.push({ path: path.join('.'), segments: path.slice(), value: override.value });
    }
    return found;
}

/**
 * What the next load builds for a component the scene file does not carry: the prefab asset's own
 * value, with the instance's property overrides laid on top. An override whose recorded value the
 * live component has since moved away from covers nothing.
 */
export const prefabInstancePropertyOutcome: SceneMethods['prefabInstancePropertyOutcome'] = (
    nodeUuid, cid, property,
) => {
    try {
        const cc = require('cc');
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const owner = (node.components || []).find((component: any) =>
            component && (cc.js as any)._getClassId(component.constructor) === cid);
        if (!owner) return { success: false, error: `No component with cid '${cid}' on node ${nodeUuid}` };

        const blank = {
            inPrefabInstance: false, known: false, carried: false,
            instanceRoot: null, prefabAsset: null, overridePaths: [], uncovered: [], untyped: []
        };
        const root = enclosingPrefabInstance(node);
        if (!root) return { success: true, data: { ...blank, reason: 'the component is not inside a prefab instance' } };

        const info = root._prefab;
        const asset = info && info.asset;
        const instance = info && info.instance;
        const ownerFileId = prefabFileId(owner);
        const inside = { ...blank, inPrefabInstance: true, instanceRoot: root.uuid, prefabAsset: (asset && asset._uuid) || null };
        if (!asset || !asset.data || !instance) {
            return { success: true, data: { ...inside, reason: 'the prefab asset behind this instance could not be read' } };
        }
        if (!ownerFileId) {
            return {
                success: true,
                data: {
                    ...inside,
                    reason: 'the component carries no prefab fileId, so it was added to the instance rather '
                        + 'than inherited — the scene file keeps it as a mounted component'
                }
            };
        }
        const counterpart = fileIdIndex(asset.data)[ownerFileId];
        if (!counterpart) {
            return { success: true, data: { ...inside, reason: `the prefab asset holds no component with fileId ${ownerFileId}` } };
        }

        const segments = property.split('.');
        const divergence: Divergence = { uncovered: [], untyped: [] };
        diffAgainstAsset(
            resolveMemberPath(owner, segments), resolveMemberPath(counterpart, segments), property, divergence
        );

        const overrides = propertyOverridesFor(instance, owner, segments[0]).filter((override) => {
            const recorded: Divergence = { uncovered: [], untyped: [] };
            diffAgainstAsset(resolveMemberPath(owner, override.segments), override.value, override.path, recorded);
            return recorded.uncovered.length === 0;
        });
        const uncovered = divergence.uncovered.filter((path) =>
            !overrides.some((override) => path === override.path || path.indexOf(`${override.path}.`) === 0));

        return {
            success: true,
            data: {
                ...inside,
                known: true,
                carried: uncovered.length === 0,
                overridePaths: overrides.map((override) => override.path),
                uncovered,
                untyped: divergence.untyped
            }
        };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * Drop the target overrides the field's current contents contradict. The editor records one per
 * slot it writes and never removes one, so a leftover wins over the serialized value at the next
 * load: a shortened array grows back, and a slot repointed at a node outside the instance snaps
 * back to the old target.
 */
export const pruneComponentReferenceOverrides: SceneMethods['pruneComponentReferenceOverrides'] = (
    nodeUuid, componentIndex, property,
) => {
    try {
        const scene = requireActiveScene();
        const owner = componentAt(findNodeByUuid(scene, nodeUuid), componentIndex);
        const live = liveReferenceSlots(owner, property);
        const entries = referenceOverridesFor(scene, owner, property);
        const doomed = new Set(contradictedOverrides(live, entries.map((entry) => entry.slot)));
        const paths: string[] = [];
        entries.forEach((entry, position) => {
            if (!doomed.has(position)) return;
            const list = entry.holder._prefab.targetOverrides;
            const at = list.indexOf(entry.override);
            if (at < 0) return;
            list.splice(at, 1);
            paths.push(entry.slot.index === null ? property : `${property}.${entry.slot.index}`);
        });
        return { success: true, data: { removed: paths.length, paths } };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};
