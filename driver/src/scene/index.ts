import type { SceneMethods } from '@cocos-cli/shared';
import { dumpSceneNodes, findComponentOwners, getCurrentSceneInfo, getNodeInfo } from './dump.ts';
import { previewPlay, setNodeProperty } from './node-ops.ts';
import {
    addComponentToNode, addSkeletalSocket, listSkeletalSockets,
    removeSkeletalSocket, setParticleCurve, setParticleGradient
} from './component-ops.ts';
import {
    applyComponentReference, componentReferenceOutcome, prefabInstancePropertyOutcome,
    pruneComponentReferenceOverrides, resolveComponentReference
} from './property-write.ts';
import {
    applyPrefabToAsset, createPrefabFromNode2, dumpPrefabAsset, listPrefabOverrides,
    removePrefabOverride, revertPrefabInstance
} from './prefab-ops.ts';
import {
    declaredComponentProperty, dumpMissingScripts, evalInScene, nodePrefabLinkage, resolveNodePaths,
    sceneDirtyAgainstDisk, serializedComponentValue
} from './query.ts';

export const methods: SceneMethods = {
    declaredComponentProperty,
    addComponentToNode,
    getNodeInfo,
    getCurrentSceneInfo,
    setNodeProperty,
    evalInScene,
    setParticleGradient,
    setParticleCurve,
    createPrefabFromNode2,
    previewPlay,
    addSkeletalSocket,
    listSkeletalSockets,
    removeSkeletalSocket,
    applyPrefabToAsset,
    revertPrefabInstance,
    dumpPrefabAsset,
    listPrefabOverrides,
    removePrefabOverride,
    serializedComponentValue,
    prefabInstancePropertyOutcome,
    nodePrefabLinkage,
    resolveComponentReference,
    applyComponentReference,
    componentReferenceOutcome,
    pruneComponentReferenceOverrides,
    resolveNodePaths,
    dumpSceneNodes,
    findComponentOwners,
    sceneDirtyAgainstDisk,
    dumpMissingScripts
};
