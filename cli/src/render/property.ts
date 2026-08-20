import type { PropertyKind } from '../property/kind';
import type { PropertyReading } from '../property/component-dump';
import type { ReferenceLookup } from '../property/reference-index';

const EMPTY = '(empty)';
const TYPE_COLUMN_LIMIT = 22;

const AXIS_ORDER = ['x', 'y', 'z', 'w', 'width', 'height'];

function formatReference(uuid: unknown, lookup: ReferenceLookup): string {
    if (typeof uuid !== 'string' || !uuid) return EMPTY;
    const label = lookup(uuid);
    if (!label) return uuid;
    const named = label.kind === 'component' && label.className
        ? `${label.className} on ${label.path}`
        : label.path;
    return `${named}  ${uuid}`;
}

function formatColor(value: unknown): string {
    if (!value || typeof value !== 'object') return EMPTY;
    const channels = value as Record<string, number>;
    const hex = (channel: number) => Math.round(channel).toString(16).padStart(2, '0');
    return `#${hex(channels.r)}${hex(channels.g)}${hex(channels.b)}${hex(channels.a)}`;
}

function formatVec(value: unknown): string {
    if (!value || typeof value !== 'object') return EMPTY;
    const axes = value as Record<string, number>;
    const names = Object.keys(axes)
        .sort((a, b) => AXIS_ORDER.indexOf(a) - AXIS_ORDER.indexOf(b));
    return `(${names.map(axis => axes[axis]).join(', ')})`;
}

function formatScalar(value: unknown): string {
    if (value === null || value === undefined) return EMPTY;
    if (typeof value === 'string') return value ? JSON.stringify(value) : '""';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
}

function formatByKind(kind: PropertyKind, value: unknown, label: string | null, lookup: ReferenceLookup): string {
    if (Array.isArray(value)) {
        return value.length
            ? `[${value.map(element => formatByKind(kind, element, null, lookup)).join(', ')}]`
            : '[]';
    }
    switch (kind) {
        case 'assetRef':
        case 'nodeRef':
        case 'componentRef':
            return formatReference(value, lookup);
        case 'color':
            return formatColor(value);
        case 'vec':
            return formatVec(value);
        case 'enum':
        case 'bitmask':
            return label ? `${formatScalar(value)} (${label})` : formatScalar(value);
        default:
            return formatScalar(value);
    }
}

export function formatReading(reading: PropertyReading, lookup: ReferenceLookup): string {
    return formatByKind(reading.kind, reading.value, reading.label, lookup);
}

/**
 * One line per property: name, declared type, value. The star marks a value that drifted from the
 * default — that is the one lost silently when a property is moved between classes.
 */
export function renderComponentReading(readings: PropertyReading[], lookup: ReferenceLookup): string {
    if (!readings.length) return 'the component has no readable properties';

    const nameColumn = Math.max(...readings.map(reading => reading.name.length));
    const typeColumn = Math.min(
        TYPE_COLUMN_LIMIT, Math.max(...readings.map(reading => reading.type.length)));

    return readings
        .map(reading => [
            reading.name.padEnd(nameColumn),
            reading.type.padEnd(typeColumn),
            reading.differsFromDefault === true ? '*' : ' ',
            formatReading(reading, lookup)
        ].join('  '))
        .join('\n');
}
