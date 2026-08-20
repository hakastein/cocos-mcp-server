import type { NodeType } from './node-type';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** An axis a write does not name keeps its value — hence the partiality. */
export type Vec3Parts = Partial<Vec3>;

export type TransformKind = 'position' | 'rotation' | 'scale';

export const TRANSFORM_KINDS: readonly TransformKind[] = ['position', 'rotation', 'scale'];

const AXES: ReadonlyArray<keyof Vec3> = ['x', 'y', 'z'];

/**
 * `1,2,3` is all three axes; `1,,3` keeps y as it was. An empty axis and an axis set to zero are two
 * different orders, and `Number('')`, which gives 0, would glue them into one.
 */
export function parseVec3(text: string): Vec3Parts {
    const parts = String(text).split(',');
    if (parts.length !== 3) {
        throw new Error(`a vector is spelled x,y,z; got ${JSON.stringify(text)}`);
    }
    const parsed: Vec3Parts = {};
    parts.forEach((part, index) => {
        const trimmed = part.trim();
        if (trimmed === '') return;
        const value = Number(trimmed);
        if (!Number.isFinite(value)) {
            throw new Error(`axis ${AXES[index]} in ${JSON.stringify(text)} is not a number`);
        }
        parsed[AXES[index]] = value;
    });
    return parsed;
}

const EPSILON = 0.001;

export function sameVec3(observed: Vec3, expected: Vec3): boolean {
    return Math.abs(observed.x - expected.x) < EPSILON
        && Math.abs(observed.y - expected.y) < EPSILON
        && Math.abs(observed.z - expected.z) < EPSILON;
}

export interface NormalizedTransform {
    value: Vec3;
    /** An axis the write zeroed past the caller's intent: a 2D node has no other transform. */
    warning?: string;
}

/**
 * On a 2D node a position write zeroes z and a rotation write zeroes x and y, whether or not they
 * were named. A zeroing that changed a value is said out loud: a transform quietly ruined looks
 * exactly like a write that landed.
 */
export function normalizedTransform(
    given: Vec3Parts, current: Vec3, kind: TransformKind, nodeType: NodeType
): NormalizedTransform {
    const value: Vec3 = {
        x: given.x !== undefined ? given.x : current.x,
        y: given.y !== undefined ? given.y : current.y,
        z: given.z !== undefined ? given.z : current.z
    };
    if (nodeType !== '2d') return { value };

    if (kind === 'position') {
        const had = value.z;
        value.z = 0;
        if (given.z !== undefined && Math.abs(given.z) > EPSILON) {
            return { value, warning: `2D node: position z (${given.z}) is not applied, 0 is set instead` };
        }
        if (Math.abs(had) > EPSILON) {
            return { value, warning: `2D node: position z was ${had} and this write zeroes it` };
        }
        return { value };
    }

    if (kind === 'rotation') {
        const had = { x: value.x, y: value.y };
        value.x = 0;
        value.y = 0;
        if ((given.x !== undefined && Math.abs(given.x) > EPSILON)
            || (given.y !== undefined && Math.abs(given.y) > EPSILON)) {
            return { value, warning: '2D node: rotation x,y are not applied, only z works' };
        }
        if (Math.abs(had.x) > EPSILON || Math.abs(had.y) > EPSILON) {
            return {
                value,
                warning: `2D node: rotation x,y were (${had.x}, ${had.y}) and this write zeroes them`
            };
        }
        return { value };
    }

    return { value };
}
