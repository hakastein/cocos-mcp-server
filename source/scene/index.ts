import type { SceneMethods } from '../scene-contract';
import {
    dumpSceneNodes, findComponentOwners, getAllNodes, getCurrentSceneInfo, getNodeInfo, getSceneHierarchy
} from './dump';
import { createNewScene, createNode, previewPlay, setNodeProperty } from './node-ops';
import {
    addComponentToNode, addSkeletalSocket, listSkeletalSockets, removeComponentFromNode,
    removeSkeletalSocket, setMeshRendererMaterials, setParticleCurve, setParticleGradient
} from './component-ops';
import {
    applyComponentReference, componentReferenceOutcome, pruneComponentReferenceOverrides,
    resolveComponentReference, setComponentProperty
} from './property-write';
import { createPrefabFromNode2, listPrefabOverrides, removePrefabOverride } from './prefab-ops';
import {
    declaredComponentProperty, evalInScene, findNodeByName, nodePrefabLinkage, resolveNodePaths,
    sceneDirtyAgainstDisk, serializedComponentValue
} from './query';

export const methods: SceneMethods = {
    declaredComponentProperty,
    createNewScene,
    addComponentToNode,
    removeComponentFromNode,
    createNode,
    getNodeInfo,
    getAllNodes,
    findNodeByName,
    getCurrentSceneInfo,
    setNodeProperty,
    getSceneHierarchy,
    evalInScene,
    setComponentProperty,
    setParticleGradient,
    setParticleCurve,
    createPrefabFromNode2,
    previewPlay,
    addSkeletalSocket,
    listSkeletalSockets,
    removeSkeletalSocket,
    listPrefabOverrides,
    removePrefabOverride,
    setMeshRendererMaterials,
    serializedComponentValue,
    nodePrefabLinkage,
    resolveComponentReference,
    applyComponentReference,
    componentReferenceOutcome,
    pruneComponentReferenceOverrides,
    resolveNodePaths,
    dumpSceneNodes,
    findComponentOwners,
    sceneDirtyAgainstDisk
};
