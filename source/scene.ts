import { join } from 'path';
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
    evalInScene(code: string) {
        try {
            const cc = require('cc');
            const { director } = cc;
            const scene = director.getScene();
            // `cc`, `director` and `scene` are in scope for the evaluated code.
            void scene;
            // eslint-disable-next-line no-eval
            const result = eval(code);
            // Only return JSON-serialisable results across the IPC boundary.
            let data: any;
            try {
                JSON.stringify(result);
                data = result;
            } catch {
                data = result === undefined ? undefined : String(result);
            }
            return { success: true, data: { result: data } };
        } catch (error: any) {
            return { success: false, error: error.message, stack: error.stack };
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
    }
};
