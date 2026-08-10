export type PropertyKind =
    | 'gradient'
    | 'curve'
    | 'classArray'
    | 'nestedClass'
    | 'assetRef'
    | 'nodeRef'
    | 'componentRef'
    | 'color'
    | 'vec'
    | 'enum'
    | 'bitmask'
    | 'plain';

/** One entry of the editor's component dump (`IProperty`). */
export interface PropertyDescriptor {
    name?: string;
    type?: string;
    value?: unknown;
    default?: unknown;
    isArray?: boolean;
    extends?: string[];
    elementTypeData?: PropertyDescriptor;
    enumList?: unknown[];
    bitmaskList?: unknown[];
    [key: string]: unknown;
}

const GRADIENT_TYPES = ['cc.GradientRange', 'cc.Gradient'];
const CURVE_TYPES = ['cc.CurveRange', 'cc.RealCurve', 'cc.AnimationCurve'];
const VEC_TYPES = ['cc.Vec2', 'cc.Vec3', 'cc.Vec4', 'cc.Quat', 'cc.Size'];

export function isDumpDescriptor(candidate: unknown): candidate is PropertyDescriptor {
    return !!candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        && 'value' in (candidate as Record<string, unknown>);
}

export function isAssetDescriptor(descriptor?: PropertyDescriptor | null): boolean {
    return Array.isArray(descriptor?.extends) && descriptor!.extends!.includes('cc.Asset');
}

export function isNodeDescriptor(descriptor?: PropertyDescriptor | null): boolean {
    return descriptor?.type === 'cc.Node';
}

export function isComponentDescriptor(descriptor?: PropertyDescriptor | null): boolean {
    return Array.isArray(descriptor?.extends) && descriptor!.extends!.includes('cc.Component');
}

/**
 * A serializable class stored inline: its `value` is a map of dump descriptors. cc.Color and the
 * vectors are excluded by that alone — their `value` holds plain numbers.
 */
export function isClassDescriptor(descriptor?: PropertyDescriptor | null): boolean {
    if (!descriptor || descriptor.isArray === true) return false;
    const fields = descriptor.value;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
    const members = Object.values(fields as Record<string, unknown>);
    return members.length > 0 && members.every(member => isDumpDescriptor(member));
}

/**
 * The cascade order carries the answer: a gradient IS a class with a known name, and an array
 * descriptor repeats its element's `extends`, so reading it as a scalar collapses it to one uuid.
 */
export function resolveKind(descriptor?: PropertyDescriptor | null): PropertyKind {
    if (!descriptor || typeof descriptor !== 'object') return 'plain';

    const type = typeof descriptor.type === 'string' ? descriptor.type : '';
    if (GRADIENT_TYPES.includes(type)) return 'gradient';
    if (CURVE_TYPES.includes(type)) return 'curve';

    if (descriptor.isArray === true) {
        if (isClassDescriptor(descriptor.elementTypeData)) return 'classArray';
        return resolveKind(descriptor.elementTypeData || asScalar(descriptor));
    }

    if (isAssetDescriptor(descriptor)) return 'assetRef';
    if (isNodeDescriptor(descriptor)) return 'nodeRef';
    if (isComponentDescriptor(descriptor)) return 'componentRef';
    if (type === 'cc.Color') return 'color';
    if (VEC_TYPES.includes(type)) return 'vec';
    if (type === 'BitMask' || hasEntries(descriptor.bitmaskList)) return 'bitmask';
    if (type === 'Enum' || hasEntries(descriptor.enumList)) return 'enum';
    if (isClassDescriptor(descriptor)) return 'nestedClass';
    return 'plain';
}

function asScalar(descriptor: PropertyDescriptor): PropertyDescriptor {
    return { ...descriptor, isArray: false, value: undefined };
}

function hasEntries(list: unknown): boolean {
    return Array.isArray(list) && list.length > 0;
}
