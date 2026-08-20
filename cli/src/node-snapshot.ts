import { componentClassNames } from './property/component-dump.ts';
import type { ComponentDump } from './property/component-dump.ts';
import type { Vec3 } from './node-transform.ts';

/** 1 << 30, the value of cc.Layers.Enum.DEFAULT. */
export const LAYER_DEFAULT = 1073741824;

export interface NodeSnapshot {
    uuid: string;
    name: string;
    active: boolean;
    position: Vec3;
    rotation: Vec3;
    scale: Vec3;
    parent: string | null;
    layer: number;
    componentTypes: string[];
}

interface Descriptor {
    value?: unknown;
}

function descriptorValue(holder: Record<string, unknown>, key: string): unknown {
    const descriptor = holder[key] as Descriptor | undefined;
    return descriptor && typeof descriptor === 'object' ? descriptor.value : undefined;
}

function vec3Of(value: unknown, fallback: Vec3): Vec3 {
    if (!value || typeof value !== 'object') return fallback;
    const given = value as Partial<Vec3>;
    return {
        x: typeof given.x === 'number' ? given.x : fallback.x,
        y: typeof given.y === 'number' ? given.y : fallback.y,
        z: typeof given.z === 'number' ? given.z : fallback.z
    };
}

/**
 * The editor's node dump is a map of `{value}` descriptors rather than the node itself, and every
 * field in it is optional. The projection reduces it to what the write commands read, substituting
 * engine defaults where a descriptor is absent.
 */
export function nodeSnapshotOf(raw: unknown, uuid: string): NodeSnapshot | null {
    if (!raw || typeof raw !== 'object') return null;
    const holder = raw as Record<string, unknown>;
    const active = descriptorValue(holder, 'active');
    const layer = descriptorValue(holder, 'layer');
    const parent = descriptorValue(holder, 'parent') as { uuid?: unknown } | undefined;
    const name = descriptorValue(holder, 'name');

    return {
        uuid: (descriptorValue(holder, 'uuid') as string) || uuid,
        name: typeof name === 'string' ? name : '',
        active: typeof active === 'boolean' ? active : true,
        position: vec3Of(descriptorValue(holder, 'position'), { x: 0, y: 0, z: 0 }),
        rotation: vec3Of(descriptorValue(holder, 'rotation'), { x: 0, y: 0, z: 0 }),
        scale: vec3Of(descriptorValue(holder, 'scale'), { x: 1, y: 1, z: 1 }),
        parent: parent && typeof parent.uuid === 'string' ? parent.uuid : null,
        layer: typeof layer === 'number' ? layer : LAYER_DEFAULT,
        componentTypes: componentClassNames((holder.__comps__ as ComponentDump[]) || [])
    };
}

export const NODE_PROPERTIES = ['name', 'active', 'layer'] as const;

export type NodeProperty = typeof NODE_PROPERTIES[number];

export function nodePropertyOf(snapshot: NodeSnapshot, property: NodeProperty): unknown {
    return property === 'name' ? snapshot.name
        : property === 'active' ? snapshot.active
            : snapshot.layer;
}
