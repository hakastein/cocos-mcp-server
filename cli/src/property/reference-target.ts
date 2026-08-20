import type { PropertyKind } from './kind.ts';

/**
 * Cocos compresses a node or component uuid to exactly 22 chars of standard base64 (`A-Za-z0-9+/`),
 * while an asset uuid stays full, with dashes. A node name lands in that same alphabet and length,
 * so length alone is not enough — the same pair of conditions as in `resolveNode`.
 */
const COMPRESSED_UUID = /^[A-Za-z0-9+/]{22}$/;
const ASSET_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(@[0-9a-fA-F]+)?$/;
const ASSET_URL = 'db://';

export const REFERENCE_KINDS: PropertyKind[] = ['assetRef', 'nodeRef', 'componentRef'];

export function isReferenceKind(kind: PropertyKind): boolean {
    return REFERENCE_KINDS.indexOf(kind) !== -1;
}

export type TargetSpelling =
    | { kind: 'uuid'; uuid: string }
    | { kind: 'assetUrl'; url: string }
    | { kind: 'nodePath'; path: string };

export interface ReferenceRequest {
    /** Empty means the caller asked for the field to be cleared. */
    targets: TargetSpelling[];
    /** The caller wrote an array; what shape the field actually has is the scene's answer, not this parse's. */
    array: boolean;
}

export function spellingOf(text: string): TargetSpelling {
    if (text.indexOf(ASSET_URL) === 0) return { kind: 'assetUrl', url: text };
    if (ASSET_UUID.test(text)) return { kind: 'uuid', uuid: text };
    if (COMPRESSED_UUID.test(text) && text.indexOf('/') === -1) return { kind: 'uuid', uuid: text };
    return { kind: 'nodePath', path: text };
}

function targetOf(item: unknown): TargetSpelling | { error: string } {
    if (typeof item === 'string' && item) return spellingOf(item);
    if (item && typeof item === 'object') {
        const holder = item as { uuid?: unknown; __uuid__?: unknown };
        const uuid = typeof holder.uuid === 'string' ? holder.uuid : holder.__uuid__;
        if (typeof uuid === 'string' && uuid) return { kind: 'uuid', uuid };
    }
    return { error: `a reference is spelled as a node path, an asset db:// url or a uuid; got ${JSON.stringify(item)}` };
}

/**
 * Parses `--value` for a reference property. It looks nothing up and reaches nothing: it decides
 * only what each spelling will turn out to be, so an unresolvable value is refused before the write
 * rather than after it has already emptied the slot.
 */
export function referenceRequest(value: unknown): ReferenceRequest | { error: string } {
    if (value === null || value === undefined || value === '') return { targets: [], array: false };
    if (Array.isArray(value)) {
        const targets: TargetSpelling[] = [];
        for (const item of value) {
            const target = targetOf(item);
            if ('error' in target) return target;
            targets.push(target);
        }
        return { targets, array: true };
    }
    const target = targetOf(value);
    return 'error' in target ? target : { targets: [target], array: false };
}
