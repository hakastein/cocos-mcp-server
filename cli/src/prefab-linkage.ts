import type { PrefabLinkageReport } from '@cocos-cli/shared';

/** Единственный тип ассета, чьё создание несёт префаб-связь. */
export const PREFAB_ASSET_TYPE = 'cc.Prefab';

export interface CreateNodeOptions {
    assetUuid: string;
    type?: string;
    unlinkPrefab?: boolean;
    parent?: string;
    name?: string;
    dump?: unknown;
}

/**
 * `scene:create-node` передаёт `type` дословно и никогда не выводит его из uuid, а редакторский
 * `createNodeFromAsset` снимает PrefabInfo на ветке `('cc.Prefab' !== type || unlinkPrefab)`. Вызов
 * с одним `assetUuid` попадает в эту ветку и получает расплющенную копию, о чём ничто не сообщает.
 *
 * Произвольный тип сюда не пересылается: `createNodeFromAsset` для типа вне своего списка
 * создаваемых не возвращает узла вовсе.
 */
export function applyLinkageOptions(
    options: CreateNodeOptions, assetType: string | null | undefined, unlinkPrefab: boolean
): CreateNodeOptions {
    if (assetType === PREFAB_ASSET_TYPE) options.type = PREFAB_ASSET_TYPE;
    if (unlinkPrefab) options.unlinkPrefab = true;
    return options;
}

export function expectsLinkage(assetType: string | null | undefined, unlinkPrefab: boolean): boolean {
    return assetType === PREFAB_ASSET_TYPE && !unlinkPrefab;
}

export interface LinkageVerdict {
    failed: boolean;
    /** Первое слово строки отчёта. */
    head: string;
    detail: string;
}

/**
 * «Живой узел связан» и «сохранение эту связь донесёт» — разные вопросы: PrefabInfo, который держит
 * рантайм, а сериализатор выбрасывает, это связь, умирающая на сохранении. Второй вопрос остаётся
 * неотвеченным, а не отвеченным «нет», когда до сериализатора не достучались.
 */
export function linkageVerdict(
    linkage: PrefabLinkageReport, assetType: string | null | undefined, unlinkPrefab: boolean
): LinkageVerdict {
    if (!expectsLinkage(assetType, unlinkPrefab)) {
        return {
            failed: false,
            head: 'ok',
            detail: unlinkPrefab
                ? 'связи нет по заказу: --unlink, узел — плоская копия, правки префаба до неё не дойдут'
                : `связи не ожидалось: ассет ${assetType || 'неизвестного типа'}, а не ${PREFAB_ASSET_TYPE}`
        };
    }

    if (!linkage.linked) {
        return {
            failed: true,
            head: 'НЕ СВЯЗАН',
            detail: 'узел создан, но PrefabInfo на нём нет: сцена за ассетом не следит, в сохранённой '
                + 'сцене блока _prefab не будет, правки префаба до узла не дойдут. Удали узел и заведи '
                + 'запись о пробеле, а не работай с копией'
        };
    }

    if (!linkage.persistenceChecked) {
        return {
            failed: false,
            head: 'СВЯЗАН, НЕ ПРОВЕРЕНО',
            detail: `PrefabInfo на живом узле есть, против сохранённой формы не сверено (${
                linkage.persistenceReason || 'сериализатор недоступен'})`
        };
    }

    if (!linkage.persisted) {
        return {
            failed: true,
            head: 'СВЯЗЬ НЕ СОХРАНИТСЯ',
            detail: 'PrefabInfo на живом узле есть, а сериализатор редактора его не выдаёт: сохранение '
                + 'сцены связь уронит, и в файле узел окажется плоской копией'
        };
    }

    return {
        failed: false,
        head: 'ok',
        detail: `связан с ${linkage.asset || 'ассетом'}  fileId=${linkage.fileId || 'нет'}`
            + `  ${linkage.instanceRoot ? 'корень инстанса' : 'внутри инстанса'}  persisted=true`
    };
}

export interface PrefabSavePath {
    url: string;
    name: string;
}

/** `savePath` принимается и полным адресом `.prefab`, и папкой. */
export function prefabSavePath(savePath: string, nodeName: string, given?: string): PrefabSavePath {
    const trimmed = savePath.replace(/\/+$/, '');
    if (/\.prefab$/i.test(trimmed)) {
        const base = (trimmed.split('/').pop() || '').replace(/\.prefab$/i, '');
        return { url: trimmed, name: given || base };
    }
    const name = given || nodeName;
    if (!name) throw new Error(`${savePath} — папка, а имя префаба взять неоткуда; задай --name`);
    return { url: `${trimmed}/${name}.prefab`, name };
}
