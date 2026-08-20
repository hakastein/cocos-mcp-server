import type { NodeType } from './node-type';

export interface Vec3 {
    x: number;
    y: number;
    z: number;
}

/** Ось, которой в записи не назвали, остаётся такой, какая есть, — отсюда частичность. */
export type Vec3Parts = Partial<Vec3>;

export type TransformKind = 'position' | 'rotation' | 'scale';

export const TRANSFORM_KINDS: readonly TransformKind[] = ['position', 'rotation', 'scale'];

const AXES: ReadonlyArray<keyof Vec3> = ['x', 'y', 'z'];

/**
 * `1,2,3` — все три оси; `1,,3` — y остаётся, каким был. Пустая ось и ось, заданная нулём, — разные
 * приказы, и `Number('')`, дающий 0, склеил бы их в один.
 */
export function parseVec3(text: string): Vec3Parts {
    const parts = String(text).split(',');
    if (parts.length !== 3) {
        throw new Error(`вектор задаётся как x,y,z; получено ${JSON.stringify(text)}`);
    }
    const parsed: Vec3Parts = {};
    parts.forEach((part, index) => {
        const trimmed = part.trim();
        if (trimmed === '') return;
        const value = Number(trimmed);
        if (!Number.isFinite(value)) {
            throw new Error(`ось ${AXES[index]} в ${JSON.stringify(text)} — не число`);
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
    /** Ось, которую запись обнулила помимо воли каллера: у 2D-узла другого трансформа нет. */
    warning?: string;
}

/**
 * У 2D-узла запись позиции обнуляет z, а запись поворота — x и y, независимо от того, назвали их
 * или нет. Обнуление, изменившее значение, называется вслух: молча испорченный трансформ выглядит
 * как удавшаяся запись.
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
            return { value, warning: `2D-узел: z позиции (${given.z}) не применяется, ставится 0` };
        }
        if (Math.abs(had) > EPSILON) {
            return { value, warning: `2D-узел: z позиции был ${had} и этой записью обнуляется` };
        }
        return { value };
    }

    if (kind === 'rotation') {
        const had = { x: value.x, y: value.y };
        value.x = 0;
        value.y = 0;
        if ((given.x !== undefined && Math.abs(given.x) > EPSILON)
            || (given.y !== undefined && Math.abs(given.y) > EPSILON)) {
            return { value, warning: '2D-узел: x,y поворота не применяются, работает только z' };
        }
        if (Math.abs(had.x) > EPSILON || Math.abs(had.y) > EPSILON) {
            return {
                value,
                warning: `2D-узел: x,y поворота были (${had.x}, ${had.y}) и этой записью обнуляются`
            };
        }
        return { value };
    }

    return { value };
}
