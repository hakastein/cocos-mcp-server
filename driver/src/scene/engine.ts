// Helpers shared across scene script methods
export function getScene(): any {
    const { director } = require('cc');
    return director.getScene();
}

export function requireActiveScene(): any {
    const scene = getScene();
    if (!scene) throw new Error('No active scene');
    return scene;
}

export function findNodeByUuid(scene: any, nodeUuid: string): any {
    // scene.getChildByUuid only checks the scene's DIRECT children, so it misses any
    // nested node (and children of inactive parents). Walk the whole tree instead, which
    // also traverses inactive branches — essential for authoring e.g. a ParticleSystem
    // that lives under an inactive template node.
    const direct = scene.getChildByUuid ? scene.getChildByUuid(nodeUuid) : null;
    if (direct) return direct;
    const stack: any[] = [...(scene.children || [])];
    while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        if (n.uuid === nodeUuid) return n;
        if (n.children && n.children.length) stack.push(...n.children);
    }
    throw new Error(`Node not found: ${nodeUuid}`);
}

export function findComponentClass(componentType: string): any {
    const { js } = require('cc');
    const cls = js.getClassByName(componentType);
    if (!cls) throw new Error(`Component type not found: ${componentType}`);
    return cls;
}

export function findNodeByUuidOrNull(scene: any, nodeUuid: string): any {
    try {
        return findNodeByUuid(scene, nodeUuid);
    } catch {
        return null;
    }
}

export function findComponentByUuid(scene: any, uuid: string): any {
    const stack: any[] = [...(scene.children || [])];
    while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        for (const c of n.components || []) if (c && c.uuid === uuid) return c;
        if (n.children && n.children.length) stack.push(...n.children);
    }
    return null;
}

/**
 * The uuids for the serialized node entries the file does not name, and the entries left over.
 *
 * `liveNodesBySerializedIndex` builds `nodes`; `unnamed` collects the indices it could not answer
 * for, which are references whose fate is UNKNOWN rather than empty.
 */
export interface SerializedNodeNaming {
    nodes: Map<number, { uuid: string }>;
    unnamed: number[];
}

/**
 * Serialized output as plain comparable data: `__id__` back-references followed into the object
 * array, an asset's `__uuid__` spelled the way a dump spells it, and the bookkeeping keys that
 * carry no authored value dropped.
 */
export function plainSerialized(
    objects: any[], value: any, depth: number, naming: SerializedNodeNaming
): any {
    if (depth > 8 || !value || typeof value !== 'object') return value;
    if (typeof value.__id__ === 'number') {
        const target = objects[value.__id__];
        // A node or component is reported BY UUID. Following the back-reference would inline the
        // object graph it points into, which across a whole-scene serialization is most of the scene.
        const entity = serializedEntityUuid(target);
        if (entity) return { uuid: entity };
        // A prefab instance ROOT carries no `_id`: its identity is the prefab plus the instance
        // record, and the next load hands it a fresh uuid. Expanding that stub as an ordinary object
        // is how a reference the file does carry got read as pointing at nothing.
        if (target && target.__type__ === 'cc.Node') {
            const live = naming.nodes.get(value.__id__);
            if (live) return { uuid: live.uuid };
            naming.unnamed.push(value.__id__);
            return { uuid: null };
        }
        return plainSerialized(objects, target, depth + 1, naming);
    }
    if (typeof value.__uuid__ === 'string') return { uuid: value.__uuid__ };
    if (Array.isArray(value)) return value.map(item => plainSerialized(objects, item, depth + 1, naming));
    const plain: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === '__type__' || key === '_objFlags' || key === '__editorExtras__') continue;
        plain[key] = plainSerialized(objects, item, depth + 1, naming);
    }
    return plain;
}

/**
 * A serialized node or component, named by its scene uuid. Everything else in the object list —
 * PrefabInfo, value types, inline @ccclass blocks — answers null and is expanded normally.
 */
export function serializedEntityUuid(entry: any): string | null {
    if (!entry || typeof entry !== 'object' || typeof entry._id !== 'string') return null;
    const isNode = entry.__type__ === 'cc.Node';
    const isComponent = Object.prototype.hasOwnProperty.call(entry, 'node');
    return (isNode || isComponent) ? entry._id : null;
}

/** CCClass attribute metadata is absent for plenty of custom-script fields — absence is not an error here. */
export function declaredPropertyCtor(owner: any, property: string): any {
    const cc = require('cc');
    const attrOf = (cc.CCClass && cc.CCClass.attr) || (cc.Class && cc.Class.attr);
    if (typeof attrOf !== 'function') return null;
    try {
        const attr = attrOf(owner.constructor, property);
        return (attr && attr.ctor) || null;
    } catch {
        return null;
    }
}

export function ctorIsA(ctor: any, base: any): boolean {
    return !!ctor && !!base && (ctor === base || (ctor.prototype instanceof base));
}

/**
 * The name the engine has a component registered under — `cc.Sprite` for builtins, the
 * `@ccclass` string for user scripts. This is the name the serializer and the editor use,
 * and the one a caller can pass back to `component get`, `component set` or `component rm`.
 *
 * `constructor.name` is only the JS identifier: it is right most of the time but silently
 * disagrees whenever a bundler renames the class or `@ccclass` was given a different
 * string. It is kept as the fallback, never as the answer.
 */
export function componentClassName(comp: any): string {
    if (!comp) return 'Unknown';
    try {
        const { js } = require('cc');
        const name = js.getClassName(comp);
        if (name) return name;
    } catch {
        // engine class registry unavailable — fall through
    }
    return comp.constructor ? comp.constructor.name : 'Unknown';
}

/** The fileId a prefab stamps on a node or a component — the only id that survives re-instantiation. */
export function prefabFileId(entity: any): string | null {
    const info = entity && (entity.__prefab || entity._prefab);
    return (info && info.fileId) || null;
}

/** fileId -> node or component, over a whole tree. Both the asset's copy and the instance index this way. */
export function fileIdIndex(root: any): Record<string, any> {
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
export function enclosingPrefabInstance(node: any): any {
    let current = node;
    while (current) {
        if (current._prefab && current._prefab.instance) return current;
        current = current.parent;
    }
    return null;
}

/**
 * What an override's localID chain names inside one instance, generated rather than read off
 * `instance.targetMap`: the engine fills that one while EXPANDING an instance it deserialized, so on
 * an instance the editor built in this session it is `{}` and every chain resolves to `undefined` —
 * checked live 2026-08-22 on a freshly instantiated prefab. Generating it is what the next load does.
 */
export function instanceTargets(instanceRoot: any): Record<string, any> | null {
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    if (!utils || typeof utils.getTarget !== 'function'
        || typeof utils.generateTargetMap !== 'function') return null;
    if (!instanceRoot || !instanceRoot._prefab || !instanceRoot._prefab.instance) return null;
    const targets: Record<string, any> = {};
    utils.generateTargetMap(instanceRoot, targets, true);
    return targets;
}

export function targetIn(targets: Record<string, any> | null, localID: string[] | undefined): any {
    const cc = require('cc');
    const utils = cc.Prefab && (cc.Prefab as any)._utils;
    return (targets && localID) ? utils.getTarget(localID, targets) : null;
}

/**
 * The property overrides the instance records against one component's field, as the recorded path
 * plus its value. An override names its target by a localID chain rather than by a path, so a path
 * alone answers for every component of the instance rather than for this one.
 */
export function instanceOverridesFor(
    instanceRoot: any, owner: any, property: string
): Array<{ path: string[]; value: any }> {
    const instance = instanceRoot && instanceRoot._prefab && instanceRoot._prefab.instance;
    const found: Array<{ path: string[]; value: any }> = [];
    if (!instance) return found;
    const targets = instanceTargets(instanceRoot);
    for (const override of instance.propertyOverrides || []) {
        const path = override.propertyPath;
        if (!override.targetInfo || !Array.isArray(path) || path[0] !== property) continue;
        if (targetIn(targets, override.targetInfo.localID) !== owner) continue;
        found.push({ path: path.slice(), value: override.value });
    }
    return found;
}
