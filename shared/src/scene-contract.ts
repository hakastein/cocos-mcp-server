import type { SerializedDiff } from './serialized-diff';
import type { PathResolution } from './node-path';

export interface SceneFailure {
    success: false;
    error: string;
    stack?: string;
}

export interface SceneSuccess<T> {
    success: true;
    data: T;
    message?: string;
}

export interface SceneAck {
    success: true;
    message: string;
}

export type SceneResult<T> = SceneSuccess<T> | SceneFailure;
export type SceneAckResult = SceneAck | SceneFailure;

export interface Vec3Like {
    x: number;
    y: number;
    z: number;
}

export interface QuatLike extends Vec3Like {
    w: number;
}

export interface WriteReport {
    written: boolean;
    verified: boolean;
    /**
     * Whether a save would carry the value: `true` proven so, `false` proven otherwise, `null`
     * UNPROVEN — the route does persist, but the check could not run or was not asked for. `null`
     * is not a soft `false`: nobody looked, so claiming either way would invent the answer.
     */
    persisted: boolean | null;
    /**
     * Which route carried the value. It decides what `persisted: false` means: the editor channel
     * serializes, so it is a write a save would drop; the live channel records nothing by
     * construction, so it is the expected state there.
     */
    channel?: 'editor' | 'live';
    prefabOverride?: { targetPath: string };
    detail?: string;
}

export interface NodePropertyWrite {
    nodeUuid: string;
    property: string;
    value: any;
}

export interface ComponentSummary {
    type: string;
    enabled: boolean;
}

export interface NodeInfo {
    uuid: string;
    name: string;
    active: boolean;
    position: Vec3Like;
    rotation: QuatLike;
    scale: Vec3Like;
    parent: string | undefined;
    children: string[];
    components: ComponentSummary[];
}

export interface SceneInfo {
    name: string;
    uuid: string;
    nodeCount: number;
}

export interface DumpOptions {
    rootUuid?: string;
    includeComponents?: boolean;
    includeTransform?: boolean;
}

export interface DumpedComponent {
    type: string;
    className: string;
    uuid: string;
    enabled: boolean;
}

export interface SceneNodeEntry {
    uuid: string;
    name: string;
    path: string;
    parentUuid: string | null;
    active: boolean;
    activeInHierarchy: boolean;
    childCount: number;
    components?: DumpedComponent[];
    position?: Vec3Like;
    rotation?: Vec3Like;
    scale?: Vec3Like;
}

export interface SceneDump {
    sceneName: string;
    nodeCount: number;
    nodes: SceneNodeEntry[];
}

export interface ComponentOwner {
    nodePath: string;
    nodeUuid: string;
    nodeName: string;
    active: boolean;
    activeInHierarchy: boolean;
    componentUuid: string;
    className: string;
    enabled: boolean;
}

export interface ComponentOwnerReport {
    className: string;
    sceneName: string;
    nodesScanned: number;
    ownerCount: number;
    owners: ComponentOwner[];
}

export interface DeclaredProperty {
    found: boolean;
    ctorName?: string | null;
    isNode?: boolean;
    isComponent?: boolean;
    isAsset?: boolean;
    isArray?: boolean;
    scalar?: string | null;
    /** For an array property CCClass reports the ELEMENT's ctor, so these are the element's members. */
    members?: Record<string, DeclaredProperty>;
}

export interface EvalPayload {
    result: unknown;
    awaited?: boolean;
    asyncWrapper?: boolean;
    functionWrapper?: boolean;
}

export interface GradientWriteReport {
    propertyPath: string;
    mode: number;
    colorKeys: number;
    alphaKeys: number;
    moduleEnabled: boolean;
}

export interface CurveWriteReport {
    propertyPath: string;
    mode: number;
    multiplier: number;
    keyCount: number;
    eval0: number;
    eval1: number;
    moduleEnabled: boolean;
}

export interface GeneratedPrefab {
    prefabData: string;
    nodeName: string;
}

export interface SkeletalSocket {
    path: string;
    targetUuid: string | undefined;
    targetName: string | undefined;
    targetChildren: string[];
}

export interface SkeletalSocketList {
    nodeUuid: string;
    useBakedAnimation: boolean;
    sockets: SkeletalSocket[];
}

export interface AddedSkeletalSocket {
    targetUuid: string;
    targetName: string;
    bonePath: string;
    created: boolean;
    renamed: boolean;
    socketCount: number;
}

export interface RemovedSkeletalSocket {
    bonePath: string;
    removedTargetUuid: string | undefined;
    socketCount: number;
}

export interface OverrideValueDescription {
    valueKind: string;
    value?: unknown;
    length?: number;
    valueType?: string;
    assetUuid?: string | null;
    assetName?: string;
    refUuid?: string;
    refName?: string;
}

export interface PrefabTargetInfo {
    kind: string;
    name: string;
    path: string;
    type: string;
}

export interface PrefabOverrideRecord extends OverrideValueDescription {
    index: number;
    propertyPath: string;
    propertyPathParts: string[];
    localID: string[];
    target: PrefabTargetInfo | null;
}

export interface PrefabOverrideReport {
    nodeUuid: string;
    nodeName: string;
    prefabAsset: string | undefined;
    overrideCount: number;
    removedComponents: number;
    mountedChildren: number;
    overrides: PrefabOverrideRecord[];
}

export interface RemovedPrefabOverride extends OverrideValueDescription {
    index: number;
    propertyPath: string;
    localID: string[];
    target: PrefabTargetInfo | null;
}

export interface PrefabAssetComponent {
    /** The name the class is REGISTERED under in the engine — `cc.MeshRenderer`, `CharacterAnimator`. */
    className: string;
    /** The compressed uuid of the script; an engine component has none. */
    cid: string | null;
    /** The only identifier that survives a prefab being re-instantiated. */
    fileId: string | null;
    enabled: boolean;
    /**
     * The component no longer has a script behind it. Such a slot crashes preview on scene load by
     * reaching for the `__prefab` of whatever the engine put in the component's place.
     */
    missing: boolean;
}

export interface PrefabAssetNode {
    /** The path from the prefab root; same-named siblings carry `#N` just as in the scene tree. */
    path: string;
    name: string;
    active: boolean;
    fileId: string | null;
    components: PrefabAssetComponent[];
}

export interface PrefabAssetDump {
    prefabUuid: string;
    rootName: string;
    nodeCount: number;
    componentCount: number;
    missingCount: number;
    nodes: PrefabAssetNode[];
}

export interface PrefabSyncReport {
    nodeUuid: string;
    nodeName: string;
    prefabAsset: string | null;
    instanceRoot: boolean;
    accepted: boolean | null;
}

export interface PrefabOverrideRemoval {
    nodeUuid: string;
    removed: RemovedPrefabOverride;
    remaining: number;
}

export interface SerializedValue {
    found: boolean;
    value: unknown;
    reason?: string;
    /** The scene file carries none of this component's properties; only an override would. */
    inPrefabInstance?: boolean;
    /**
     * The value points at a node the file names by index alone and the pairing could not resolve,
     * so the value is reported with that slot empty and nothing may be concluded from it.
     */
    unnamedReference?: boolean;
}

export interface PrefabOverrideOutcome {
    inPrefabInstance: boolean;
    /** false when the prefab asset, or this component's counterpart inside it, could not be read. */
    known: boolean;
    /** Whether the next load rebuilds what the live component holds now. */
    carried: boolean;
    instanceRoot: string | null;
    prefabAsset: string | null;
    overridePaths: string[];
    /** Differences from the prefab asset that no override records. */
    uncovered: string[];
    /** Paths where the two sides hold objects of different classes, which the editor will not diff. */
    untyped: string[];
    reason?: string;
}

export interface PrefabLinkageReport {
    linked: boolean;
    asset: string | null;
    fileId: string | null;
    instanceRoot: boolean;
    persistenceChecked: boolean;
    persisted: boolean;
    persistedAsset: string | null;
    persistenceReason?: string;
}

export interface ReferencePlanReport {
    componentIndex: number;
    property: string;
    isArray: boolean;
    dumpType: string;
    uuids: string[];
    expected: Array<string | null>;
    assignedKind: string;
    assignedNames: string[];
    assignedTypes: string[];
    declaredType: string | null;
    inferredType: string | null;
    warning?: string;
}

export interface ReferenceApplied {
    property: string;
    assigned: Array<string | null>;
}

export interface ReferenceOutcomeReport {
    live: Array<string | null>;
    serialized: Array<string | null>;
    projected: Array<string | null>;
    projectionChecked: boolean;
    componentInSceneGraph: boolean;
    overrides: Array<{ index: number | null; uuid: string | null; prefabInstance: string | null }>;
}

export interface PrunedOverrides {
    removed: number;
    paths: string[];
}

export interface ResolvedNodePaths {
    sceneName: string;
    nodeCount: number;
    resolutions: Record<string, PathResolution>;
}

export interface SceneDirtyReport {
    differsFromDisk: boolean;
    scenePath: string | null;
    diffs: SerializedDiff[];
    reason?: string;
}

export interface MissingScriptScanOptions {
    rootUuid?: string;
    recursive?: boolean;
}

export interface MissingScriptEntry {
    nodePath: string;
    nodeUuid: string;
    componentUuid: string;
    cid: string | null;
}

export interface MissingScriptDump {
    entries: MissingScriptEntry[];
}

export interface SceneMethods {
    declaredComponentProperty(componentType: string, property: string): SceneResult<DeclaredProperty>;
    addComponentToNode(nodeUuid: string, componentType: string): SceneResult<{ componentId: string }>;
    getNodeInfo(nodeUuid: string): SceneResult<NodeInfo>;
    getCurrentSceneInfo(): SceneResult<SceneInfo>;
    setNodeProperty(
        nodeUuid: NodePropertyWrite['nodeUuid'],
        property: NodePropertyWrite['property'],
        value: NodePropertyWrite['value'],
    ): SceneAckResult;
    evalInScene(code: string, timeoutMs?: number): Promise<SceneResult<EvalPayload>>;
    setParticleGradient(
        nodeUuid: string,
        componentType: string,
        propertyPath: string,
        colorKeys: Array<{ color?: { r?: number; g?: number; b?: number; a?: number }; time?: number }>,
        alphaKeys: Array<{ alpha?: number; time?: number }>,
        mode?: number,
        enableModule?: boolean,
    ): SceneResult<GradientWriteReport>;
    setParticleCurve(
        nodeUuid: string,
        componentType: string,
        propertyPath: string,
        keyframes: Array<{ time?: number; value?: number }>,
        mode?: number,
        multiplier?: number,
        enableModule?: boolean,
    ): SceneResult<CurveWriteReport>;
    createPrefabFromNode2(nodeUuid: string): SceneResult<GeneratedPrefab>;
    previewPlay(action: string): SceneAckResult;
    addSkeletalSocket(nodeUuid: string, bonePath: string, targetName?: string): SceneResult<AddedSkeletalSocket>;
    listSkeletalSockets(nodeUuid: string): SceneResult<SkeletalSocketList>;
    removeSkeletalSocket(nodeUuid: string, bonePath: string): SceneResult<RemovedSkeletalSocket>;
    applyPrefabToAsset(nodeUuid: string): Promise<SceneResult<PrefabSyncReport>>;
    revertPrefabInstance(nodeUuid: string): Promise<SceneResult<PrefabSyncReport>>;
    dumpPrefabAsset(prefabUuid: string): Promise<SceneResult<PrefabAssetDump>>;
    listPrefabOverrides(nodeUuid: string): SceneResult<PrefabOverrideReport>;
    removePrefabOverride(
        nodeUuid: string,
        propertyPath: string | string[],
        localID?: string,
        index?: number,
    ): SceneResult<PrefabOverrideRemoval>;
    serializedComponentValue(nodeUuid: string, cid: string, property: string): SceneResult<SerializedValue>;
    prefabInstancePropertyOutcome(
        nodeUuid: string,
        cid: string,
        property: string,
    ): SceneResult<PrefabOverrideOutcome>;
    nodePrefabLinkage(nodeUuid: string): SceneResult<PrefabLinkageReport>;
    resolveComponentReference(args?: any): SceneResult<ReferencePlanReport>;
    applyComponentReference(args?: any): SceneResult<ReferenceApplied>;
    componentReferenceOutcome(
        nodeUuid: string,
        componentIndex: number,
        property: string,
    ): SceneResult<ReferenceOutcomeReport>;
    pruneComponentReferenceOverrides(
        nodeUuid: string,
        componentIndex: number,
        property: string,
    ): SceneResult<PrunedOverrides>;
    resolveNodePaths(paths: any): SceneResult<ResolvedNodePaths>;
    dumpSceneNodes(options?: DumpOptions): SceneResult<SceneDump>;
    dumpMissingScripts(options?: MissingScriptScanOptions): SceneResult<MissingScriptDump>;
    findComponentOwners(options?: any): SceneResult<ComponentOwnerReport>;
    sceneDirtyAgainstDisk(): SceneResult<SceneDirtyReport> | Promise<SceneResult<SceneDirtyReport>>;
}
