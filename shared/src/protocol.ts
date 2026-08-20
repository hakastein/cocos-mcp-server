export const EDITOR_METHODS = [
    'scene.querySceneReady', 'scene.queryDirty', 'scene.queryNodeTree', 'scene.queryNode',
    'scene.createNode', 'scene.removeNode', 'scene.duplicateNode', 'scene.setParent',
    'scene.setProperty', 'scene.resetProperty', 'scene.resetNode', 'scene.resetComponent',
    'scene.moveArrayElement', 'scene.removeArrayElement', 'scene.queryClasses',
    'scene.queryComponents', 'scene.queryNodesByAssetUuid', 'scene.createComponent',
    'scene.removeComponent', 'scene.executeComponentMethod', 'scene.copyNode', 'scene.cutNode',
    'scene.pasteNode', 'scene.openScene', 'scene.queryCurrentScene', 'scene.softReload',
    'scene.saveScene', 'scene.closeScene', 'scene.restorePrefab', 'scene.executeSceneScript',
    'scene.beginRecording', 'scene.endRecording', 'scene.cancelRecording',
    'assetDb.queryAssetInfo', 'assetDb.queryUuid', 'assetDb.queryPath', 'assetDb.queryUrl',
    'assetDb.queryAssetMeta', 'assetDb.queryAssets', 'assetDb.queryReady', 'assetDb.createAsset',
    'assetDb.importAsset', 'assetDb.copyAsset', 'assetDb.moveAsset', 'assetDb.deleteAsset',
    'assetDb.saveAsset', 'assetDb.saveAssetMeta', 'assetDb.reimportAsset', 'assetDb.refreshAsset',
    'assetDb.generateAvailableUrl',
    'builder.queryWorkerReady', 'builder.openPanel', 'builder.addTask', 'builder.queryTasksInfo',
    'builder.queryTask', 'builder.checkAndCompleteOptions',
    'project.queryConfig', 'project.profile'
] as const;

export const SCENE_METHODS = [
    'declaredComponentProperty', 'addComponentToNode', 'getNodeInfo', 'getCurrentSceneInfo',
    'setNodeProperty', 'evalInScene', 'setParticleGradient', 'setParticleCurve',
    'createPrefabFromNode2', 'previewPlay', 'addSkeletalSocket', 'listSkeletalSockets',
    'removeSkeletalSocket', 'applyPrefabToAsset', 'revertPrefabInstance', 'listPrefabOverrides', 'dumpPrefabAsset',
    'removePrefabOverride', 'serializedComponentValue', 'prefabInstancePropertyOutcome',
    'nodePrefabLinkage', 'resolveComponentReference', 'applyComponentReference',
    'componentReferenceOutcome', 'pruneComponentReferenceOverrides', 'resolveNodePaths',
    'dumpSceneNodes', 'dumpMissingScripts', 'findComponentOwners', 'sceneDirtyAgainstDisk'
] as const;

export type EditorMethod = typeof EDITOR_METHODS[number];
export type SceneMethod = typeof SCENE_METHODS[number];

export const ALL_METHODS: readonly string[] = [
    ...EDITOR_METHODS.map(name => `editor.${name}`),
    ...SCENE_METHODS.map(name => `scene.${name}`)
];

const KNOWN = new Set(ALL_METHODS);

export function isKnownMethod(name: string): boolean {
    return KNOWN.has(name);
}

export interface Hello {
    project: string;
    projectPath: string;
    pid: number;
    version: string;
    surfaceChecksum: string;
}

export {
    PathResolved, PathResolution, PathIndexNode, PathIndex,
    normalizePath, siblingLabels, buildPathIndex, resolvePathInIndex
} from './node-path';
export { SerializedDiff, BENIGN_DIFF_PATHS, diffSerialized } from './serialized-diff';
export {
    LiveNodeShape, liveNodesBySerializedIndex, ReferenceOverride, projectAfterReload,
    contradictedOverrides
} from './reference-projection';
export type * from './scene-contract';
export { PIPE_PREFIX, instanceKey, pipePath, pipeDirectory } from './pipe-name';
