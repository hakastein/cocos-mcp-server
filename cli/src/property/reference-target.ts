import type { PropertyKind } from './kind';

/**
 * Cocos сжимает uuid узла и компонента ровно в 22 знака стандартного base64 (`A-Za-z0-9+/`),
 * а uuid ассета остаётся полным, с дефисами. Имя узла попадает в тот же алфавит и ту же длину,
 * поэтому одной длины мало — та же пара условий, что и в `resolveNode`.
 */
const COMPRESSED_UUID = /^[A-Za-z0-9+/]{22}$/;
const ASSET_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(@[0-9a-fA-F]+)?$/;
const ASSET_URL = 'db://';

export const REFERENCE_KINDS: PropertyKind[] = ['assetRef', 'nodeRef', 'componentRef'];

export function isReferenceKind(kind: PropertyKind): boolean {
    return REFERENCE_KINDS.indexOf(kind) !== -1;
}

/** Какой поиск превращает написание в uuid. */
export type TargetSpelling =
    | { kind: 'uuid'; uuid: string }
    | { kind: 'assetUrl'; url: string }
    | { kind: 'nodePath'; path: string };

export interface ReferenceRequest {
    /** Пусто — каллер попросил очистить поле. */
    targets: TargetSpelling[];
    /** Каллер написал массив; какой формы поле на самом деле, отвечает сцена, а не эта разметка. */
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
    return { error: `ссылка задаётся путём узла, db://-путём ассета или uuid; получено ${JSON.stringify(item)}` };
}

/**
 * Разбор `--value` для ссылочного свойства. Ничего не ищет и ни к чему не обращается: решает
 * только, чем окажется каждое написание, чтобы неразрешимое значение отваливалось до записи, а не
 * после того, как оно уже обнулило слот.
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
