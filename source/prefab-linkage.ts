/**
 * Prefab linkage — what separates an INSTANCE of a prefab asset in a scene from a flattened
 * copy of the same node tree.
 *
 * The editor's own `cce.Node.createNodeFromAsset` strips the PrefabInfo off the node it just
 * instantiated unless it is told what the asset is. Its branch, decompiled from 3.8.8:
 *
 *     ('cc.Prefab' !== type || unlinkPrefab) && cce.Prefab.removePrefabInfoFromNode(node)
 *
 * `scene:create-node` forwards `type` verbatim and never derives it from the uuid, so a caller
 * that sends `assetUuid` alone lands in the `type === undefined` arm and gets the unlinked copy.
 * Hierarchy drag-and-drop passes the asset's real type, which is why hand-placed instances link
 * and every instance this bridge made did not.
 *
 * Nothing announced it. The node tree was right, the components were right, and only
 * `node._prefab` — plus the `_prefab` block missing from the saved scene — said the scene had
 * stopped tracking the asset, so edits to the prefab silently stopped propagating.
 *
 * Linkage is therefore reported, never assumed, and reported from two places: the live node, and
 * what the editor's serializer emits for it. They can disagree — a PrefabInfo the runtime holds
 * but the serializer drops is a link that dies on save — and a single boolean cannot say which
 * of the two failed.
 */

/** The only asset type whose instantiation carries prefab linkage. */
export const PREFAB_ASSET_TYPE = 'cc.Prefab';

/** Reported when linkage was expected and the live node does not carry it. */
export const LINKAGE_WARNING = 'prefab-linkage-not-established';

/** What the scene script answers about one freshly created node. */
export interface PrefabLinkage {
    /** The live node carries a PrefabInfo. */
    linked: boolean;
    /** Asset uuid the PrefabInfo points at. */
    asset: string | null;
    fileId: string | null;
    /** The PrefabInfo carries a PrefabInstance, i.e. this node is an instance ROOT. */
    instanceRoot: boolean;
    /** The serializer ran; false means no evidence either way, not a failure. */
    persistenceChecked: boolean;
    /** The serializer emits a `cc.PrefabInfo` for this node. */
    persisted: boolean;
    /** Asset uuid in the serialized PrefabInfo. */
    persistedAsset: string | null;
    /** Why the serializer verdict is missing, when `persistenceChecked` is false. */
    persistenceReason?: string;
}

export const UNVERIFIED_LINKAGE: PrefabLinkage = {
    linked: false, asset: null, fileId: null, instanceRoot: false,
    persistenceChecked: false, persisted: false, persistedAsset: null,
    persistenceReason: 'scene script unavailable'
};

/**
 * Add the options that decide linkage to a `scene:create-node` payload.
 *
 * `type` is passed only for `cc.Prefab`. That is the only value the editor's branch reads, and
 * `createNodeFromAsset` refuses outright — returning no node at all — for a `type` outside its
 * creatable list, so forwarding an arbitrary asset type would turn assets that instantiate today
 * into silent no-ops.
 */
export function applyLinkageOptions(
    options: Record<string, any>,
    assetType: string | null | undefined,
    unlinkPrefab: boolean
): Record<string, any> {
    if (assetType === PREFAB_ASSET_TYPE) {
        options.type = PREFAB_ASSET_TYPE;
    }
    if (unlinkPrefab) {
        options.unlinkPrefab = true;
    }
    return options;
}

/** Whether this creation should produce a linked instance, and therefore be judged on one. */
export function expectsLinkage(assetType: string | null | undefined, unlinkPrefab: boolean): boolean {
    return assetType === PREFAB_ASSET_TYPE && !unlinkPrefab;
}

/**
 * The asset type `scene:create-node` must be told, resolved for the uuid actually being
 * instantiated — a model's `gltf-scene` sub-asset reports `cc.Prefab` just as a plain `.prefab`
 * does, so both link through the same path.
 */
export async function queryAssetType(assetUuid: string): Promise<string | null> {
    try {
        const info: any = await Editor.Message.request('asset-db', 'query-asset-info', assetUuid);
        return (info && info.type) || null;
    } catch {
        return null;
    }
}

/**
 * Ask the scene process what linkage the node ended up with. Any failure degrades to "not linked,
 * not checked" so a caller reports an honest unknown rather than a false positive.
 */
export async function verifyPrefabLinkage(nodeUuid: string): Promise<PrefabLinkage> {
    try {
        const res: any = await Editor.Message.request('scene', 'execute-scene-script', {
            name: 'cocos-mcp-server',
            method: 'nodePrefabLinkage',
            args: [nodeUuid]
        });
        if (res && res.success && res.data) {
            return { ...UNVERIFIED_LINKAGE, ...res.data } as PrefabLinkage;
        }
        return { ...UNVERIFIED_LINKAGE, persistenceReason: res?.error || 'scene script returned nothing' };
    } catch (err: any) {
        return { ...UNVERIFIED_LINKAGE, persistenceReason: err?.message || String(err) };
    }
}

/** The linkage verdict as it appears in a tool result. */
export interface LinkageVerdict {
    /** The creation is a failure: linkage was asked for and the evidence says it is absent. */
    failed: boolean;
    fields: Record<string, any>;
}

/**
 * Turn the two observations into what the caller sees. `prefabLinked` is the live node;
 * `prefabLinkagePersisted` is the separate question of whether a save keeps it, left `false`
 * with a note whenever the serializer could not be reached rather than folded into the first.
 */
export function linkageVerdict(
    linkage: PrefabLinkage,
    assetType: string | null | undefined,
    unlinkPrefab: boolean
): LinkageVerdict {
    if (!expectsLinkage(assetType, unlinkPrefab)) {
        const reason = unlinkPrefab
            ? 'unlinkPrefab was requested, so the node is a flat copy by design and edits to the '
              + 'prefab asset will not propagate to it.'
            : `the asset is ${assetType || 'of an unknown type'}, not ${PREFAB_ASSET_TYPE}, and only `
              + 'prefab assets carry linkage.';
        return {
            failed: false,
            fields: {
                prefabLinked: linkage.linked,
                prefabLinkagePersisted: linkage.persisted,
                prefabLinkageNote: `No prefab linkage was expected: ${reason}`
            }
        };
    }

    if (!linkage.linked) {
        return {
            failed: true,
            fields: {
                prefabLinked: false,
                prefabLinkagePersisted: false,
                warning: LINKAGE_WARNING,
                prefabLinkageNote: 'The node was created but carries NO PrefabInfo, so the scene does '
                    + 'not track the prefab asset, the saved scene will hold no `_prefab` block, and '
                    + 'later edits to the prefab will NOT propagate to this node. Delete the node and '
                    + 'report the gap rather than working with the copy.'
            }
        };
    }

    if (!linkage.persistenceChecked) {
        return {
            failed: false,
            fields: {
                prefabLinked: true,
                prefabAsset: linkage.asset,
                prefabInstanceRoot: linkage.instanceRoot,
                prefabLinkagePersisted: false,
                prefabLinkageNote: 'The live node carries a PrefabInfo, which was NOT confirmed against '
                    + `the saved form (${linkage.persistenceReason || 'serializer unavailable'}). `
                    + 'Linkage on the live node does not prove it survives a save.'
            }
        };
    }

    if (!linkage.persisted) {
        return {
            failed: true,
            fields: {
                prefabLinked: true,
                prefabAsset: linkage.asset,
                prefabInstanceRoot: linkage.instanceRoot,
                prefabLinkagePersisted: false,
                warning: LINKAGE_WARNING,
                prefabLinkageNote: 'The live node carries a PrefabInfo but the editor\'s serializer does '
                    + 'not emit one for it, so saving the scene drops the link. The node in the saved '
                    + 'scene will be a flat copy.'
            }
        };
    }

    return {
        failed: false,
        fields: {
            prefabLinked: true,
            prefabAsset: linkage.asset,
            prefabFileId: linkage.fileId,
            prefabInstanceRoot: linkage.instanceRoot,
            prefabLinkagePersisted: true,
            persistedPrefabAsset: linkage.persistedAsset
        }
    };
}
