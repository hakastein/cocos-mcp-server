import { isDumpDescriptor, resolveKind } from './kind.ts';
import type { PropertyDescriptor, PropertyKind } from './kind.ts';
import { projectValue } from './readers.ts';
import { readBackMatches } from './writers.ts';

/** One `__comps__` entry of the editor's node dump: the component shell plus its property map. */
export interface ComponentDump {
    type?: unknown;
    cid?: unknown;
    __type__?: unknown;
    value?: Record<string, unknown>;
}

export interface ComponentChoice {
    index: number;
    /** The name the class is REGISTERED under — `cc.Camera`, `GameBootstrap` — never the typed spelling. */
    className: string;
    cid: string | null;
    enabled: boolean | null;
    /** How many components of this class the node carries; the reading answers about the first. */
    sameClassCount: number;
}

export interface PropertyReading {
    name: string;
    type: string;
    kind: PropertyKind;
    /** Projected the same way a write's read-back is, so both sides of a comparison are shaped alike. */
    value: unknown;
    /** Enum/bitmask member name for `value`, when the dump names one. */
    label: string | null;
    /**
     * Whether the value diverges from the declared default: `null` when the dump carries no default
     * comparable as a scalar — the class kind of default (a colour, a nested class) arrives as its own
     * descriptor tree, and reading it as a value would invent a verdict.
     */
    differsFromDefault: boolean | null;
    /** The inspector does not draw it; the scene file still carries it. */
    hiddenInInspector: boolean;
}

export interface ComponentReading {
    readings: PropertyReading[];
    /** Names left out of `readings`, every one of them still reachable by name. */
    hidden: string[];
}

const CC_PREFIX = 'cc.';

/**
 * Fields the editor injects into every component dump. They answer about the component's identity
 * rather than about anything authored on it, and `enabled` is carried by the reading's own header.
 */
const CHROME = ['uuid', 'name', '_name', '_objFlags', 'node', '__scriptAsset', 'enabled', '_enabled'];

function spellings(typed: string): string[] {
    const bare = typed.indexOf(CC_PREFIX) === 0 ? typed.slice(CC_PREFIX.length) : typed;
    return typed === bare ? [bare, `${CC_PREFIX}${bare}`] : [typed, bare];
}

function markers(component: ComponentDump, order: unknown[]): string[] {
    return order.filter((marker): marker is string => typeof marker === 'string' && !!marker);
}

/** Every spelling the dump names the class by, the one fit to print first. */
function classMarkers(component: ComponentDump): string[] {
    return markers(component, [component.type, component.__type__, component.cid]);
}

function classNameOf(component: ComponentDump): string {
    return classMarkers(component)[0] || 'Unknown';
}

/** The class id `serializedComponentValue` matches a live component's constructor against. */
export function componentCid(component: ComponentDump): string | null {
    return markers(component, [component.__type__, component.cid, component.type])[0] || null;
}

export function componentClassNames(components: ComponentDump[]): string[] {
    return (components || []).map(classNameOf);
}

function enabledOf(component: ComponentDump): boolean | null {
    const descriptor = component.value && component.value.enabled;
    if (!isDumpDescriptor(descriptor)) return null;
    return typeof descriptor.value === 'boolean' ? descriptor.value : null;
}

/**
 * The dump names a component by its REGISTERED class, so an engine component answers to `cc.Camera`
 * and never to `Camera` — the spelling a caller types. Both are tried, the caller's own first, which
 * is what keeps `cc.Sprite` and a user class named `Sprite` distinguishable when a node carries both.
 */
export function selectComponent(components: ComponentDump[], typed: string): ComponentChoice | null {
    const all = components || [];
    for (const spelling of spellings(typed)) {
        const matches = all
            .map((component, index) => ({ component, index }))
            .filter(entry => classMarkers(entry.component).includes(spelling));
        if (!matches.length) continue;
        const first = matches[0];
        return {
            index: first.index,
            className: classNameOf(first.component),
            cid: componentCid(first.component),
            enabled: enabledOf(first.component),
            sameClassCount: matches.length
        };
    }
    return null;
}

function enumLabel(descriptor: PropertyDescriptor, value: unknown): string | null {
    const list = Array.isArray(descriptor.enumList) ? descriptor.enumList : descriptor.bitmaskList;
    if (!Array.isArray(list) || typeof value !== 'number') return null;
    const named = list.filter((entry): entry is { name: string; value: number } =>
        !!entry && typeof entry === 'object'
        && typeof (entry as { name?: unknown }).name === 'string'
        && typeof (entry as { value?: unknown }).value === 'number');

    const exact = named.find(entry => entry.value === value);
    if (exact) return exact.name;

    // A bitmask value is a sum of members, and only a member with bits actually set is part of it;
    // a zero-valued member is in every sum by arithmetic and in none of them by meaning.
    const flags = named.filter(entry => entry.value !== 0 && (value & entry.value) === entry.value);
    return flags.length ? flags.map(entry => entry.name).join('|') : null;
}

/**
 * The declared default, when the dump states one as a plain scalar. A class default (a colour, a
 * nested `@ccclass`) arrives as a descriptor tree rather than a value, and `null` says so.
 */
function defaultComparison(descriptor: PropertyDescriptor, projected: unknown): boolean | null {
    if (!('default' in descriptor)) return null;
    const declared = descriptor.default;
    if (declared !== null && typeof declared === 'object') return null;
    if (declared === undefined) return null;
    return !readBackMatches(declared === null ? null : declared, projected)
        || !readBackMatches(projected, declared === null ? null : declared);
}

function readDescriptor(name: string, descriptor: PropertyDescriptor): PropertyReading {
    const kind = resolveKind(descriptor);
    const value = projectValue(kind, descriptor.value);
    return {
        name,
        type: typeof descriptor.type === 'string' ? descriptor.type : '',
        kind,
        value,
        label: enumLabel(descriptor, value),
        differsFromDefault: defaultComparison(descriptor, value),
        hiddenInInspector: descriptor.visible === false
    };
}

/**
 * Whether `_x` is the storage behind an accessor `x` that the same dump already carries with an
 * equal value. Collapsing that pair drops a duplicate; a pair whose values differ is left alone,
 * since which of the two a save writes is then a real question.
 */
function isCollapsedBacking(name: string, values: Record<string, unknown>): boolean {
    if (name.charAt(0) !== '_') return false;
    const accessor = values[name.slice(1)];
    const backing = values[name];
    if (!isDumpDescriptor(accessor) || !isDumpDescriptor(backing)) return false;
    const front = projectValue(resolveKind(accessor), accessor.value);
    const behind = projectValue(resolveKind(backing), backing.value);
    return readBackMatches(front, behind) && readBackMatches(behind, front);
}

export function readComponentProperties(component: ComponentDump): ComponentReading {
    const values = component.value || {};
    const readings: PropertyReading[] = [];
    const hidden: string[] = [];
    for (const [name, descriptor] of Object.entries(values)) {
        if (!isDumpDescriptor(descriptor)) continue;
        if (CHROME.includes(name) || isCollapsedBacking(name, values)) {
            hidden.push(name);
            continue;
        }
        readings.push(readDescriptor(name, descriptor));
    }
    return { readings, hidden };
}

/** The dump entry under exactly this name — what a write needs, since it writes to that path. */
export function descriptorOf(component: ComponentDump, property: string): PropertyDescriptor | null {
    const descriptor = (component.value || {})[property];
    return isDumpDescriptor(descriptor) ? descriptor : null;
}

/**
 * One property by name, chrome and collapsed storage fields included — asking for a name is asking
 * about that name. The serializer writes backing fields, so `color` also answers from `_color` when
 * the accessor itself is absent, the same fallback `commands/component.ts` reads a written value by.
 */
export function findProperty(component: ComponentDump, property: string): PropertyReading | null {
    const underscored = property.replace(/(^|\.)([^.]+)$/, '$1_$2');
    const candidates = underscored === property || /(^|\.)_/.test(property)
        ? [property]
        : [property, underscored];
    for (const name of candidates) {
        const descriptor = descriptorOf(component, name);
        if (descriptor) return readDescriptor(name, descriptor);
    }
    return null;
}

export function propertyNames(component: ComponentDump): string[] {
    return Object.entries(component.value || {})
        .filter(([, descriptor]) => isDumpDescriptor(descriptor))
        .map(([name]) => name);
}
