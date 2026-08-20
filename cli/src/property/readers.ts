import { isDumpDescriptor, resolveKind } from './kind.ts';
import type { PropertyDescriptor, PropertyKind } from './kind.ts';

export function projectDescriptor(descriptor?: PropertyDescriptor | null): unknown {
    if (!descriptor || typeof descriptor !== 'object') return null;
    return projectValue(resolveKind(descriptor), descriptor.value);
}

export function projectValue(kind: PropertyKind, dumpValue: unknown): unknown {
    if (Array.isArray(dumpValue) && kind !== 'classArray') {
        return dumpValue.map(item => projectValue(kind, isDumpDescriptor(item) ? item.value : item));
    }
    switch (kind) {
        case 'assetRef':
        case 'nodeRef':
        case 'componentRef':
            return uuidOf(dumpValue);
        case 'color':
            return colorOf(dumpValue);
        case 'vec':
            return vecOf(dumpValue);
        case 'enum':
        case 'bitmask':
            return numberOf(dumpValue);
        case 'classArray':
            return elementsOf(dumpValue);
        case 'gradient':
        case 'curve':
        case 'nestedClass':
            return membersOf(dumpValue);
        default:
            return dumpValue === undefined ? null : dumpValue;
    }
}

function uuidOf(dumpValue: unknown): string | null {
    if (typeof dumpValue === 'string') return dumpValue || null;
    if (dumpValue && typeof dumpValue === 'object') {
        const holder = dumpValue as { uuid?: unknown; __uuid__?: unknown };
        if (typeof holder.uuid === 'string') return holder.uuid || null;
        if (typeof holder.__uuid__ === 'string') return holder.__uuid__ || null;
    }
    return null;
}

function colorOf(dumpValue: unknown): { r: number; g: number; b: number; a: number } | null {
    if (!dumpValue || typeof dumpValue !== 'object') return null;
    const channels = dumpValue as Record<string, unknown>;
    const clamp = (channel: unknown) => Math.min(255, Math.max(0, Number(channel) || 0));
    return {
        r: clamp(channels.r),
        g: clamp(channels.g),
        b: clamp(channels.b),
        a: channels.a === undefined ? 255 : clamp(channels.a)
    };
}

function vecOf(dumpValue: unknown): Record<string, number> | null {
    if (!dumpValue || typeof dumpValue !== 'object') return null;
    const axes: Record<string, number> = {};
    for (const [axis, magnitude] of Object.entries(dumpValue as Record<string, unknown>)) {
        const value = Number(magnitude);
        axes[axis] = Number.isFinite(value) ? value : 0;
    }
    return axes;
}

function numberOf(dumpValue: unknown): unknown {
    if (dumpValue === null || dumpValue === undefined) return null;
    const value = Number(dumpValue);
    return Number.isFinite(value) ? value : dumpValue;
}

function membersOf(dumpValue: unknown): unknown {
    if (!dumpValue || typeof dumpValue !== 'object' || Array.isArray(dumpValue)) return dumpValue;
    const members: Record<string, unknown> = {};
    for (const [name, member] of Object.entries(dumpValue as Record<string, unknown>)) {
        members[name] = isDumpDescriptor(member) ? projectDescriptor(member) : member;
    }
    return members;
}

function elementsOf(dumpValue: unknown): unknown {
    if (!Array.isArray(dumpValue)) return membersOf(dumpValue);
    return dumpValue.map(element => (isDumpDescriptor(element) ? projectDescriptor(element) : element));
}
