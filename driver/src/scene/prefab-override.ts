import type { SceneMethods } from '@cocos-cli/shared';
import {
    enclosingPrefabInstance, fileIdIndex, findNodeByUuid, instanceOverridesFor, prefabFileId,
    requireActiveScene
} from './engine.ts';

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

function propertyOverridesFor(
    instance: any, owner: any, property: string
): Array<{ path: string; segments: string[]; value: any }> {
    return instanceOverridesFor(instance, owner, property).map((override) => ({
        path: override.path.join('.'), segments: override.path, value: override.value
    }));
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
