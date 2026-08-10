import { buildPathIndex, resolvePathInIndex } from '../node-path';
import { diffSerialized } from '../serialized-diff';
import type { DeclaredProperty, PrefabLinkageReport, SceneMethods, SceneResult } from '../scene-contract';
import { ctorIsA, findNodeByUuid, plainSerialized, requireActiveScene } from './engine';
import { overlaidReferenceValue } from './property-write';

/**
 * Whether a SyntaxError out of `eval(code)` came from parsing the script rather than from running
 * it. `JSON.parse('{')` and `new RegExp('[')` also throw SyntaxError, and re-running a script that
 * already executed would apply its writes twice — so the retry is gated on this.
 *
 * Parsing is not lazy for syntax: `if (false) { … }` reports every parse error the bare script
 * would, and executes none of it.
 */
function failedToParse(code: string): boolean {
    try {
        // eslint-disable-next-line no-eval
        eval(`if (false) {\n${code}\n}`);
        return false;
    } catch (err: any) {
        return err instanceof SyntaxError;
    }
}

/** Whether the script is legal inside a plain function — false is how a top-level `await` shows up. */
function compilesAsFunctionBody(code: string): boolean {
    try {
        new Function(code);
        return true;
    } catch {
        return false;
    }
}

/**
 * A component property's DECLARED type, read off the registered CCClass.
 *
 * The prefab tools rewrite a `.prefab` as JSON in the main process, where no class is loaded
 * and the only clue to a property's type is the value already sitting in the file. That is
 * enough to keep an existing boolean a boolean and no help at all for an unset reference, so
 * this answers from the class itself. `found:false` for a class or property the registry does
 * not know is a normal answer, not an error — plenty of fields carry no CCClass metadata.
 */
export const declaredComponentProperty: SceneMethods['declaredComponentProperty'] = (componentType, property) => {
    const absent: SceneResult<DeclaredProperty> = { success: true, data: { found: false } };
    try {
        const cc = require('cc');
        const klass = cc.js.getClassByName(componentType);
        const attrOf = (cc.CCClass && cc.CCClass.attr) || (cc.Class && cc.Class.attr);
        if (!klass || typeof attrOf !== 'function') return absent;
        const attr = attrOf(klass, property);
        if (!attr || !Object.keys(attr).length) return absent;

        // The default is a factory for anything that is not a shared immutable — an array, a
        // Vec3, a colour — so it has to be built to be read. Building it is what the engine
        // itself does at instantiation.
        let value = attr.default;
        if (typeof value === 'function') {
            try { value = value(); } catch { value = undefined; }
        }
        const ctor = attr.ctor || null;
        const isArray = Array.isArray(value);
        const scalar = (!ctor && !isArray && (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string'))
            ? typeof value
            : (attr.enumList ? 'number' : null);
        return {
            success: true,
            data: {
                found: true,
                ctorName: ctor ? cc.js.getClassName(ctor) : null,
                isNode: ctorIsA(ctor, cc.Node),
                isComponent: ctorIsA(ctor, cc.Component),
                isAsset: ctorIsA(ctor, cc.Asset),
                isArray,
                scalar
            }
        };
    } catch {
        return absent;
    }
};

// Evaluate arbitrary JavaScript in the scene (engine) context, where the `cc`
// module and the live `director`/scene are available. This replaces the previous
// dependency on the editor-internal `console` scene package (whose `eval` method
// is not present in every 3.8.x build — the source of the
// "Scenario scripts do not exist: console" error).
export const evalInScene: SceneMethods['evalInScene'] = async (code, timeoutMs = 20000) => {
    const cc = require('cc');
    const { director } = cc;
    const scene = director.getScene();
    // `cc`, `director` and `scene` are in scope for the evaluated code.
    void scene;
    let asyncWrapper = false;
    let functionWrapper = false;
    let awaited = false;
    try {
        let result: any;
        try {
            // Plain eval first, so a bare expression still evaluates to its own value —
            // `cc.director.getScene()` has to keep returning the scene, which it would not
            // do from inside a function body.
            // eslint-disable-next-line no-eval
            result = eval(code);
        } catch (err: any) {
            // Neither a top-level `return` nor a top-level `await` is legal in plain eval.
            // Both fail at parse time, before any statement runs, so re-running the script
            // inside a wrapper that permits them cannot execute anything twice.
            //
            // Which wrapper is needed cannot be read off the message. V8 only says "await is
            // only valid in async functions" where `await` opens a statement; in any other
            // position it parses `await` as an identifier and reports whatever breaks next —
            // `{ k: await f() }` gives "Unexpected identifier 'f'", `g(await f())` gives
            // "missing ) after argument list". Matching those phrasings rejected valid scripts
            // as syntax errors, so the decision is made by compiling instead of by reading.
            if (!(err instanceof SyntaxError) || !failedToParse(code)) throw err;
            if (compilesAsFunctionBody(code)) {
                functionWrapper = true;
                // eslint-disable-next-line no-eval
                result = eval(`(function () {\n${code}\n})()`);
            } else {
                asyncWrapper = true;
                // eslint-disable-next-line no-eval
                result = eval(`(async () => {\n${code}\n})()`);
            }
        }

        if (result && typeof result.then === 'function') {
            awaited = true;
            let timer: any;
            try {
                result = await Promise.race([
                    result,
                    new Promise((_resolve, reject) => {
                        timer = setTimeout(() => reject(new Error(`script promise did not settle within ${timeoutMs}ms`)), timeoutMs);
                    })
                ]);
            } finally {
                clearTimeout(timer);
            }
        }

        // Only return JSON-serialisable results across the IPC boundary.
        let data: any;
        try {
            JSON.stringify(result);
            data = result;
        } catch {
            data = result === undefined ? undefined : String(result);
        }
        const payload: any = { result: data };
        if (awaited) payload.awaited = true;
        if (asyncWrapper) payload.asyncWrapper = true;
        if (functionWrapper) payload.functionWrapper = true;
        return { success: true, data: payload };
    } catch (error: any) {
        return {
            success: false,
            error: asyncWrapper ? `${error.message} (script was re-run inside an async wrapper, where it must \`return\` its value)` : error.message,
            stack: error.stack
        };
    }
};

// Save writes exactly the output of `EditorExtends.serialize`, so whatever this call omits is
// absent from the `.scene` file too — the Inspector dump can still show it.
export const serializedComponentValue: SceneMethods['serializedComponentValue'] = (nodeUuid, cid, property) => {
    try {
        const cc = require('cc');
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const component = (node.components || []).find((c: any) =>
            c && (cc.js as any)._getClassId(c.constructor) === cid);
        if (!component) {
            return { success: false, error: `No component with cid '${cid}' on node ${nodeUuid}` };
        }

        const serialized = (globalThis as any).EditorExtends.serialize(scene, { stringify: false });
        const objects: any[] = Array.isArray(serialized) ? serialized : [serialized];
        const componentObject = objects.find((entry) => entry && entry._id === component.uuid);
        if (!componentObject) {
            return {
                success: true,
                data: {
                    found: false,
                    value: undefined,
                    reason: `'${node.name}' is inside a prefab instance, so the scene file carries none of `
                        + `this component's properties directly — only a prefab property override would.`
                }
            };
        }

        let current: any = componentObject;
        for (const segment of property.split('.')) {
            if (current && typeof current === 'object' && typeof current.__id__ === 'number') {
                current = objects[current.__id__];
            }
            if (!current || typeof current !== 'object' || !(segment in current)) {
                return { success: true, data: { found: false, value: undefined } };
            }
            current = current[segment];
        }
        const value = overlaidReferenceValue(scene, component, property, plainSerialized(objects, current, 0));
        return { success: true, data: { found: true, value } };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * Whether a node is a prefab INSTANCE, answered twice: from the live node, and from what the
 * editor's serializer emits for it.
 *
 * The two can disagree, and only the second one predicts the saved scene: a PrefabInfo that
 * exists on the runtime node but is not emitted is a link that dies at save time and takes the
 * asset tracking with it. `EditorExtends.serialize` is the call the save path runs, so a node
 * with no `cc.PrefabInfo` in its output is a node the `.scene` file will hold as a flat copy.
 *
 * Serializing a node walks its parent chain and therefore the whole scene — the same work one
 * save does. That cost is why this runs once per creation and not per query.
 */
export const nodePrefabLinkage: SceneMethods['nodePrefabLinkage'] = (nodeUuid) => {
    try {
        const scene = requireActiveScene();
        const node = findNodeByUuid(scene, nodeUuid);
        const live = node._prefab;
        const report: PrefabLinkageReport = {
            linked: !!live,
            asset: (live && live.asset) ? live.asset._uuid : null,
            fileId: live ? (live.fileId || null) : null,
            instanceRoot: !!(live && live.instance),
            persistenceChecked: false,
            persisted: false,
            persistedAsset: null
        };
        try {
            const serialized = (globalThis as any).EditorExtends.serialize(node, { stringify: false });
            const objects: any[] = Array.isArray(serialized) ? serialized : [serialized];
            const ref = objects[0] && objects[0]._prefab;
            const info = (ref && typeof ref.__id__ === 'number') ? objects[ref.__id__] : null;
            report.persistenceChecked = true;
            report.persisted = !!(info && info.__type__ === 'cc.PrefabInfo');
            report.persistedAsset = (report.persisted && info.asset) ? info.asset.__uuid__ : null;
        } catch (error: any) {
            report.persistenceReason = error.message || String(error);
        }
        return { success: true, data: report };
    } catch (error: any) {
        return { success: false, error: error.message || String(error) };
    }
};

/**
 * Resolve scene paths to node uuids against the scene the editor has open right now.
 *
 * Engine-side because this must see the live tree, including branches under an inactive
 * parent, and because resolving at call time is the entire point: a uuid captured earlier
 * may already name nothing. One walk answers the whole batch, so a tool call carrying
 * several paths costs one traversal.
 */
export const resolveNodePaths: SceneMethods['resolveNodePaths'] = (paths) => {
    try {
        const wanted: string[] = Array.isArray(paths) ? paths : [paths];
        const scene = requireActiveScene();
        const index = buildPathIndex(scene);
        const resolutions: Record<string, any> = {};
        for (const path of wanted) {
            if (typeof path !== 'string') continue;
            resolutions[path] = resolvePathInIndex(index, path);
        }
        return { success: true, data: { sceneName: scene.name, nodeCount: index.canonical.size, resolutions } };
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};

/**
 * Whether the open scene differs from its own file, decided by serializing the scene the way
 * the save path does and diffing that against the file's contents.
 *
 * The editor's own `query-dirty` cannot answer this. It reports `_undoMgr.isDirty()` — the undo
 * cursor's distance from the last save — and a `set-property` issued outside a
 * begin-recording/end-recording pair moves the scene without moving that cursor. Every write
 * this bridge makes is such a write, so the editor calls the scene clean while it holds changes
 * the file does not have.
 *
 * `querySceneSerializedData` is the facade call whose output `save()` writes verbatim, so its
 * result and the file agree entry for entry on a saved scene — except for the SceneAsset's
 * `_name`, which the serializer leaves empty and the asset database fills in from the filename
 * on import. That one path is ignored; nothing else is.
 */
export const sceneDirtyAgainstDisk: SceneMethods['sceneDirtyAgainstDisk'] = () => {
    try {
        const facade = (globalThis as any).cce?.SceneFacadeManager?.getCurrentFacade?.();
        if (!facade || typeof facade.querySceneSerializedData !== 'function') {
            return { success: false, error: 'The scene facade does not expose querySceneSerializedData' };
        }
        return Promise.resolve(facade.querySceneSerializedData()).then(async (raw: string) => {
            const sceneUuid = await Editor.Message.request('scene', 'query-current-scene');
            if (!sceneUuid) return { success: false as const, error: 'No scene is open' };
            let scenePath = '';
            try {
                scenePath = (await Editor.Message.request('asset-db', 'query-path', sceneUuid)) || '';
            } catch {
                scenePath = '';
            }
            const fs = require('fs');
            if (!scenePath || !fs.existsSync(scenePath)) {
                return {
                    success: true as const,
                    data: {
                        differsFromDisk: true,
                        scenePath: scenePath || null,
                        diffs: [],
                        reason: 'The scene has never been written to disk, so everything in it is unsaved.'
                    }
                };
            }
            const live = JSON.parse(raw);
            const disk = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
            const diffs = diffSerialized(live, disk);
            return {
                success: true as const,
                data: { differsFromDisk: diffs.length > 0, scenePath, diffs }
            };
        }).catch((error: any) => ({ success: false as const, error: error.message || String(error) }));
    } catch (error: any) {
        return { success: false, error: error.message };
    }
};
