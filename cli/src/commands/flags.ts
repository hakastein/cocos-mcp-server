import { parseVec3 } from '../node-transform.ts';
import type { Vec3, Vec3Parts } from '../node-transform.ts';

/**
 * Commander hands every option through as the text that was typed. Turning that text into the value
 * a command works with is the one decision an action body is allowed to make, and it lives here so
 * a test reaches it without Commander.
 */

const AXES: ReadonlyArray<keyof Vec3> = ['x', 'y', 'z'];

export function booleanFlag(flag: string, raw: string | undefined): boolean | undefined {
    if (raw === undefined) return undefined;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${flag} takes true or false; got ${JSON.stringify(raw)}`);
}

export function numberFlag(flag: string, raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    // `Number('')` and `Number(' ')` are 0, so an empty flag would write a value nobody asked for.
    const value = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(value)) {
        throw new Error(`${flag} takes a number; got ${JSON.stringify(raw)}`);
    }
    return value;
}

export function vec3PartsFlag(flag: string, raw: string | undefined): Vec3Parts | undefined {
    if (raw === undefined) return undefined;
    try {
        return parseVec3(raw);
    } catch (error) {
        throw new Error(`${flag}: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A node being created has no previous position, so an empty axis has nothing to keep. */
export function vec3Flag(flag: string, raw: string | undefined): Vec3 | undefined {
    const parts = vec3PartsFlag(flag, raw);
    if (parts === undefined) return undefined;
    const empty = AXES.filter(axis => parts[axis] === undefined);
    if (empty.length) {
        throw new Error(`${flag} takes all three axes as x,y,z; ${empty.join(' and ')} left empty in ${
            JSON.stringify(raw)}`);
    }
    return parts as Vec3;
}

/** JSON where the text parses as JSON, and the text itself where it does not: `--value Ready` is a
 * string, `--value 3` is a number. */
export function jsonFlag(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}
