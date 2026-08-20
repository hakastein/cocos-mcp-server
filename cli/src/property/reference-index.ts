import type { SceneNodeEntry } from '@cocos-cli/shared';
import type { PropertyKind } from './kind.ts';
import type { PropertyReading } from './component-dump.ts';

export interface ReferenceLabel {
    kind: 'node' | 'component' | 'asset';
    /** A scene path for a node or a component, a `db://` url for an asset. */
    path: string;
    className?: string;
}

export type ReferenceLookup = (uuid: string) => ReferenceLabel | undefined;

const SCENE_KINDS: PropertyKind[] = ['nodeRef', 'componentRef'];

/**
 * uuid → what it points at, for every node and every component of the open scene. A reference
 * projects to a bare uuid, and a uuid on its own says nothing about what a scene holds; one scene
 * dump buys the names for all of them at once.
 */
export function buildReferenceIndex(nodes: SceneNodeEntry[]): Map<string, ReferenceLabel> {
    const index = new Map<string, ReferenceLabel>();
    for (const node of nodes || []) {
        if (!node || typeof node.uuid !== 'string') continue;
        const path = node.path || node.name || node.uuid;
        index.set(node.uuid, { kind: 'node', path });
        for (const component of node.components || []) {
            if (!component || typeof component.uuid !== 'string') continue;
            index.set(component.uuid, {
                kind: 'component',
                path,
                className: component.className || component.type
            });
        }
    }
    return index;
}

function uuidsOf(value: unknown, into: Set<string>): void {
    if (typeof value === 'string' && value) into.add(value);
    else if (Array.isArray(value)) for (const element of value) uuidsOf(element, into);
}

/** Every uuid the readings point at, split by whether the open scene or the asset database names it. */
export function referencedUuids(readings: PropertyReading[]): { scene: string[]; assets: string[] } {
    const scene = new Set<string>();
    const assets = new Set<string>();
    for (const reading of readings || []) {
        if (SCENE_KINDS.includes(reading.kind)) uuidsOf(reading.value, scene);
        else if (reading.kind === 'assetRef') uuidsOf(reading.value, assets);
    }
    return { scene: [...scene], assets: [...assets] };
}
