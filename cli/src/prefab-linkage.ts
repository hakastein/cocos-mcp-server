import type { PrefabLinkageReport } from '@cocos-cli/shared';
import type { Verdict } from './render/verdict.ts';

/** The only asset type whose creation carries a prefab link. */
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
 * `scene:create-node` forwards `type` verbatim and never derives it from the uuid, while the
 * editor's `createNodeFromAsset` strips the PrefabInfo on the branch
 * `('cc.Prefab' !== type || unlinkPrefab)`. A call carrying `assetUuid` alone lands in that branch
 * and gets the flat copy, with nothing said about it.
 *
 * An arbitrary type is not forwarded here: for a type outside its creatable list
 * `createNodeFromAsset` returns no node at all.
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
    verdict: Verdict;
    detail: string;
}

/**
 * `the live node is linked` and `a save carries that link` are two questions: a PrefabInfo the
 * runtime holds and the serializer drops is a link that dies on save. The second question stays
 * unanswered rather than answered `no` when the serializer could not be reached.
 */
export function linkageVerdict(
    linkage: PrefabLinkageReport, assetType: string | null | undefined, unlinkPrefab: boolean
): LinkageVerdict {
    if (!expectsLinkage(assetType, unlinkPrefab)) {
        return {
            verdict: 'ok',
            detail: unlinkPrefab
                ? 'no link by request: --unlink, the node is a flat copy, and prefab edits will not reach it'
                : `no link was expected: the asset is ${assetType || 'of an unknown type'}, not ${PREFAB_ASSET_TYPE}`
        };
    }
    return establishedLinkage(linkage);
}

export function establishedLinkage(linkage: PrefabLinkageReport): LinkageVerdict {
    if (!linkage.linked) {
        return {
            verdict: 'FAILED',
            detail: 'the node was created but carries no PrefabInfo: the scene does not track the asset, '
                + 'the saved scene will hold no _prefab block, and prefab edits will not reach the node. '
                + 'Delete the node and record the gap rather than working with the copy'
        };
    }

    if (!linkage.persistenceChecked) {
        return {
            verdict: 'UNVERIFIED',
            detail: `the live node carries PrefabInfo, unchecked against the saved form (${
                linkage.persistenceReason || 'the serializer is unavailable'})`
        };
    }

    if (!linkage.persisted) {
        return {
            verdict: 'UNPERSISTED',
            detail: 'the live node carries PrefabInfo and the editor serializer does not emit it: saving '
                + 'the scene drops the link, and in the file the node ends up a flat copy'
        };
    }

    return {
        verdict: 'ok',
        detail: `linked to ${linkage.asset || 'an asset the report did not name'}  fileId=${linkage.fileId || 'none'}`
            + `  ${linkage.instanceRoot ? 'instance root' : 'inside an instance'}  persisted=true`
    };
}

export interface PrefabSavePath {
    url: string;
    name: string;
}

export function prefabSavePath(savePath: string, nodeName: string, given?: string): PrefabSavePath {
    const trimmed = savePath.replace(/\/+$/, '');
    if (/\.prefab$/i.test(trimmed)) {
        const base = (trimmed.split('/').pop() || '').replace(/\.prefab$/i, '');
        return { url: trimmed, name: given || base };
    }
    const name = given || nodeName;
    if (!name) throw new Error(`${savePath} is a folder and there is nowhere to take the prefab name from; pass --name`);
    return { url: `${trimmed}/${name}.prefab`, name };
}
