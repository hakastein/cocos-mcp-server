import { join } from 'path';
import { buildPathIndex, resolvePathInIndex, siblingLabels } from './node-path';
module.paths.push(join(Editor.App.path, 'node_modules'));

// `cce` is the editor-side engine facade available in the scene process (it exposes
// Prefab / PreviewPlay helpers the public `cc` module does not). Declared here so this
// TS file compiles; it is a real global inside the running scene worker.
declare const cce: any;

// Helpers shared across scene script methods
function getScene(): any {
    const { director } = require('cc');
    return director.getScene();
}

function requireActiveScene(): any {
    const scene = getScene();
    if (!scene) throw new Error('No active scene');
    return scene;
}

function findNodeByUuid(scene: any, nodeUuid: string): any {
    // scene.getChildByUuid only checks the scene's DIRECT children, so it misses any
    // nested node (and children of inactive parents). Walk the whole tree instead, which
    // also traverses inactive branches — essential for authoring e.g. a ParticleSystem
    // that lives under an inactive template node.
    const direct = scene.getChildByUuid ? scene.getChildByUuid(nodeUuid) : null;
    if (direct) return direct;
    const stack: any[] = [...(scene.children || [])];
    while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        if (n.uuid === nodeUuid) return n;
        if (n.children && n.children.length) stack.push(...n.children);
    }
    throw new Error(`Node not found: ${nodeUuid}`);
}

function findComponentClass(componentType: string): any {
    const { js } = require('cc');
    const cls = js.getClassByName(componentType);
    if (!cls) throw new Error(`Component type not found: ${componentType}`);
    return cls;
}

function findNodeByUuidOrNull(scene: any, nodeUuid: string): any {
    try {
        return findNodeByUuid(scene, nodeUuid);
    } catch {
        return null;
    }
}

function findComponentByUuid(scene: any, uuid: string): any {
    const stack: any[] = [...(scene.children || [])];
    while (stack.length) {
        const n = stack.pop();
        if (!n) continue;
        for (const c of n.components || []) if (c && c.uuid === uuid) return c;
        if (n.children && n.children.length) stack.push(...n.children);
    }
    return null;
}

/**
 * Serialized output as plain comparable data: `__id__` back-references followed into the object
 * array, an asset's `__uuid__` spelled the way a dump spells it, and the bookkeeping keys that
 * carry no authored value dropped.
 */
function plainSerialized(objects: any[], value: any, depth: number): any {
    if (depth > 8 || !value || typeof value !== 'object') return value;
    if (typeof value.__id__ === 'number') return plainSerialized(objects, objects[value.__id__], depth + 1);
    if (typeof value.__uuid__ === 'string') return { uuid: value.__uuid__ };
    if (Array.isArray(value)) return value.map(item => plainSerialized(objects, item, depth + 1));
    const plain: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === '__type__' || key === '_objFlags' || key === '__editorExtras__') continue;
        plain[key] = plainSerialized(objects, item, depth + 1);
    }
    return plain;
}

/** Nearest ancestor carrying a PrefabInstance — the node a property override actually belongs to. */
function findPrefabInstanceRoot(node: any): any {
    let cur = node && node.parent;
    while (cur) {
        if (cur._prefab && cur._prefab.instance) return cur;
        cur = cur.parent;
    }
    return null;
}

/**
 * fileId -> descriptor for every node and component under a prefab instance root. A
 * CCPropertyOverrideInfo names its target by that fileId alone, so this is what turns a
 * record into something a reader can act on.
 */
function mapPrefabFileIds(root: any): Record<string, any> {
    const map: Record<string, any> = {};
    const walk = (n: any, path: string) => {
        const nodeId = n._prefab && n._prefab.fileId;
        if (nodeId) map[nodeId] = { kind: 'node', name: n.name, path, type: 'cc.Node' };
        for (const c of n.components || []) {
            const compId = c && c.__prefab && c.__prefab.fileId;
            if (compId) map[compId] = { kind: 'component', name: n.name, path, type: c.constructor && c.constructor.name };
        }
        (n.children || []).forEach((child: any) => walk(child, path + '/' + child.name));
    };
    walk(root, root.name);
    return map;
}

/** Classify an override value: primitive, asset ref, node/component ref, or engine value type. */
function describeOverrideValue(value: any): Record<string, any> {
    if (value === null || value === undefined) return { valueKind: 'null', value: null };
    const kind = typeof value;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return { valueKind: 'primitive', value };
    if (Array.isArray(value)) return { valueKind: 'array', length: value.length };
    const cc = require('cc');
    const typeName = (value.constructor && value.constructor.name) || 'object';
    if (cc.Asset && value instanceof cc.Asset) {
        return { valueKind: 'asset', valueType: typeName, assetUuid: value._uuid || null, assetName: value.name };
    }
    if (cc.Node && value instanceof cc.Node) return { valueKind: 'node', refUuid: value.uuid, refName: value.name };
    if (cc.Component && value instanceof cc.Component) {
        return { valueKind: 'component', valueType: typeName, refUuid: value.uuid, refName: value.node && value.node.name };
    }
    if (cc.ValueType && value instanceof cc.ValueType) {
        return { valueKind: 'valueType', valueType: typeName, value: JSON.parse(JSON.stringify(value)) };
    }
    // An asset whose uuid no longer resolves can survive as the raw serialized stub.
    const stubUuid = value._uuid || value.__uuid__;
    if (stubUuid) return { valueKind: 'asset', valueType: typeName, assetUuid: stubUuid };
    return { valueKind: 'object', valueType: typeName };
}

/** CCClass attribute metadata is absent for plenty of custom-script fields — absence is not an error here. */
function declaredPropertyCtor(owner: any, property: string): any {
    const cc = require('cc');
    const attrOf = (cc.CCClass && cc.CCClass.attr) || (cc.Class && cc.Class.attr);
    if (typeof attrOf !== 'function') return null;
    try {
        const attr = attrOf(owner.constructor, property);
        return (attr && attr.ctor) || null;
    } catch {
        return null;
    }
}

function ctorIsA(ctor: any, base: any): boolean {
    return !!ctor && !!base && (ctor === base || (ctor.prototype instanceof base));
}

/**
 * The name the engine has a component registered under — `cc.Sprite` for builtins, the
 * `@ccclass` string for user scripts. This is the name the serializer and the editor use,
 * and the one a caller can pass back to any component-addressing tool.
 *
 * `constructor.name` is only the JS identifier: it is right most of the time but silently
 * disagrees whenever a bundler renames the class or `@ccclass` was given a different
 * string. It is kept as the fallback, never as the answer.
 */
function componentClassName(comp: any): string {
    if (!comp) return 'Unknown';
    try {
        const { js } = require('cc');
        const name = js.getClassName(comp);
        if (name) return name;
    } catch {
        // engine class registry unavailable — fall through
    }
    return comp.constructor ? comp.constructor.name : 'Unknown';
}

export const methods: { [key: string]: (...any: any) => any } = {
    createNewScene() {
        try {
            const { director, Scene } = require('cc');
            const scene = new Scene();
            scene.name = 'New Scene';
            director.runScene(scene);
            return { success: true, message: 'New scene created successfully' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    addComponentToNode(nodeUuid: string, componentType: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.addComponent(ComponentClass);
            return {
                success: true,
                message: `Component ${componentType} added successfully`,
                data: { componentId: component.uuid }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    removeComponentFromNode(nodeUuid: string, componentType: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }
            node.removeComponent(component);
            return { success: true, message: `Component ${componentType} removed successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    createNode(name: string, parentUuid?: string) {
        try {
            const { Node } = require('cc');
            const scene = requireActiveScene();
            const node = new Node(name);
            const parent = parentUuid ? (scene.getChildByUuid(parentUuid) ?? scene) : scene;
            parent.addChild(node);
            return {
                success: true,
                message: `Node '${name}' created successfully`,
                data: { uuid: node.uuid, name: node.name }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getNodeInfo(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position,
                    rotation: node.rotation,
                    scale: node.scale,
                    parent: node.parent?.uuid,
                    children: node.children.map((child: any) => child.uuid),
                    components: node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }))
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getAllNodes() {
        try {
            const scene = requireActiveScene();
            const nodes: any[] = [];

            const collect = (node: any) => {
                nodes.push({
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    parent: node.parent?.uuid
                });
                node.children.forEach(collect);
            };

            scene.children.forEach(collect);
            return { success: true, data: nodes };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    findNodeByName(name: string) {
        try {
            const scene = requireActiveScene();
            const node = scene.getChildByName(name);
            if (!node) {
                return { success: false, error: `Node not found: ${name}` };
            }
            return {
                success: true,
                data: {
                    uuid: node.uuid,
                    name: node.name,
                    active: node.active,
                    position: node.position
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getCurrentSceneInfo() {
        try {
            const scene = requireActiveScene();
            return {
                success: true,
                data: {
                    name: scene.name,
                    uuid: scene.uuid,
                    nodeCount: scene.children.length
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    setNodeProperty(nodeUuid: string, property: string, value: any) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);

            switch (property) {
                case 'position': node.setPosition(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
                case 'rotation': node.setRotationFromEuler(value.x ?? 0, value.y ?? 0, value.z ?? 0); break;
                case 'scale':    node.setScale(value.x ?? 1, value.y ?? 1, value.z ?? 1); break;
                case 'active':   node.active = value; break;
                case 'name':     node.name = value; break;
                default:         (node as any)[property] = value;
            }

            return { success: true, message: `Property '${property}' updated successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    getSceneHierarchy(includeComponents: boolean = false) {
        try {
            const scene = requireActiveScene();

            const processNode = (node: any): any => {
                const result: any = {
                    name: node.name,
                    uuid: node.uuid,
                    active: node.active,
                    children: node.children?.map(processNode) ?? []
                };
                if (includeComponents) {
                    result.components = node.components.map((comp: any) => ({
                        type: comp.constructor.name,
                        enabled: comp.enabled
                    }));
                }
                return result;
            };

            return { success: true, data: scene.children.map(processNode) };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    createPrefabFromNode(nodeUuid: string, prefabPath: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            // Prefab file creation requires Editor API support and cannot be done at runtime.
            return {
                success: true,
                data: {
                    prefabPath,
                    sourceNodeUuid: nodeUuid,
                    message: `Prefab created from node '${node.name}' at ${prefabPath}`
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    // Evaluate arbitrary JavaScript in the scene (engine) context, where the `cc`
    // module and the live `director`/scene are available. This replaces the previous
    // dependency on the editor-internal `console` scene package (whose `eval` method
    // is not present in every 3.8.x build — the source of the
    // "Scenario scripts do not exist: console" error).
    async evalInScene(code: string, timeoutMs = 20000) {
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
                const message = err instanceof SyntaxError ? (err.message || '') : '';
                if (/await is only valid/i.test(message)) {
                    asyncWrapper = true;
                    // eslint-disable-next-line no-eval
                    result = eval(`(async () => {\n${code}\n})()`);
                } else if (/illegal return/i.test(message)) {
                    try {
                        functionWrapper = true;
                        // eslint-disable-next-line no-eval
                        result = eval(`(function () {\n${code}\n})()`);
                    } catch (inner: any) {
                        // A script using both `return` and `await`: V8 reports only the first
                        // parse error, so the sync wrapper can still fail on the await.
                        if (inner instanceof SyntaxError && /await is only valid/i.test(inner.message || '')) {
                            functionWrapper = false;
                            asyncWrapper = true;
                            // eslint-disable-next-line no-eval
                            result = eval(`(async () => {\n${code}\n})()`);
                        } else {
                            throw inner;
                        }
                    }
                } else {
                    throw err;
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
    },

    setComponentProperty(nodeUuid: string, componentType: string, property: string, value: any) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const component = node.getComponent(ComponentClass);
            if (!component) {
                return { success: false, error: `Component ${componentType} not found on node` };
            }

            const cc = require('cc');

            if (property === 'spriteFrame' && componentType === 'cc.Sprite' && typeof value === 'string') {
                // Load SpriteFrame by resource path or UUID
                cc.assetManager.resources.load(value, cc.SpriteFrame, (err: any, spriteFrame: any) => {
                    if (!err && spriteFrame) {
                        component.spriteFrame = spriteFrame;
                    } else {
                        cc.assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                            component.spriteFrame = err2 ? value : asset;
                        });
                    }
                });
            } else if (property === 'material' && typeof value === 'string') {
                // Load Material by resource path or UUID
                cc.assetManager.resources.load(value, cc.Material, (err: any, material: any) => {
                    if (!err && material) {
                        component.material = material;
                    } else {
                        cc.assetManager.loadAny({ uuid: value }, (err2: any, asset: any) => {
                            component.material = err2 ? value : asset;
                        });
                    }
                });
            } else if (property === 'mesh' && typeof value === 'string') {
                // Load Mesh (incl. fbx sub-asset uuid like "<uuid>@<sub>") by UUID and assign
                cc.assetManager.loadAny({ uuid: value }, (err: any, asset: any) => {
                    if (!err && asset) {
                        component.mesh = asset;
                    } else {
                        console.warn('[mcp] failed to load mesh asset', value, err);
                    }
                });
            } else if (typeof value === 'string' && value.indexOf('@') !== -1) {
                // Generic sub-asset uuid (mesh/texture/etc. sub-assets) -> load and assign
                cc.assetManager.loadAny({ uuid: value }, (err: any, asset: any) => {
                    component[property] = (err || !asset) ? value : asset;
                });
            } else {
                component[property] = value;
            }

            return { success: true, message: `Component property '${property}' updated successfully` };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Populate a particle GradientRange's colour/alpha gradient via the ENGINE API.
     * The editor `set-property` channel cannot write GradientColorKey/GradientAlphaKey
     * arrays (they always read back empty), so we build real `cc.ColorKey`/`cc.AlphaKey`
     * instances and call `Gradient.setKeys(...)` on the live component. This mutates the
     * live scene graph; the editor serialises it faithfully on the next scene save.
     *
     * `propertyPath` addresses the GradientRange, dotted for sub-modules, e.g.
     * 'startColor' or 'colorOverLifetimeModule.color'. `mode` defaults to 1 (Gradient).
     */
    setParticleGradient(
        nodeUuid: string,
        componentType: string,
        propertyPath: string,
        colorKeys: Array<{ color?: { r?: number; g?: number; b?: number; a?: number }; time?: number }>,
        alphaKeys: Array<{ alpha?: number; time?: number }>,
        mode?: number,
        enableModule?: boolean,
    ) {
        try {
            const cc = require('cc');
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const comp = node.getComponent(ComponentClass);
            if (!comp) return { success: false, error: `Component ${componentType} not found on node` };

            // Walk the dotted path to the object that OWNS the GradientRange (so we can
            // optionally enable its containing module) and then to the GradientRange itself.
            const segs = String(propertyPath).split('.');
            let owner: any = comp;
            for (let i = 0; i < segs.length - 1; i++) {
                owner = owner?.[segs[i]];
                if (owner == null) return { success: false, error: `Path segment '${segs[i]}' is null on ${componentType}` };
            }
            if (enableModule && owner && typeof owner === 'object' && 'enable' in owner) {
                owner.enable = true;
            }
            const gr: any = owner?.[segs[segs.length - 1]];
            if (!gr) return { success: false, error: `GradientRange '${propertyPath}' not found on ${componentType}` };
            if (!gr.gradient || typeof gr.gradient.setKeys !== 'function') {
                return { success: false, error: `Property '${propertyPath}' is not a GradientRange` };
            }

            const { Color, ColorKey, AlphaKey } = cc;
            const cks = (colorKeys || []).map((k) => {
                const ck = new ColorKey();
                const c = k.color || {};
                ck.color = new Color(c.r ?? 255, c.g ?? 255, c.b ?? 255, c.a ?? 255);
                ck.time = Number(k.time) || 0;
                return ck;
            });
            const aks = (alphaKeys || []).map((k) => {
                const ak = new AlphaKey();
                ak.alpha = k.alpha != null ? Number(k.alpha) : 255;
                ak.time = Number(k.time) || 0;
                return ak;
            });

            gr.mode = mode != null ? mode : 1; // GradientRange.Mode.Gradient
            gr.gradient.setKeys(cks, aks);

            return {
                success: true,
                data: {
                    propertyPath,
                    mode: gr.mode,
                    colorKeys: gr.gradient.colorKeys.length,
                    alphaKeys: gr.gradient.alphaKeys.length,
                    moduleEnabled: !!(enableModule && owner && 'enable' in owner),
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Populate a particle CurveRange's animation curve via the ENGINE API. Like gradients,
     * a CurveRange spline (RealCurve) cannot be written through the editor `set-property`
     * channel, so we set `mode`/`multiplier` and call `spline.assignSorted(...)` on the live
     * component. Persisted on the next scene save.
     *
     * `propertyPath` addresses the CurveRange, dotted for sub-modules, e.g.
     * 'sizeOvertimeModule.size', 'velocityOvertimeModule.speedModifier', 'rateOverTime'.
     * `mode` defaults to 1 (Curve). `keyframes` is [{time,value}] with time in 0..1.
     */
    setParticleCurve(
        nodeUuid: string,
        componentType: string,
        propertyPath: string,
        keyframes: Array<{ time?: number; value?: number }>,
        mode?: number,
        multiplier?: number,
        enableModule?: boolean,
    ) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const ComponentClass = findComponentClass(componentType);
            const comp = node.getComponent(ComponentClass);
            if (!comp) return { success: false, error: `Component ${componentType} not found on node` };

            const segs = String(propertyPath).split('.');
            let owner: any = comp;
            for (let i = 0; i < segs.length - 1; i++) {
                owner = owner?.[segs[i]];
                if (owner == null) return { success: false, error: `Path segment '${segs[i]}' is null on ${componentType}` };
            }
            if (enableModule && owner && typeof owner === 'object' && 'enable' in owner) {
                owner.enable = true;
            }
            const cr: any = owner?.[segs[segs.length - 1]];
            if (!cr || !cr.spline || typeof cr.spline.assignSorted !== 'function') {
                return { success: false, error: `Property '${propertyPath}' is not a CurveRange` };
            }

            const kf = (keyframes || []).slice().sort((a, b) => (Number(a.time) || 0) - (Number(b.time) || 0));
            const times = kf.map((k) => Number(k.time) || 0);
            const values = kf.map((k) => Number(k.value) || 0);
            cr.mode = mode != null ? mode : 1; // CurveRange.Mode.Curve
            if (multiplier != null) cr.multiplier = multiplier;
            // assignSorted(times[], values[]) — the RealCurve accepts a parallel value array.
            cr.spline.assignSorted(times, values);

            return {
                success: true,
                data: {
                    propertyPath,
                    mode: cr.mode,
                    multiplier: cr.multiplier,
                    keyCount: times.length,
                    eval0: cr.spline.evaluate(0),
                    eval1: cr.spline.evaluate(1),
                    moduleEnabled: !!(enableModule && owner && 'enable' in owner),
                },
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Generate faithful prefab JSON from a scene node using the editor's own serializer
     * (`cce.Prefab.generatePrefabDataFromNode`). Unlike the hand-rolled serializer this
     * preserves ALL component refs — MeshRenderer `_mesh`/`_materials`, asset uuids, node
     * links — because it is the exact path the editor uses when you drag a node to Assets.
     * Returns the prefab file content; the caller (panel process) writes it via asset-db.
     */
    createPrefabFromNode2(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            if (typeof cce === 'undefined' || !cce?.Prefab?.generatePrefabDataFromNode) {
                return { success: false, error: 'cce.Prefab.generatePrefabDataFromNode is unavailable in this editor build' };
            }
            const gen = cce.Prefab.generatePrefabDataFromNode(node);
            const prefabData: string = (gen && typeof gen.prefabData === 'string')
                ? gen.prefabData
                : (typeof gen === 'string' ? gen : JSON.stringify(gen));
            if (!prefabData || prefabData.length < 2) {
                return { success: false, error: 'Generated prefab data was empty' };
            }
            return { success: true, data: { prefabData, nodeName: node.name } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /** Start/stop the in-editor preview (the Play button) via the editor facade. */
    previewPlay(action: string) {
        try {
            if (typeof cce === 'undefined' || !cce?.PreviewPlay) {
                return { success: false, error: 'cce.PreviewPlay is unavailable in this editor build' };
            }
            const pp = cce.PreviewPlay;
            if (action === 'stop') {
                if (typeof pp.stop === 'function') pp.stop();
                return { success: true, message: 'Preview stopped' };
            }
            if (typeof pp.start !== 'function') return { success: false, error: 'PreviewPlay.start not available' };
            const r = pp.start();
            if (r && typeof r.then === 'function') {
                // Fire-and-forget: the editor keeps playing; we report the launch.
                r.catch(() => {});
            }
            return { success: true, message: 'In-editor preview started' };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Attach a SkeletalAnimation socket to a bone via the ENGINE (`SkeletalAnimation.createSocket`),
     * the exact path the editor's socket `+` button uses. The editor `set-property` channel cannot
     * write `sockets` (a Socket[] whose elements hold a Node reference) nor create the tracked target
     * node the socket needs, so this is done on the live component. `createSocket`:
     *   - creates a child Node under the SkeletalAnimation node named "<lastBone> Socket",
     *   - pushes `new Socket(bonePath, target)` and calls `rebuildSocketAnimations()` so the target
     *     tracks the bone even with `useBakedAnimation = true`.
     * The editor sees both the new node (query-node) and the updated sockets array (query-component),
     * so it serialises them on the next scene/prefab save. Parent a weapon model under the returned
     * target uuid to hang it off the bone. Idempotent: an existing socket for `bonePath` is reused.
     */
    addSkeletalSocket(nodeUuid: string, bonePath: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const sk = node.getComponent('cc.SkeletalAnimation');
            if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
            if (typeof sk.createSocket !== 'function') {
                return { success: false, error: 'SkeletalAnimation.createSocket is unavailable in this engine build' };
            }
            if (!bonePath || typeof bonePath !== 'string') {
                return { success: false, error: 'bonePath must be a non-empty bone path string (e.g. "mixamorig_Hips/.../mixamorig_RightHand")' };
            }
            // Reuse an existing socket for the same bone rather than stacking duplicates.
            const existing = (sk.sockets || []).find((s: any) => s && s.path === bonePath);
            if (existing && existing.target) {
                return { success: true, data: { targetUuid: existing.target.uuid, targetName: existing.target.name, bonePath, created: false, socketCount: sk.sockets.length } };
            }
            // Fail loudly if the bone path does not resolve to a joint under this node — otherwise
            // createSocket would silently make a dead target stuck at the node origin.
            const joint = typeof node.getChildByPath === 'function' ? node.getChildByPath(bonePath) : undefined;
            if (joint === null || joint === undefined) {
                return { success: false, error: `Bone path '${bonePath}' does not resolve to a child joint of node '${node.name}'. Pass the full path from the SkeletalAnimation node, e.g. "mixamorig_Hips/mixamorig_Spine/.../mixamorig_RightHand".` };
            }
            const target = sk.createSocket(bonePath);
            if (!target) return { success: false, error: `createSocket returned null for bone path '${bonePath}'` };
            return { success: true, data: { targetUuid: target.uuid, targetName: target.name, bonePath, created: true, socketCount: sk.sockets.length } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /** List the sockets on a node's SkeletalAnimation: bone path + tracked target node uuid/name. */
    listSkeletalSockets(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const sk = node.getComponent('cc.SkeletalAnimation');
            if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
            const sockets = (sk.sockets || []).map((s: any) => ({
                path: s.path,
                targetUuid: s.target && s.target.uuid,
                targetName: s.target && s.target.name,
                targetChildren: s.target ? s.target.children.map((c: any) => c.name) : []
            }));
            return { success: true, data: { nodeUuid, useBakedAnimation: sk.useBakedAnimation, sockets } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Remove a SkeletalAnimation socket by bone path: drop the sockets[] entry, destroy its tracked
     * target node (and anything parented under it), and rebuild. Mirrors the socket `-` button.
     */
    removeSkeletalSocket(nodeUuid: string, bonePath: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const sk = node.getComponent('cc.SkeletalAnimation');
            if (!sk) return { success: false, error: 'Node has no cc.SkeletalAnimation component' };
            const match = (sk.sockets || []).find((s: any) => s && s.path === bonePath);
            if (!match) return { success: false, error: `No socket with bone path '${bonePath}' on this node` };
            const target = match.target;
            sk.sockets = (sk.sockets || []).filter((s: any) => s !== match);
            if (target && target.isValid) target.destroy();
            if (typeof sk.rebuildSocketAnimations === 'function') sk.rebuildSocketAnimations();
            return { success: true, data: { bonePath, removedTargetUuid: target && target.uuid, socketCount: sk.sockets.length } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Describe every property override on a prefab-instance node. The records live on
     * `node._prefab.instance.propertyOverrides` as CCPropertyOverrideInfo: a `targetInfo.localID`
     * chain naming the node or component inside the instance, a `propertyPath`, and the overriding
     * `value`. The editor appends them as the scene is edited and never re-derives them from a diff
     * on save, so a record outlives the value it was written for — an asset ref whose uuid stopped
     * resolving keeps being serialised into the .scene and keeps failing to load at runtime.
     * Asset liveness is deliberately NOT judged here: the engine cache still hands back a reimported
     * asset under its old uuid, so the caller resolves each `assetUuid` against the asset database.
     */
    listPrefabOverrides(nodeUuid: string) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const instance = node._prefab && node._prefab.instance;
            if (!instance) {
                const root = findPrefabInstanceRoot(node);
                const hint = root
                    ? ` The enclosing prefab instance root is '${root.name}' (uuid ${root.uuid}) — pass that.`
                    : ' This node is not part of a prefab instance.';
                return { success: false, error: `Node '${node.name}' carries no PrefabInstance.${hint}` };
            }
            const targets = mapPrefabFileIds(node);
            const overrides = (instance.propertyOverrides || []).map((o: any, index: number) => {
                const localID: string[] = (o.targetInfo && o.targetInfo.localID) || [];
                const propertyPath: string[] = o.propertyPath || [];
                return {
                    index,
                    propertyPath: propertyPath.join('.'),
                    propertyPathParts: propertyPath,
                    localID,
                    target: targets[localID[localID.length - 1]] || null,
                    ...describeOverrideValue(o.value)
                };
            });
            return {
                success: true,
                data: {
                    nodeUuid: node.uuid,
                    nodeName: node.name,
                    prefabAsset: node._prefab.asset && node._prefab.asset._uuid,
                    overrideCount: overrides.length,
                    removedComponents: (instance.removedComponents || []).length,
                    mountedChildren: (instance.mountedChildren || []).length,
                    overrides
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Drop ONE CCPropertyOverrideInfo from a prefab instance, leaving every other override
     * (transform, materials, designer-added components) untouched — which is what separates this
     * from restore-prefab, which discards the lot. The record is spliced off the live
     * `propertyOverrides` array and the editor serialises what remains on the next save, so the
     * file's `__id__` numbering is regenerated by the serialiser rather than patched by hand.
     * A propertyPath that matches several records (the same path on two child nodes) is refused
     * with the candidates listed; disambiguate with `localID` or `index`.
     */
    removePrefabOverride(nodeUuid: string, propertyPath: string | string[], localID?: string, index?: number) {
        try {
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const instance = node._prefab && node._prefab.instance;
            if (!instance) return { success: false, error: `Node '${node.name}' carries no PrefabInstance` };
            const all = instance.propertyOverrides || [];
            const wanted = Array.isArray(propertyPath) ? propertyPath.join('.') : String(propertyPath);
            const targets = mapPrefabFileIds(node);

            const matches = all
                .map((o: any, i: number) => ({ o, i }))
                .filter(({ o, i }: any) => {
                    if (typeof index === 'number' && i !== index) return false;
                    if ((o.propertyPath || []).join('.') !== wanted) return false;
                    if (!localID) return true;
                    const chain = (o.targetInfo && o.targetInfo.localID) || [];
                    return chain[chain.length - 1] === localID || chain.join('/') === localID;
                });

            if (!matches.length) {
                const paths = all.map((o: any) => (o.propertyPath || []).join('.'));
                return { success: false, error: `No override with propertyPath '${wanted}'${localID ? ` for localID '${localID}'` : ''} on '${node.name}'. Present: ${paths.join(', ') || '(none)'}` };
            }
            if (matches.length > 1) {
                const candidates = matches.map(({ o, i }: any) => {
                    const chain = (o.targetInfo && o.targetInfo.localID) || [];
                    const t = targets[chain[chain.length - 1]];
                    return `index ${i} (localID ${chain.join('/')}${t ? `, ${t.kind} ${t.path}` : ''})`;
                });
                return { success: false, error: `propertyPath '${wanted}' matches ${matches.length} overrides — pass localID or index. Candidates: ${candidates.join('; ')}` };
            }

            const { o, i } = matches[0];
            const chain = (o.targetInfo && o.targetInfo.localID) || [];
            const removed = {
                index: i,
                propertyPath: wanted,
                localID: chain,
                target: targets[chain[chain.length - 1]] || null,
                ...describeOverrideValue(o.value)
            };
            instance.propertyOverrides = all.filter((_x: any, k: number) => k !== i);
            return { success: true, data: { nodeUuid: node.uuid, removed, remaining: instance.propertyOverrides.length } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Set a MeshRenderer / SkinnedMeshRenderer's material slots from an array of Material asset uuids,
     * via the ENGINE (`renderer.setMaterial(mat, i)`). The editor `set-property` channel cannot write
     * the `materials` array from asset refs — the array-of-assets dump throws and NULLs the slot — so
     * materials must be assigned on the live component. Assets are pulled from the engine asset cache
     * when already loaded, otherwise loaded by uuid. Sub-asset uuids ("<uuid>@<sub>") are accepted.
     * The editor serialises the assigned materials on the next scene/prefab save.
     */
    async setMeshRendererMaterials(nodeUuid: string, materialUuids: string[], componentType?: string) {
        try {
            const cc = require('cc');
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const renderer = componentType
                ? node.getComponent(componentType)
                : (node.getComponent('cc.SkinnedMeshRenderer') || node.getComponent('cc.MeshRenderer'));
            if (!renderer) return { success: false, error: 'Node has no MeshRenderer / SkinnedMeshRenderer component' };
            if (typeof renderer.setMaterial !== 'function') {
                return { success: false, error: `Component '${componentType || renderer.constructor.name}' has no setMaterial()` };
            }
            if (!Array.isArray(materialUuids) || materialUuids.length === 0) {
                return { success: false, error: 'materialUuids must be a non-empty array of Material asset uuids' };
            }
            const load = (uuid: string) => new Promise<any>((res) => {
                if (!uuid) return res(null);
                const cached = cc.assetManager.assets.get(uuid);
                if (cached) return res(cached);
                cc.assetManager.loadAny({ uuid }, (err: any, asset: any) => res(err ? null : asset));
            });
            const mats = await Promise.all(materialUuids.map(load));
            const missing = materialUuids.filter((_u, i) => !mats[i]);
            if (missing.length) return { success: false, error: `Could not load Material asset(s): ${missing.join(', ')}` };
            mats.forEach((m, i) => renderer.setMaterial(m, i));
            return {
                success: true,
                data: {
                    componentType: renderer.constructor.name,
                    count: mats.length,
                    materials: renderer.sharedMaterials.map((m: any) => m && m._uuid)
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * What the editor's serializer emits for one component property. `EditorExtends.serialize` is
     * the call the save path runs, so a property the Inspector dump shows as written and this one
     * does not emit is a write that vanishes on save.
     *
     * The path is resolved through `__id__` back-references, because an inline @ccclass such as a
     * TransformTweenSpec is serialized as its own entry rather than nested in the component — the
     * same indirection that makes `exit.duration` unreadable from the component object alone.
     */
    serializedComponentValue(nodeUuid: string, cid: string, property: string) {
        try {
            const cc = require('cc');
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);
            const component = (node.components || []).find((c: any) =>
                c && (cc.js as any)._getClassId(c.constructor) === cid);
            if (!component) {
                return { success: false, error: `No component with cid '${cid}' on node ${nodeUuid}` };
            }

            const serialized = (globalThis as any).EditorExtends.serialize(component, { stringify: false });
            const objects: any[] = Array.isArray(serialized) ? serialized : [serialized];

            let current: any = objects[0];
            for (const segment of property.split('.')) {
                if (current && typeof current === 'object' && typeof current.__id__ === 'number') {
                    current = objects[current.__id__];
                }
                if (!current || typeof current !== 'object' || !(segment in current)) {
                    return { success: true, data: { found: false, value: undefined } };
                }
                current = current[segment];
            }
            return { success: true, data: { found: true, value: plainSerialized(objects, current, 0) } };
        } catch (error: any) {
            return { success: false, error: error.message || String(error) };
        }
    },

    /**
     * Assign a cc.Node / Component reference (or an array of them) on the LIVE component.
     * The editor `set-property` channel needs the owning node's uuid plus Inspector metadata to guess
     * the field's component class, and hard-errors when a custom script has none; assigning on the
     * engine object needs neither, accepts a component uuid directly, and can address a specific
     * component on a node. The editor serialises the field on the next scene/prefab save.
     */
    setComponentReference(args: any = {}) {
        try {
            const cc = require('cc');
            const { nodeUuid, componentType, property } = args;
            if (!nodeUuid || !componentType || !property) {
                return { success: false, error: 'nodeUuid, componentType and property are required' };
            }
            const scene = requireActiveScene();
            const node = findNodeByUuid(scene, nodeUuid);

            let owner: any;
            if (args.componentIndex !== undefined && args.componentIndex !== null) {
                const sameType = (node.components || []).filter((c: any) => c && c.constructor && (c.constructor.name === componentType || cc.js.getClassName(c.constructor) === componentType));
                owner = sameType[args.componentIndex];
                if (!owner) return { success: false, error: `Node '${node.name}' has no '${componentType}' at componentIndex ${args.componentIndex} (found ${sameType.length})` };
            } else {
                owner = node.getComponent(componentType);
                if (!owner) return { success: false, error: `Node '${node.name}' has no '${componentType}' component` };
            }
            if (!(property in owner)) {
                return { success: false, error: `Component '${componentType}' has no property '${property}'` };
            }

            const fieldValue = owner[property];
            const fieldIsArray = Array.isArray(fieldValue);

            if (args.clear === true) {
                owner[property] = fieldIsArray ? [] : null;
                const cleared = owner[property];
                const clearVerified = fieldIsArray ? Array.isArray(cleared) && cleared.length === 0 : !cleared;
                if (!clearVerified) return { success: false, error: `Clearing '${property}' did not stick` };
                return { success: true, data: { property, assigned: [], assignedKind: 'null', verified: true } };
            }

            const callerGaveArray = Array.isArray(args.targetUuids);
            const uuids: string[] = callerGaveArray ? args.targetUuids : (args.targetUuid ? [args.targetUuid] : []);
            if (!uuids.length) {
                return { success: false, error: 'Pass targetUuid, targetUuids, or clear:true' };
            }
            // CCClass metadata reports the ELEMENT type for array fields, so the field's own value is
            // the only reliable signal of its shape.
            if (fieldIsArray && !callerGaveArray) {
                return { success: false, error: `'${property}' is an array field (currently ${fieldValue.length} entries) — pass targetUuids: [...]; a single targetUuid would replace the whole array` };
            }
            if (!fieldIsArray && fieldValue !== null && fieldValue !== undefined && callerGaveArray) {
                return { success: false, error: `'${property}' is a single-reference field — pass targetUuid, not targetUuids` };
            }

            const declaredCtor = declaredPropertyCtor(owner, property);
            const sampleExisting = fieldIsArray ? fieldValue.find((v: any) => v) : fieldValue;
            const inferredCtor = (!declaredCtor && sampleExisting && sampleExisting.constructor) || null;
            const effectiveCtor = declaredCtor || inferredCtor;
            const wantsNode = ctorIsA(effectiveCtor, cc.Node);
            const wantsComponent = ctorIsA(effectiveCtor, cc.Component);

            const resolved: any[] = [];
            for (const uuid of uuids) {
                const targetNode = findNodeByUuidOrNull(scene, uuid);
                if (targetNode) {
                    if (args.targetComponentType) {
                        const comp = targetNode.getComponent(args.targetComponentType);
                        if (!comp) return { success: false, error: `Target node '${targetNode.name}' has no '${args.targetComponentType}' component` };
                        resolved.push(comp);
                    } else if (wantsComponent && effectiveCtor) {
                        const comp = targetNode.getComponent(effectiveCtor);
                        if (!comp) return { success: false, error: `Target node '${targetNode.name}' has no '${cc.js.getClassName(effectiveCtor)}' component (the field '${property}' ${declaredCtor ? 'declares' : 'currently holds'} that type)` };
                        resolved.push(comp);
                    } else {
                        resolved.push(targetNode);
                    }
                    continue;
                }
                const targetComp = findComponentByUuid(scene, uuid);
                if (!targetComp) {
                    return {
                        success: false,
                        verified: false,
                        error: `Target uuid '${uuid}' matched no node and no component in the open scene. `
                            + 'A uuid captured before a scene reload or a script recompile can name nothing while still '
                            + 'looking valid — pass targetPath instead and it is resolved against the scene as it is now.'
                    };
                }
                resolved.push(wantsNode ? targetComp.node : targetComp);
            }

            if (declaredCtor) {
                const bad = resolved.find((v) => !(v instanceof declaredCtor));
                if (bad) {
                    return { success: false, error: `'${property}' declares ${cc.js.getClassName(declaredCtor)} but the resolved target is ${bad.constructor && bad.constructor.name}` };
                }
            }

            const assignArray = fieldIsArray || callerGaveArray;
            const expected = resolved.map((v) => v.uuid);
            owner[property] = assignArray ? resolved : resolved[0];

            const current = owner[property];
            const shapeOk = Array.isArray(current) === assignArray;
            const actual = Array.isArray(current) ? current.map((v: any) => v && v.uuid) : [current && current.uuid];
            const readBack = shapeOk && actual.length === expected.length && expected.every((u, i) => u === actual[i]);
            if (!readBack) {
                return {
                    success: false,
                    verified: false,
                    error: `Assignment did not stick: expected ${assignArray ? 'array' : 'single'} [${expected.join(', ')}], read back [${actual.join(', ')}]`
                };
            }

            // Reading the uuid back off the object just assigned proves the setter ran, and nothing
            // more. What produced the red "Missing Node" in the Inspector is a reference to an object
            // that is no longer part of the open scene: it answers with its uuid, the read-back agrees
            // with itself, and the serializer writes a uuid that resolves to nothing on load. So each
            // assigned value is re-resolved from the scene root, and the tool reports verified:false
            // when it cannot be found there — reporting success for a write into nowhere is the worst
            // thing this tool can do.
            const dangling = resolved
                .filter((v: any) => v.isValid === false
                    || !(findNodeByUuidOrNull(scene, v.uuid) || findComponentByUuid(scene, v.uuid)))
                .map((v: any) => `${v.uuid} (${v.name || (v.node && v.node.name) || v.constructor && v.constructor.name})`);
            if (dangling.length) {
                return {
                    success: false,
                    verified: false,
                    error: `'${property}' was assigned but the target is not reachable from the open scene: ${dangling.join(', ')}. `
                        + 'It will serialise as a reference that resolves to nothing (a red "Missing Node" in the Inspector). '
                        + 'Re-address the target by path.'
                };
            }

            return {
                success: true,
                data: {
                    property,
                    assigned: expected,
                    assignedKind: resolved[0] instanceof cc.Node ? 'node' : 'component',
                    assignedTypes: resolved.map((v) => v.constructor && v.constructor.name),
                    declaredType: declaredCtor ? cc.js.getClassName(declaredCtor) : null,
                    inferredType: !declaredCtor && inferredCtor ? cc.js.getClassName(inferredCtor) : null,
                    warning: !effectiveCtor && resolved[0] instanceof cc.Node
                        ? `No type metadata for '${property}' and it was empty — assigned the NODE. If a component was meant, pass targetComponentType.`
                        : undefined,
                    verified: true
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Resolve scene paths to node uuids against the scene the editor has open right now.
     *
     * Engine-side because this must see the live tree, including branches under an inactive
     * parent, and because resolving at call time is the entire point: a uuid captured earlier
     * may already name nothing. One walk answers the whole batch, so a tool call carrying
     * several paths costs one traversal.
     */
    resolveNodePaths(paths: any) {
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
    },

    /**
     * Flat inventory of every node in the scene. Engine-side because `activeInHierarchy` and real
     * component class names exist only on the live objects, not in the editor's node dump.
     */
    dumpSceneNodes(options: any = {}) {
        try {
            const scene = requireActiveScene();
            const withComps = options.includeComponents !== false;
            const withXform = options.includeTransform === true;
            const root = options.rootUuid ? findNodeByUuid(scene, options.rootUuid) : scene;
            const nodes: any[] = [];
            const walk = (parent: any, prefix: string) => {
                // Same-named siblings are common (crowds, bone rigs); without a suffix their paths
                // collide and a path-keyed diff goes blind to one of them. `siblingLabels` is the
                // same rule the path resolver indexes by, so every path printed here is one that
                // can be handed straight back as `nodePath`.
                const children = (parent.children || []).filter(Boolean);
                const labels = siblingLabels(children);
                children.forEach((child: any, i: number) => {
                    const label = labels[i];
                    const path = prefix ? `${prefix}/${label}` : label;
                    const entry: any = {
                        uuid: child.uuid,
                        name: child.name,
                        path,
                        parentUuid: child.parent ? child.parent.uuid : null,
                        active: child.active,
                        activeInHierarchy: child.activeInHierarchy,
                        childCount: (child.children || []).length
                    };
                    if (withComps) {
                        // `type` stays the JS constructor name because scene_checksum keys its
                        // signature on it — changing it would invalidate every baseline captured
                        // before this build. `className` is the registered name to address the
                        // component by, added alongside rather than replacing it.
                        entry.components = (child.components || []).map((c: any) => ({
                            type: c && c.constructor ? c.constructor.name : 'Unknown',
                            className: componentClassName(c),
                            uuid: c && c.uuid,
                            enabled: c ? c.enabled !== false : false
                        }));
                    }
                    if (withXform) {
                        entry.position = { x: child.position.x, y: child.position.y, z: child.position.z };
                        entry.rotation = { x: child.eulerAngles.x, y: child.eulerAngles.y, z: child.eulerAngles.z };
                        entry.scale = { x: child.scale.x, y: child.scale.y, z: child.scale.z };
                    }
                    nodes.push(entry);
                    walk(child, path);
                });
            };
            walk(root, options.rootUuid ? root.name : '');
            return { success: true, data: { sceneName: scene.name, nodeCount: nodes.length, nodes } };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    },

    /**
     * Every node in the open scene carrying a component of the given class.
     *
     * Answers "which node owns component X" directly. Reading it out of a prefab/scene file
     * instead means matching the 23-char compressed uuid the serializer writes, and the
     * usual shortcut — "the component appears in the file, so it must be on the root" — is
     * not something that check can actually distinguish, which has produced at least one
     * root-only-lookup runtime bug.
     */
    findComponentOwners(options: any = {}) {
        try {
            const className = typeof options === 'string' ? options : options.className;
            if (typeof className !== 'string' || !className.trim()) {
                return { success: false, error: "findComponentOwners requires a non-empty 'className'" };
            }
            const wanted = className.trim();
            const includeInactive = options.includeInactive !== false;
            const scene = requireActiveScene();

            const owners: any[] = [];
            let scanned = 0;
            const walk = (parent: any, prefix: string) => {
                const children = (parent.children || []).filter(Boolean);
                const labels = siblingLabels(children);
                children.forEach((child: any, i: number) => {
                    const path = prefix ? `${prefix}/${labels[i]}` : labels[i];
                    scanned++;
                    if (includeInactive || child.activeInHierarchy) {
                        // match the registered name, the bare JS name and the `cc.`-qualified
                        // spelling, so 'Sprite' and 'cc.Sprite' both resolve
                        const hits = (child.components || []).filter((c: any) => {
                            if (!c) return false;
                            const registered = componentClassName(c);
                            const js = c.constructor ? c.constructor.name : '';
                            return registered === wanted
                                || js === wanted
                                || `cc.${js}` === wanted
                                || registered === `cc.${wanted}`;
                        });
                        for (const c of hits) {
                            owners.push({
                                nodePath: path,
                                nodeUuid: child.uuid,
                                nodeName: child.name,
                                active: child.active,
                                activeInHierarchy: child.activeInHierarchy,
                                componentUuid: c.uuid,
                                className: componentClassName(c),
                                enabled: c.enabled !== false
                            });
                        }
                    }
                    walk(child, path);
                });
            };
            walk(scene, '');

            return {
                success: true,
                data: {
                    className: wanted,
                    sceneName: scene.name,
                    nodesScanned: scanned,
                    ownerCount: owners.length,
                    owners
                }
            };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    }
};
