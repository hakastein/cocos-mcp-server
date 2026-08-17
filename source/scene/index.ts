import type { SceneMethods } from '../scene-contract';
import { dumpSceneNodes, findComponentOwners, getCurrentSceneInfo, getNodeInfo } from './dump';
import { previewPlay, setNodeProperty } from './node-ops';
import {
    addComponentToNode, addSkeletalSocket, listSkeletalSockets,
    removeSkeletalSocket, setParticleCurve, setParticleGradient
} from './component-ops';
import {
    applyComponentReference, componentReferenceOutcome, prefabInstancePropertyOutcome,
    pruneComponentReferenceOverrides, resolveComponentReference
} from './property-write';
import {
    applyPrefabToAsset, createPrefabFromNode2, listPrefabOverrides, removePrefabOverride,
    revertPrefabInstance
} from './prefab-ops';
import {
    declaredComponentProperty, dumpMissingScripts, evalInScene, nodePrefabLinkage, resolveNodePaths,
    sceneDirtyAgainstDisk, serializedComponentValue
} from './query';

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
