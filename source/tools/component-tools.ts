import { ToolDefinition, ToolResponse, ToolExecutor, ComponentInfo } from '../types';
import { ANY_VALUE_TYPE, coerceJsonArg } from '../json-arg';

/**
 * A write checked twice: `mismatches` is what the LIVE component reads back, `persistence` is
 * what the editor's serializer would write to the file. They disagree exactly when a write is
 * lost on save, which is the case a live read-back alone reports as success.
 */
interface VerifyResult {
    found: boolean;
    actual: any;
    mismatches: string[];
    persistence: { checked: boolean; found: boolean; actual: any; mismatches: string[]; reason?: string };
    sceneNeedsSave: boolean | null;
}

export class ComponentTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'add_component',
                description: 'Add a component to a specific node. IMPORTANT: You must provide the nodeUuid parameter to specify which node to add the component to.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Target node UUID. REQUIRED: You must specify the exact node to add the component to. Use scene_dump or node_find_nodes to get the UUID of the desired node.'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Component type (e.g., cc.Sprite, cc.Label, cc.Button)'
                        }
                    },
                    required: ['nodeUuid', 'componentType']
                }
            },
            {
                name: 'remove_component',
                description: 'Remove a component from a node. componentType must be the component\'s classId (cid, i.e. the type field from getComponents), not the script name or class name. Use getComponents to get the correct cid.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Node UUID'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Component cid (type field from getComponents). Do NOT use script name or class name. Example: "cc.Sprite" or "9b4a7ueT9xD6aRE+AlOusy1"'
                        }
                    },
                    required: ['nodeUuid', 'componentType']
                }
            },
            {
                name: 'get_components',
                description: 'Get all components of a node',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Node UUID'
                        }
                    },
                    required: ['nodeUuid']
                }
            },
            {
                name: 'get_component_info',
                description: 'Get one component\'s property dump. Pass `properties` to fetch only the entries you ' +
                    'asked about — a component with nested serializable arrays dumps tens of KB otherwise.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Node UUID'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Component type to get info for'
                        },
                        properties: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Return only these property entries. Dotted paths address nested fields and ' +
                                'array indices, e.g. "waves.0.squads". Omit for the whole dump.'
                        }
                    },
                    required: ['nodeUuid', 'componentType']
                }
            },
            {
                name: 'set_component_property',
                description: 'Set a property on a built-in or custom script component. The target\'s real type comes ' +
                    'from the component dump, so this writes primitives, colours/vectors, enums, asset and node ' +
                    'references, arrays of those, nested sub-properties addressed by a DOTTED PATH, an INLINE ' +
                    'SERIALIZABLE @ccclass written whole by its own name, and ARRAYS OF A ' +
                    'SERIALIZABLE @ccclass — including asset references nested inside the elements — in ONE call. ' +
                    'An array is written whole: to add, insert or remove an element, read the array, edit it and set ' +
                    'the full array back (there is deliberately no add_array_element). An inline @ccclass is the ' +
                    'opposite — property "enter" with value {"duration":0.5,"toScale":{"x":2,"y":2,"z":2}} PATCHES ' +
                    'the named members and leaves every member you omit alone, and a misspelled member is an error ' +
                    'rather than a silent no-op. ' +
                    'THE WRITE LANDS IN THE OPEN SCENE, NOT IN THE SCENE FILE. `sceneNeedsSave` is the one field ' +
                    'that has looked at the file: true means the scene now differs from it and the person at the ' +
                    'editor has to save (do not save on their behalf), false means the write matched what the file ' +
                    'already held, null means the comparison was unavailable. `changeVerified` is the live ' +
                    'component read back; `serializerVerified` with `serializedValue` is the editor\'s serializer ' +
                    '— the call the save path runs — agreeing, so a save would carry the value. Those two say ' +
                    'nothing about the file. ' +
                    'Note: For node basic properties (name, active, layer, etc.), use set_node_property. For node ' +
                    'transform properties (position, rotation, scale, etc.), use set_node_transform.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Target node UUID - Must specify the node to operate on'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Component type - Can be built-in components (e.g., cc.Label) or custom script components (e.g., MyScript). If unsure about component type, use get_components first to retrieve all components on the node.',
                            // Remove enum restriction, allow any component type including custom scripts
                        },
                        property: {
                            type: 'string',
                            description: 'Property name - The property to set. Common properties include:\n' +
                                '• cc.Label: string (text content), fontSize (font size), color (text color)\n' +
                                '• cc.Sprite: spriteFrame (sprite frame), color (tint color), sizeMode (size mode)\n' +
                                '• cc.Button: normalColor (normal color), pressedColor (pressed color), target (target node)\n' +
                                '• cc.UITransform: contentSize (content size), anchorPoint (anchor point)\n' +
                                '• Custom Scripts: Based on properties defined in the script\n' +
                                '• Nested/sub-module properties: use a DOT PATH, e.g.\n' +
                                '  "rateOverTime.constant", "startColor.color", "startColor.mode",\n' +
                                '  "colorOverLifetimeModule.enable", "colorOverLifetimeModule.color".'
                        },
                        propertyType: {
                            type: 'string',
                            description: 'OPTIONAL type hint. The property type is read from the component dump, so ' +
                                'omit it and the value is typed correctly on its own; pass it only to override the ' +
                                'dump or when the dump does not expose the property.\n' +
                                'ACCEPTED VALUES ARE OPEN-ENDED, not a fixed list:\n' +
                                '• keywords: string, number, integer, float, boolean, color, vec2, vec3, size, enum,\n' +
                                '  node, component, spriteFrame, prefab, asset,\n' +
                                '  nodeArray, colorArray, numberArray, stringArray\n' +
                                '• any cc.* class name: "cc.Node", "cc.Prefab", "cc.Material", "cc.Vec3", ...\n' +
                                '• any @ccclass name from your own scripts, including one used as an ARRAY ELEMENT\n' +
                                '  type: propertyType "WaveSquad" for a WaveSquad[] property.\n' +
                                'A DOTTED `property` path ("waves.0.squads", "colorOverLifetimeModule.color") is\n' +
                                'resolved from the dump and needs no hint. Only "gradient" and "curve" cannot be\n' +
                                'inferred — pass those explicitly for particle GradientRange / CurveRange fields.'
                        },

                        value: {
                            type: ANY_VALUE_TYPE,
                            description: 'Property value - Use the corresponding data format based on propertyType:\n\n' +
                                '📝 Basic Data Types:\n' +
                                '• string: "Hello World" (text string)\n' +
                                '• number/integer/float: 42 or 3.14 (numeric value)\n' +
                                '• boolean: true or false (boolean value)\n\n' +
                                '🎨 Color Type:\n' +
                                '• color: {"r":255,"g":0,"b":0,"a":255} (RGBA values, range 0-255)\n' +
                                '  - Alternative: "#FF0000" (hexadecimal format)\n' +
                                '  - Transparency: a value controls opacity, 255 = fully opaque, 0 = fully transparent\n\n' +
                                '📐 Vector and Size Types:\n' +
                                '• vec2: {"x":100,"y":50} (2D vector)\n' +
                                '• vec3: {"x":1,"y":2,"z":3} (3D vector)\n' +
                                '• size: {"width":100,"height":50} (size dimensions)\n\n' +
                                '🔗 Reference Types (using UUID strings):\n' +
                                '• node: "target-node-uuid" (node reference)\n' +
                                '  How to get: Use scene_dump or node_find_nodes to get node UUIDs\n' +
                                '• component: "target-node-uuid" (component reference)\n' +
                                '  How it works: \n' +
                                '    1. Provide the UUID of the NODE that contains the target component\n' +
                                '    2. System auto-detects required component type from property metadata\n' +
                                '    3. Finds the component on target node and gets its scene __id__\n' +
                                '    4. Sets reference using the scene __id__ (not node UUID)\n' +
                                '  Example: value="label-node-uuid" will find cc.Label and use its scene ID\n' +
                                '• spriteFrame: "spriteframe-uuid" (sprite frame asset)\n' +
                                '  How to get: Check asset database or use asset browser\n' +
                                '• prefab: "prefab-uuid" (prefab asset)\n' +
                                '  How to get: Check asset database or use asset browser\n' +
                                '• asset: "asset-uuid" (generic asset reference)\n' +
                                '  How to get: Check asset database or use asset browser\n\n' +
                                '📋 Array Types:\n' +
                                '• nodeArray: ["uuid1","uuid2"] (array of node UUIDs)\n' +
                                '• colorArray: [{"r":255,"g":0,"b":0,"a":255}] (array of colors)\n' +
                                '• numberArray: [1,2,3,4,5] (array of numbers)\n' +
                                '• stringArray: ["item1","item2"] (array of strings)\n\n' +
                                '🧩 Array of a serializable @ccclass — one call, FLAT objects, asset fields as bare\n' +
                                '   uuid strings. For WaveSpawner.waves: WaveEntry[] where\n' +
                                '   WaveEntry = {squads: WaveSquad[], spawnInterval, startDelay} and\n' +
                                '   WaveSquad = {prefab: cc.Prefab, count: number}:\n' +
                                '   property "waves", value\n' +
                                '   [{"squads":[{"prefab":"5965dcc0-…","count":10}],"spawnInterval":0.8,"startDelay":0.5}]\n' +
                                '   Nested asset/node references inside the elements are resolved by the tool.\n' +
                                '   The array is REPLACED: a field you omit takes the element type\'s declared\n' +
                                '   default, so read-edit-write the whole array to add or remove elements.\n\n' +
                                '🌈 Gradient (propertyType "gradient", for a particle GradientRange like\n' +
                                '   startColor or colorOverLifetimeModule.color):\n' +
                                '   {"mode":1, "enable":true,\n' +
                                '    "colorKeys":[{"color":{"r":255,"g":150,"b":40,"a":255},"time":0}, ...],\n' +
                                '    "alphaKeys":[{"alpha":255,"time":0}, {"alpha":0,"time":1}]}\n' +
                                '   (time is 0..1; mode 1 = Gradient; enable turns on the sub-module)\n\n' +
                                '📈 Curve (propertyType "curve", for a particle CurveRange like\n' +
                                '   sizeOvertimeModule.size, rateOverTime, startSizeX):\n' +
                                '   {"mode":1, "multiplier":1, "enable":true,\n' +
                                '    "keyframes":[{"time":0,"value":1.0},{"time":1,"value":2.4}]}\n' +
                                '   (time 0..1; mode 1 = Curve; final = spline(t) * multiplier)'
                        }
                    },
                    required: ['nodeUuid', 'componentType', 'property', 'value']
                }
            },
            {
                name: 'attach_script',
                description: 'Attach a script component to a node',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'Node UUID'
                        },
                        scriptPath: {
                            type: 'string',
                            description: 'Script asset path (e.g., db://assets/scripts/MyScript.ts)'
                        }
                    },
                    required: ['nodeUuid', 'scriptPath']
                }
            },
            {
                name: 'set_materials',
                description: 'Set the material slots of a MeshRenderer / SkinnedMeshRenderer from an array of Material ' +
                    'asset uuids (slot i <- materialUuids[i]). Use this instead of set_component_property for the ' +
                    'materials array: the editor set-property channel cannot write an asset array and corrupts the ' +
                    'slot. Assets may be plain or sub-asset uuids ("<uuid>@<sub>").',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'UUID of the node holding the renderer'
                        },
                        materialUuids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: 'Material asset uuids, one per slot in order'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Optional explicit renderer type (e.g. cc.MeshRenderer, cc.SkinnedMeshRenderer). ' +
                                'Defaults to the node\'s SkinnedMeshRenderer or MeshRenderer.'
                        }
                    },
                    required: ['nodeUuid', 'materialUuids']
                }
            },
            {
                name: 'get_materials',
                description: 'List the material asset uuids currently bound to each slot of a node\'s MeshRenderer / SkinnedMeshRenderer.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: {
                            type: 'string',
                            description: 'UUID of the node holding the renderer'
                        },
                        componentType: {
                            type: 'string',
                            description: 'Optional explicit renderer type; defaults to SkinnedMeshRenderer or MeshRenderer.'
                        }
                    },
                    required: ['nodeUuid']
                }
            },
            {
                name: 'set_component_ref',
                description: 'Write a cc.Node or Component REFERENCE field (single or array) on a component. Use this — ' +
                    'NOT set_component_property — for any field whose type is a node or a component. targetUuid accepts ' +
                    'either a NODE uuid or a COMPONENT uuid (from scene_dump / get_components); the field\'s declared ' +
                    'type decides what gets assigned, and targetComponentType picks a specific component on a target ' +
                    'node. Works for custom scripts with no Inspector metadata and for a second component of the same ' +
                    'class (componentIndex). The reported verdict is what the field will hold after the NEXT LOAD, not ' +
                    'what reads back now: a reference pointing into a prefab instance lives in a target override rather ' +
                    'than in the scene file, and success:false says so when one could not be recorded.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        nodeUuid: { type: 'string', description: 'UUID of the node holding the component that OWNS the field' },
                        componentType: { type: 'string', description: 'Class name of the owning component (e.g. StickAim, cc.Camera)' },
                        componentIndex: { type: 'number', description: 'Index among same-class components on that node (default 0)' },
                        property: { type: 'string', description: 'Name of the reference field to write' },
                        targetUuid: { type: 'string', description: 'Node uuid or component uuid to assign' },
                        targetUuids: { type: 'array', items: { type: 'string' }, description: 'Use instead of targetUuid to write an ARRAY field' },
                        targetComponentType: { type: 'string', description: 'Assign this component of the target node rather than the node itself' },
                        clear: { type: 'boolean', description: 'Set the field to null (or [] if it is an array) instead of assigning' }
                    },
                    required: ['nodeUuid', 'componentType', 'property']
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'add_component':
                return await this.addComponent(args.nodeUuid, args.componentType);
            case 'remove_component':
                return await this.removeComponent(args.nodeUuid, args.componentType);
            case 'get_components':
                return await this.getComponents(args.nodeUuid);
            case 'get_component_info':
                return await this.getComponentInfo(args.nodeUuid, args.componentType, args.properties);
            case 'set_component_property':
                return await this.setComponentProperty(args);
            case 'attach_script':
                return await this.attachScript(args.nodeUuid, args.scriptPath);
            case 'set_materials':
                return await this.setMaterials(args.nodeUuid, args.materialUuids, args.componentType);
            case 'get_materials':
                return await this.getMaterials(args.nodeUuid, args.componentType);
            case 'set_component_ref':
                return await this.setComponentRef(args);
            default:
                throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /** One `execute-scene-script` round trip; a transport failure comes back as a failed response. */
    private async sceneScript(method: string, args: any[]): Promise<any> {
        try {
            return await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server', method, args
            });
        } catch (err: any) {
            return { success: false, error: (err && err.message) || String(err) };
        }
    }

    /**
     * Write a node/component reference through the editor's own set-property channel, then report
     * what the field will hold after the NEXT LOAD rather than what the setter just returned.
     *
     * The channel is the fix, not a preference. A reference pointing into a prefab instance is never
     * written into the scene file: the serializer emits null for it and the editor records a
     * cc.TargetOverrideInfo, which is replayed after load. Assigning on the live engine object —
     * what this tool used to do — produces no such record, so the value read back perfectly, the
     * tool reported verified:true, and the wiring was gone the next time the scene was opened.
     *
     * Direct assignment survives only as the fallback for a field the channel refuses, and the
     * response names it. Either way the verdict comes from re-reading the scene.
     */
    private async setComponentRef(args: any): Promise<ToolResponse> {
        const componentType: string = args.componentType;
        const plan = await this.sceneScript('resolveComponentReference', [args]);
        if (!plan || plan.success !== true || !plan.data) {
            return { success: false, error: (plan && plan.error) || 'the scene script did not answer' };
        }
        const { componentIndex, property, isArray, dumpType, uuids, expected, assignedNames } = plan.data;
        const path = `__comps__.${componentIndex}.${property}`;
        const element = (uuid: string) => ({ type: dumpType, value: { uuid } });
        const dump = isArray
            ? { type: dumpType, isArray: true, value: (uuids as string[]).map(element) }
            : element(uuids[0] || '');

        let wroteVia = 'editor set-property';
        try {
            await Editor.Message.request('scene', 'set-property', { uuid: args.nodeUuid, path, dump });
        } catch (err: any) {
            const refusal = (err && err.message) || String(err);
            const direct = await this.sceneScript('applyComponentReference', [args]);
            if (!direct || direct.success !== true) {
                return {
                    success: false,
                    error: `set-property refused '${path}' (${refusal}), and assigning on the live component failed too: `
                        + `${(direct && direct.error) || 'the scene script did not answer'}`
                };
            }
            wroteVia = `live assignment — set-property refused '${path}': ${refusal}`;
        }

        const pruned = await this.sceneScript('pruneComponentReferenceOverrides', [args.nodeUuid, componentIndex, property]);
        const outcome = await this.sceneScript('componentReferenceOutcome', [args.nodeUuid, componentIndex, property]);
        if (!outcome || outcome.success !== true || !outcome.data) {
            return {
                success: false,
                error: `${componentType}.${property} was written but the scene could not be re-read to check it: `
                    + `${(outcome && outcome.error) || 'the scene script did not answer'}. Treat the write as unproven.`
            };
        }
        return this.reportReferenceWrite(componentType, plan.data, outcome.data, pruned, wroteVia, expected, assignedNames);
    }

    /**
     * The verdict on a reference write: the live component first, then the value the next load
     * builds. A live match with a projection mismatch is the whole reason this tool exists — the
     * assignment happened and the link is not in anything that gets saved.
     */
    private reportReferenceWrite(
        componentType: string,
        plan: any,
        outcome: any,
        pruned: any,
        wroteVia: string,
        expected: Array<string | null>,
        assignedNames: string[]
    ): ToolResponse {
        const { property, isArray } = plan;
        const live: Array<string | null> = outcome.live;
        const projected: Array<string | null> = outcome.projected;
        const same = (a: Array<string | null>, b: Array<string | null>) =>
            a.length === b.length && a.every((value, index) => value === b[index]);
        const slot = (index: number) => (isArray ? `${property}.${index}` : property);
        const label = (uuid: string | null, name?: string) =>
            uuid ? `${uuid}${name ? ` (${name})` : ''}` : 'nothing';

        if (!same(live, expected)) {
            return {
                success: false,
                error: `${componentType}.${property} did not take the write: asked for `
                    + `[${expected.map((u, i) => label(u, assignedNames[i])).join(', ')}], the component holds `
                    + `[${live.map((u) => label(u)).join(', ')}].`,
                data: { property, requested: expected, live, wroteVia }
            };
        }

        // Neither the scene file nor the prefab asset could answer, so there is no verdict to give.
        // Reporting a failure here would invent one; reporting success would hide that nobody looked.
        if (outcome.projectionChecked === false) {
            return {
                success: true,
                message: `Set ${componentType}.${property} (${expected.filter(Boolean).length} reference(s))`,
                warning: `Whether ${componentType}.${property} survives a save was NOT established: the component is `
                    + `inside a prefab instance whose asset could not be read, so what the next load rebuilds it from `
                    + `is unknown. The live component holds what was asked for.`,
                data: {
                    property, assigned: expected, assignedKind: plan.assignedKind,
                    wroteVia, verified: true, survivesReload: null
                }
            };
        }

        const differing: string[] = [];
        for (let index = 0; index < Math.max(expected.length, projected.length); index++) {
            if (expected[index] === projected[index]) continue;
            differing.push(`${slot(index)}: assigned ${label(expected[index], assignedNames[index])}, `
                + `the next load builds ${label(projected[index])}`);
        }
        if (differing.length) {
            return {
                success: false,
                error: `${componentType}.${property} was assigned on the live component but will NOT survive a save. `
                    + `${differing.join('; ')}. `
                    + (outcome.componentInSceneGraph === false
                        ? `'${componentType}' is on a node inside a prefab instance, so the scene file carries none of `
                          + `its properties directly — a value there persists only as a prefab property override, which `
                          + `this tool does not write. Set it in the Inspector, or on the prefab asset.`
                        : `A reference into a prefab instance is carried by a target override, and none was recorded for `
                          + `the slot(s) above, so the link exists on the live object only.`),
                data: {
                    property, requested: expected, live,
                    serialized: outcome.serialized, projected,
                    targetOverrides: outcome.overrides,
                    componentInSceneGraph: outcome.componentInSceneGraph,
                    wroteVia, verified: false, survivesReload: false
                }
            };
        }

        return {
            success: true,
            message: `Set ${componentType}.${property} (${expected.filter(Boolean).length} reference(s))`,
            data: {
                property,
                assigned: expected,
                assignedKind: plan.assignedKind,
                assignedTypes: plan.assignedTypes,
                declaredType: plan.declaredType,
                inferredType: plan.inferredType,
                warning: plan.warning,
                wroteVia,
                serialized: outcome.serialized,
                targetOverrides: outcome.overrides,
                prunedOverrides: (pruned && pruned.data && pruned.data.paths) || [],
                verified: true,
                survivesReload: true
            }
        };
    }

    /**
     * Set a renderer's material slots from Material asset uuids. Routes to the scene script
     * (`setMeshRendererMaterials`) which assigns via the engine `renderer.setMaterial(mat, i)` —
     * the editor `set-property` channel cannot write the materials array (it throws and nulls the
     * slot), which is why this needs a dedicated tool. The editor serialises the result on save.
     */
    private async setMaterials(nodeUuid: string, materialUuids: string[], componentType?: string): Promise<ToolResponse> {
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'setMeshRendererMaterials',
                args: [nodeUuid, materialUuids, componentType]
            });
            if (result && typeof result === 'object' && 'success' in result) {
                return result as ToolResponse;
            }
            return { success: true, data: result };
        } catch (err: any) {
            return { success: false, error: err.message || String(err) };
        }
    }

    /**
     * Read back a renderer's current per-slot material uuids. Uses a small inline scene eval so it
     * mirrors exactly what set_materials wrote, without adding another scene method.
     */
    private async getMaterials(nodeUuid: string, componentType?: string): Promise<ToolResponse> {
        try {
            const pick = componentType
                ? `node.getComponent(${JSON.stringify(componentType)})`
                : `(node.getComponent('cc.SkinnedMeshRenderer')||node.getComponent('cc.MeshRenderer'))`;
            const script =
                `(() => { const cc = require('cc'); const scene = cc.director.getScene();` +
                ` let node=null; const f=(n)=>{ if(n.uuid===${JSON.stringify(nodeUuid)}) node=n; n.children.forEach(f); }; scene.children.forEach(f);` +
                ` if(!node) return {success:false,error:'Node not found'};` +
                ` const mr = ${pick};` +
                ` if(!mr) return {success:false,error:'No MeshRenderer/SkinnedMeshRenderer'};` +
                ` return {success:true,data:{componentType:mr.constructor.name, materials: mr.sharedMaterials.map(m=>m&&m._uuid)}}; })()`;
            const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'evalInScene',
                args: [script]
            });
            // evalInScene wraps the eval value as { success, data: { result } }.
            if (result && result.success && result.data && result.data.result) {
                return result.data.result as ToolResponse;
            }
            return (result as ToolResponse) || { success: false, error: 'No result from scene eval' };
        } catch (err: any) {
            return { success: false, error: err.message || String(err) };
        }
    }

    // ----- Component identity resolver -------------------------------------------------
    // Custom script components appear in the node dump only under their class-id (cid,
    // e.g. "a1a43ZGW/..."), never under their @ccclass name. These helpers let callers
    // address a component by cid, @ccclass class name, OR builtin type ("cc.Sprite"),
    // and let post-verification match by cid so operations are not falsely reported as
    // failed just because the class NAME does not appear in the dump.

    /**
     * Extract the class name from a component's dump `name` field, which the editor
     * formats as "<NodeName><ClassName>", e.g. "NavMeshData<NavMesh>" or
     * "Player<MeshRenderer>". Works on both raw __comps__ entries (comp.value.name) and
     * processed component objects (comp.properties.name).
     */
    private componentClassName(comp: any): string | null {
        const nameVal = comp?.properties?.name?.value ?? comp?.value?.name?.value ?? comp?.name?.value;
        if (typeof nameVal === 'string') {
            const m = nameVal.match(/<([^>]+)>\s*$/);
            if (m) return m[1];
        }
        return null;
    }

    /** The class-id (cid) of a component regardless of dump shape. */
    private componentCid(comp: any): string | undefined {
        return comp?.type ?? comp?.__type__ ?? comp?.cid;
    }

    /**
     * Every id spelling a component can carry. A raw editor dump of a SCRIPT component
     * holds both `cid` (the compressed script uuid) and `type` (the class name), and they
     * differ — so a single-field reader silently disagrees with `getComponents`, whose
     * normalised `type` is `__type__ || cid || type`. Comparing against all of them keeps
     * the setter, the verifier and get_components addressing the same component.
     */
    private componentIds(comp: any): string[] {
        return [comp?.type, comp?.__type__, comp?.cid].filter((v: any): v is string => typeof v === 'string');
    }

    /**
     * Match a component against a caller-supplied `componentType`, which may be a cid, an
     * @ccclass class name, or a builtin type name ("cc.Sprite").
     */
    private componentMatches(comp: any, componentType: string): boolean {
        if (!componentType) return false;
        if (this.componentIds(comp).includes(componentType)) return true;
        const cn = this.componentClassName(comp);
        return !!cn && (cn === componentType || `cc.${cn}` === componentType);
    }

    private async addComponent(nodeUuid: string, componentType: string): Promise<ToolResponse> {
        return new Promise(async (resolve) => {
            // Idempotency: match by cid OR @ccclass name so custom scripts are recognised.
            const before = await this.getComponents(nodeUuid);
            const beforeComps = before.success && before.data?.components ? before.data.components : [];
            const existing = beforeComps.find((c: any) => this.componentMatches(c, componentType));
            if (existing) {
                resolve({
                    success: true,
                    message: `Component '${componentType}' already exists on node (cid '${existing.type}')`,
                    data: { nodeUuid, componentType, resolvedCid: existing.type, className: existing.className, componentVerified: true, existing: true }
                });
                return;
            }
            const beforeCids = new Set(beforeComps.map((c: any) => c.type));

            // Attempt to add component via Editor API directly
            Editor.Message.request('scene', 'create-component', {
                uuid: nodeUuid,
                component: componentType
            }).then(async () => {
                await new Promise(r => setTimeout(r, 150));
                const after = await this.getComponents(nodeUuid);
                const afterComps = after.success && after.data?.components ? after.data.components : [];
                // Prefer a cid/name match; otherwise accept a newly-appeared component — a
                // custom script registers under a cid, not its class name, so the old
                // name-only check always false-failed on scripts.
                let added = afterComps.find((c: any) => this.componentMatches(c, componentType));
                if (!added) added = afterComps.find((c: any) => !beforeCids.has(c.type));
                if (added) {
                    resolve({
                        success: true,
                        message: `Component '${componentType}' added successfully (registered as cid '${added.type}')`,
                        data: { nodeUuid, componentType, resolvedCid: added.type, className: added.className, componentVerified: true, existing: false }
                    });
                } else {
                    resolve({
                        success: false,
                        error: `Component '${componentType}' was not found on node after addition. Available: ${afterComps.map((c: any) => c.className || c.type).join(', ')}`
                    });
                }
            }).catch((err: Error) => {
                // Fallback: use scene script
                const options = {
                    name: 'cocos-mcp-server',
                    method: 'addComponentToNode',
                    args: [nodeUuid, componentType]
                };
                Editor.Message.request('scene', 'execute-scene-script', options).then((result: any) => {
                    resolve(result);
                }).catch((err2: Error) => {
                    resolve({ success: false, error: `Direct API failed: ${err.message}, Scene script failed: ${err2.message}` });
                });
            });
        });
    }

    private async removeComponent(nodeUuid: string, componentType: string): Promise<ToolResponse> {
        return new Promise(async (resolve) => {
            // Step 1: Get all components on the node
            const allComponentsInfo = await this.getComponents(nodeUuid);
            if (!allComponentsInfo.success || !allComponentsInfo.data?.components) {
                resolve({ success: false, error: `Failed to get components for node '${nodeUuid}': ${allComponentsInfo.error}` });
                return;
            }
            // Step 2: Find the component by cid OR @ccclass name / builtin type.
            const target = allComponentsInfo.data.components.find((comp: any) => this.componentMatches(comp, componentType));
            if (!target) {
                resolve({ success: false, error: `Component '${componentType}' not found on node '${nodeUuid}'. Pass a cid, an @ccclass class name, or a builtin type (get_components lists both 'type' and 'className').` });
                return;
            }
            const cid = target.type; // remove-component needs the cid, not the class name
            // Step 3: Remove via official API. The 3.8 `remove-component` message takes the
            // COMPONENT's own scene uuid (properties.uuid.value) — the {uuid:node, component:cid}
            // form does NOT remove custom script components. Try the component-uuid form first,
            // then fall back to the node+cid form, verifying (with a settle) after each.
            const compSceneUuid: string | undefined = target?.properties?.uuid?.value || target?.uuid || undefined;
            const removePayloads: any[] = [];
            if (compSceneUuid) removePayloads.push({ uuid: compSceneUuid });
            removePayloads.push({ uuid: nodeUuid, component: cid });

            const stillHasCid = async (): Promise<boolean> => {
                const after = await this.getComponents(nodeUuid);
                return !!(after.success && after.data?.components?.some((comp: any) => comp.type === cid));
            };

            let removed = false;
            let lastErr = '';
            for (const payload of removePayloads) {
                try {
                    await Editor.Message.request('scene', 'remove-component', payload);
                } catch (err: any) {
                    lastErr = err.message;
                    continue;
                }
                let stillExists = true;
                for (let attempt = 0; attempt < 3 && stillExists; attempt++) {
                    await new Promise(r => setTimeout(r, 150));
                    stillExists = await stillHasCid();
                }
                if (!stillExists) { removed = true; break; }
            }

            if (removed) {
                resolve({
                    success: true,
                    message: `Component '${componentType}' (cid '${cid}') removed successfully from node '${nodeUuid}'`,
                    data: { nodeUuid, componentType, resolvedCid: cid, componentUuid: compSceneUuid }
                });
            } else {
                resolve({ success: false, error: `Component '${componentType}' (cid '${cid}') was not removed from node '${nodeUuid}'.${lastErr ? ' Last error: ' + lastErr : ''}` });
            }
        });
    }

    private async getComponents(nodeUuid: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Prefer Editor API for node info query
            Editor.Message.request('scene', 'query-node', nodeUuid).then((nodeData: any) => {
                if (nodeData && nodeData.__comps__) {
                    const components = nodeData.__comps__.map((comp: any) => ({
                        type: comp.__type__ || comp.cid || comp.type || 'Unknown',
                        // Readable @ccclass / builtin class name (e.g. "NavMesh") so callers
                        // don't have to carry the opaque cid around.
                        className: this.componentClassName(comp) || undefined,
                        uuid: comp.uuid?.value || comp.uuid || null,
                        enabled: comp.enabled !== undefined ? comp.enabled : true,
                        properties: this.extractComponentProperties(comp)
                    }));
                    
                    resolve({
                        success: true,
                        data: {
                            nodeUuid: nodeUuid,
                            components: components
                        }
                    });
                } else {
                    resolve({ success: false, error: 'Node not found or no components data' });
                }
            }).catch((err: Error) => {
                // Fallback: use scene script
                const options = {
                    name: 'cocos-mcp-server',
                    method: 'getNodeInfo',
                    args: [nodeUuid]
                };
                
                Editor.Message.request('scene', 'execute-scene-script', options).then((result: any) => {
                    if (result.success) {
                        resolve({
                            success: true,
                            data: result.data.components
                        });
                    } else {
                        resolve(result);
                    }
                }).catch((err2: Error) => {
                    resolve({ success: false, error: `Direct API failed: ${err.message}, Scene script failed: ${err2.message}` });
                });
            });
        });
    }

    private async getComponentInfo(nodeUuid: string, componentType: string, propertyFilter?: any): Promise<ToolResponse> {
        const wanted = this.normalizePropertyFilter(propertyFilter);
        return new Promise((resolve) => {
            // Prefer Editor API for node info query
            Editor.Message.request('scene', 'query-node', nodeUuid).then((nodeData: any) => {
                if (nodeData && nodeData.__comps__) {
                    const component = nodeData.__comps__.find((comp: any) => this.componentMatches(comp, componentType));

                    if (component) {
                        const all = this.extractComponentProperties(component);
                        resolve({
                            success: true,
                            data: {
                                nodeUuid: nodeUuid,
                                componentType: componentType,
                                resolvedCid: this.componentCid(component),
                                className: this.componentClassName(component) || undefined,
                                enabled: component.enabled !== undefined ? component.enabled : true,
                                ...(wanted ? { requestedProperties: wanted } : {}),
                                properties: wanted ? this.pickProperties(all, wanted) : all
                            }
                        });
                    } else {
                        resolve({ success: false, error: `Component '${componentType}' not found on node` });
                    }
                } else {
                    resolve({ success: false, error: 'Node not found or no components data' });
                }
            }).catch((err: Error) => {
                // Fallback: use scene script
                const options = {
                    name: 'cocos-mcp-server',
                    method: 'getNodeInfo',
                    args: [nodeUuid]
                };
                
                Editor.Message.request('scene', 'execute-scene-script', options).then((result: any) => {
                    if (result.success && result.data.components) {
                        const component = result.data.components.find((comp: any) => this.componentMatches(comp, componentType));
                        if (component) {
                            resolve({
                                success: true,
                                data: {
                                    nodeUuid: nodeUuid,
                                    componentType: componentType,
                                    ...component,
                                    ...(wanted && component.properties
                                        ? { requestedProperties: wanted, properties: this.pickProperties(component.properties, wanted) }
                                        : {})
                                }
                            });
                        } else {
                            resolve({ success: false, error: `Component '${componentType}' not found on node` });
                        }
                    } else {
                        resolve({ success: false, error: result.error || 'Failed to get component info' });
                    }
                }).catch((err2: Error) => {
                    resolve({ success: false, error: `Direct API failed: ${err.message}, Scene script failed: ${err2.message}` });
                });
            });
        });
    }

    /** The `properties` filter as a list of paths, or null when the caller wants the whole dump. */
    private normalizePropertyFilter(filter: any): string[] | null {
        const raw = coerceJsonArg(filter).value;
        const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : null);
        if (!list) return null;
        const paths = list.map((p: any) => String(p).trim()).filter(Boolean);
        return paths.length ? paths : null;
    }

    /** Resolve each requested (possibly dotted) path against a component dump. */
    private pickProperties(properties: Record<string, any>, paths: string[]): Record<string, any> {
        const picked: Record<string, any> = {};
        for (const path of paths) {
            const entry = this.resolveDumpPath(properties, path);
            picked[path] = entry !== undefined ? entry : {
                error: `'${path}' is not present in this component's dump`,
                availableProperties: Object.keys(properties)
            };
        }
        return picked;
    }

    private extractComponentProperties(component: any): Record<string, any> {
        console.log(`[extractComponentProperties] Processing component:`, Object.keys(component));
        
        // Check if component has a value property containing actual component attributes
        if (component.value && typeof component.value === 'object') {
            console.log(`[extractComponentProperties] Found component.value with properties:`, Object.keys(component.value));
            return component.value; // Return value object which contains all component properties
        }
        
        // Fallback: extract properties directly from component object
        const properties: Record<string, any> = {};
        const excludeKeys = ['__type__', 'enabled', 'node', '_id', '__scriptAsset', 'uuid', 'name', '_name', '_objFlags', '_enabled', 'type', 'readonly', 'visible', 'cid', 'editor', 'extends'];
        
        for (const key in component) {
            if (!excludeKeys.includes(key) && !key.startsWith('_')) {
                console.log(`[extractComponentProperties] Found direct property '${key}':`, typeof component[key]);
                properties[key] = component[key];
            }
        }
        
        console.log(`[extractComponentProperties] Final extracted properties:`, Object.keys(properties));
        return properties;
    }

    private async findComponentTypeByUuid(componentUuid: string): Promise<string | null> {
        console.log(`[findComponentTypeByUuid] Searching for component type with UUID: ${componentUuid}`);
        if (!componentUuid) {
            return null;
        }
        try {
            const nodeTree = await Editor.Message.request('scene', 'query-node-tree');
            if (!nodeTree) {
                console.warn('[findComponentTypeByUuid] Failed to query node tree.');
                return null;
            }

            const queue: any[] = [nodeTree];
            
            while (queue.length > 0) {
                const currentNodeInfo = queue.shift();
                if (!currentNodeInfo || !currentNodeInfo.uuid) {
                    continue;
                }

                try {
                    const fullNodeData = await Editor.Message.request('scene', 'query-node', currentNodeInfo.uuid);
                    if (fullNodeData && fullNodeData.__comps__) {
                        for (const comp of fullNodeData.__comps__) {
                            const compAny = comp as any; // Cast to any to access dynamic properties
                            // The component UUID is nested in the 'value' property
                            if (compAny.uuid && compAny.uuid.value === componentUuid) {
                                const componentType = compAny.__type__;
                                console.log(`[findComponentTypeByUuid] Found component type '${componentType}' for UUID ${componentUuid} on node ${fullNodeData.name?.value}`);
                                return componentType;
                            }
                        }
                    }
                } catch (e) {
                    console.warn(`[findComponentTypeByUuid] Could not query node ${currentNodeInfo.uuid}:`, e);
                }

                if (currentNodeInfo.children) {
                    for (const child of currentNodeInfo.children) {
                        queue.push(child);
                    }
                }
            }

            console.warn(`[findComponentTypeByUuid] Component with UUID ${componentUuid} not found in scene tree.`);
            return null;
        } catch (error) {
            console.error(`[findComponentTypeByUuid] Error while searching for component type:`, error);
            return null;
        }
    }

    /**
     * The MCP transport delivers every tool-argument `value` as a STRING: a boolean arrives
     * as "false", a vec2/size/color/asset object as its JSON text (e.g. '{"x":0,"y":1}' or
     * '{"uuid":"…"}'), an array as '[…]'. The typed switch and the asset/advanced paths below
     * all assume native JS types, so `Boolean("false")` became true, `typeof value === 'object'`
     * was false for vec2/color, and '{"uuid":…}' got wrapped whole into another {uuid}. Coerce
     * the string back to its intended shape up-front, based on propertyType. A genuine `string`
     * payload is never reinterpreted, and bare uuid strings (node/asset refs that are not JSON)
     * are left as-is for the downstream {uuid} wrapping.
     */
    private coerceIncomingValue(value: any, propertyType: string): any {
        if (typeof value !== 'string') {
            return value; // already a native value (e.g. from the mcp.mjs runner)
        }
        const pt = (propertyType || '').toString();
        if (pt === 'string') {
            return value; // never reinterpret a real string payload
        }
        // Any JSON object/array text, whatever the propertyType is called — a keyword
        // ('vec3', 'colorArray') or a real class name ('cc.Vec3', 'cc.Color'), which the
        // advanced path accepts and the old keyword whitelist did not cover.
        const json = coerceJsonArg(value);
        if (json.coerced) return json.value;
        const s = value.trim();
        if (pt === 'boolean') {
            if (s === 'true' || s === '1') return true;
            if (s === 'false' || s === '0' || s === '') return false;
            return value; // unusual string — Boolean() downstream keeps prior behaviour
        }
        // number/integer/float: Number(value) downstream already parses "42" correctly.
        return value;
    }

    /**
     * Write one component property.
     *
     * The target's type comes from the component dump, so `propertyType` is only a hint: it
     * names a shape the dump cannot describe (a particle gradient/curve) or overrides the dump
     * when the caller knows better. Which writer runs is decided by the resolved descriptor,
     * not by a keyword, so an @ccclass name, a cc.* class name and the old keywords all reach
     * the same code.
     *
     *   gradient / curve  -> engine API via scene script; set-property cannot write key arrays
     *   UITransform size  -> width/height and anchorX/anchorY are separate editor fields
     *   class array       -> full-array dump plus a second pass for the references inside it
     *   asset             -> metadata-driven per-slot asset dump
     *   everything else   -> one typed dump through the editor set-property channel
     */
    private async setComponentProperty(args: any): Promise<ToolResponse> {
        const { nodeUuid, componentType, property } = args;
        const propertyType: string = (args.propertyType === undefined || args.propertyType === null)
            ? '' : String(args.propertyType);
        let value = this.coerceIncomingValue(args.value, propertyType);

        try {
            const nodeRedirect = await this.checkAndRedirectNodeProperties(args);
            if (nodeRedirect) return nodeRedirect;

            const componentsResponse = await this.getComponents(nodeUuid);
            if (!componentsResponse.success || !componentsResponse.data) {
                return {
                    success: false,
                    error: `Failed to get components for node '${nodeUuid}': ${componentsResponse.error}`,
                    instruction: `Please verify that node UUID '${nodeUuid}' is correct. Use scene_dump or node_find_nodes to get the correct node UUID.`
                };
            }

            const allComponents: any[] = componentsResponse.data.components || [];
            const availableTypes: string[] = allComponents.map((comp: any) =>
                comp.className ? `${comp.className}(${comp.type})` : comp.type);
            const targetComponent = allComponents.find((comp: any) => this.componentMatches(comp, componentType));
            if (!targetComponent) {
                return {
                    success: false,
                    error: `Component '${componentType}' not found on node. Available components: ${availableTypes.join(', ')}`,
                    instruction: this.generateComponentSuggestion(componentType, availableTypes, property)
                };
            }
            const resolvedCid: string = targetComponent.type;

            if (propertyType === 'gradient') {
                return await this.writeParticleGradient(nodeUuid, componentType, property, value);
            }
            if (propertyType === 'curve') {
                return await this.writeParticleCurve(nodeUuid, componentType, property, value);
            }

            const rawIndex = await this.rawComponentIndex(nodeUuid, resolvedCid);
            if (rawIndex === -1) {
                return { success: false, error: `Could not find component '${componentType}' in the raw node dump, so '${property}' has no settable path` };
            }
            const basePath = `__comps__.${rawIndex}.${property}`;
            const descriptor = this.resolveDumpPath(targetComponent.properties || {}, property);

            // A String field keeps JSON-looking text verbatim; coerceIncomingValue only knows
            // that when the caller spelled out propertyType.
            if (typeof args.value === 'string' && !propertyType && descriptor && descriptor.type === 'String') {
                value = args.value;
            }

            if (componentType === 'cc.UITransform' && /^_?(contentSize|anchorPoint)$/.test(property)) {
                return await this.writeUITransformPair(nodeUuid, resolvedCid, rawIndex, property, value);
            }
            if (this.isClassArrayDescriptor(descriptor)) {
                return await this.writeClassArray(nodeUuid, resolvedCid, componentType, property, basePath, descriptor, value);
            }
            if (this.isClassDescriptor(descriptor) && value && typeof value === 'object' && !Array.isArray(value)) {
                return await this.writeClassValue(nodeUuid, resolvedCid, componentType, property, basePath, descriptor, value);
            }
            if (!property.includes('.')) {
                const assetResult = await this.trySetAssetProperty(
                    nodeUuid, resolvedCid, property, propertyType, value, targetComponent
                );
                if (assetResult) return assetResult;
            }
            if (propertyType === 'component'
                || (this.isComponentDescriptor(descriptor) && typeof value === 'string')) {
                return await this.writeComponentRef(nodeUuid, resolvedCid, componentType, property, basePath, value);
            }
            return await this.writeTypedProperty(
                nodeUuid, resolvedCid, componentType, property, basePath, propertyType, value, descriptor, targetComponent
            );
        } catch (error: any) {
            console.error(`[ComponentTools] Error setting property:`, error);
            return { success: false, error: `Failed to set property: ${error.message}` };
        }
    }

    // ----- Dump descriptors --------------------------------------------------------------
    // The editor describes every serialized field as a descriptor: { name, value, type,
    // extends, isArray, elementTypeData, ... }. These read that metadata, so the writers below
    // never have to guess from a property name or trust a caller-supplied keyword.

    /** Keys the editor puts on a descriptor. Anything else makes an object a plain value. */
    private static readonly DUMP_DESCRIPTOR_KEYS = new Set([
        'name', 'value', 'default', 'type', 'readonly', 'visible', 'animatable', 'tooltip',
        'isArray', 'elementTypeData', 'extends', 'displayName', 'displayOrder', 'group',
        'editorOnly', 'min', 'max', 'step', 'slide', 'enumList', 'userData', 'path', 'cid', 'method'
    ]);

    private isDumpDescriptor(candidate: any): boolean {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
        const keys = Object.keys(candidate);
        return keys.includes('value') && keys.every(key => ComponentTools.DUMP_DESCRIPTOR_KEYS.has(key));
    }

    /** Walk a dotted path — array indices included — over a component dump. */
    private resolveDumpPath(properties: Record<string, any>, path: string): any {
        const segments = path.split('.');
        let current: any = properties ? properties[segments[0]] : undefined;
        for (let i = 1; i < segments.length && current != null; i++) {
            current = current.value ? current.value[segments[i]] : undefined;
        }
        return current === null ? undefined : current;
    }

    private isAssetDescriptor(descriptor: any): boolean {
        return Array.isArray(descriptor?.extends) && descriptor.extends.includes('cc.Asset');
    }

    private isNodeDescriptor(descriptor: any): boolean {
        return descriptor?.type === 'cc.Node';
    }

    private isComponentDescriptor(descriptor: any): boolean {
        return Array.isArray(descriptor?.extends) && descriptor.extends.includes('cc.Component');
    }

    /** Asset, node or component field — the three the editor stores as a uuid, not inline. */
    private isReferenceDescriptor(descriptor: any): boolean {
        return this.isAssetDescriptor(descriptor)
            || this.isNodeDescriptor(descriptor)
            || this.isComponentDescriptor(descriptor);
    }

    /**
     * A serializable @ccclass stored inline: its dump `value` is a map of field descriptors.
     * cc.Color / cc.Vec3 are excluded — their `value` holds plain numbers, not descriptors.
     */
    private isClassDescriptor(descriptor: any): boolean {
        if (!descriptor || descriptor.isArray === true) return false;
        if (this.isReferenceDescriptor(descriptor)) return false;
        if (typeof descriptor.type === 'string' && descriptor.type.startsWith('cc.')) return false;
        const fields = descriptor.value;
        if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
        const entries = Object.values(fields);
        return entries.length > 0 && entries.every(field => this.isDumpDescriptor(field));
    }

    private isClassArrayDescriptor(descriptor: any): boolean {
        return descriptor?.isArray === true && this.isClassDescriptor(descriptor.elementTypeData);
    }

    private toUuidString(value: any): string | null {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
            if (typeof value.uuid === 'string') return value.uuid;
            if (typeof value.__uuid__ === 'string') return value.__uuid__;
        }
        return null;
    }

    /**
     * Accept a value in either spelling: the flat shape a human writes
     * ({prefab: '<uuid>', count: 10}) or the editor's own dump shape
     * ({type: 'WaveSquad', value: {prefab: {value: {uuid: '…'}}, count: {value: 10}}}).
     */
    private unwrapDumpValue(value: any): any {
        if (Array.isArray(value)) return value.map(item => this.unwrapDumpValue(item));
        if (this.isDumpDescriptor(value)) return this.unwrapDumpValue(value.value);
        if (value && typeof value === 'object') {
            const plain: Record<string, any> = {};
            for (const [key, item] of Object.entries(value)) plain[key] = this.unwrapDumpValue(item);
            return plain;
        }
        return value;
    }

    /** Index of a component in the raw `query-node` dump — the index a set-property path uses. */
    private async rawComponentIndex(nodeUuid: string, resolvedCid: string): Promise<number> {
        const rawNodeData: any = await Editor.Message.request('scene', 'query-node', nodeUuid);
        const comps: any[] = (rawNodeData && rawNodeData.__comps__) || [];
        for (let i = 0; i < comps.length; i++) {
            const type = comps[i].__type__ || comps[i].cid || comps[i].type || 'Unknown';
            if (type === resolvedCid) return i;
        }
        return -1;
    }

    // ----- Writers -----------------------------------------------------------------------

    /**
     * Write an array of a serializable @ccclass, references inside the elements included.
     *
     * The editor decodes a reference nested in an array element by ASSIGNING the dump onto the
     * live object instead of resolving the uuid: the field is silently left empty, or the write
     * throws `Cannot set property uuid of [object Object] which has only a getter` when an
     * asset is already in the slot. So the array goes in without its reference fields and each
     * reference is then written at its own dotted path, where the decoder does resolve it.
     */
    private async writeClassArray(
        nodeUuid: string,
        resolvedCid: string,
        componentType: string,
        property: string,
        basePath: string,
        descriptor: any,
        rawValue: any
    ): Promise<ToolResponse> {
        const template = descriptor.elementTypeData;
        const plain = this.unwrapDumpValue(rawValue);
        const elements: any[] | null = Array.isArray(plain)
            ? plain
            : (plain && typeof plain === 'object' ? [plain] : null);
        if (!elements) {
            return {
                success: false,
                error: `'${property}' takes ${this.describeClassArrayForm(descriptor)}; got ${JSON.stringify(rawValue)}`
            };
        }

        const built = elements.map((element, index) =>
            this.buildClassElement(template, element, `${basePath}.${index}`));
        try {
            await Editor.Message.request('scene', 'set-property', {
                uuid: nodeUuid,
                path: basePath,
                dump: { type: template.type, value: built.map(entry => entry.dump) }
            });
        } catch (err: any) {
            return {
                success: false,
                error: `Failed to write '${property}' as ${template.type}[]: ${err.message}. `
                    + `It takes ${this.describeClassArrayForm(descriptor)}`
            };
        }

        const references = built.reduce<Array<{ path: string; type: string; uuid: string }>>(
            (all, entry) => all.concat(entry.refs), []);
        const referenceErrors: string[] = [];
        for (const reference of references) {
            try {
                await Editor.Message.request('scene', 'set-property', {
                    uuid: nodeUuid,
                    path: reference.path,
                    dump: { type: reference.type, value: { uuid: reference.uuid } }
                });
            } catch (err: any) {
                referenceErrors.push(`${reference.path} (${reference.type}): ${err.message}`);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        const expected = built.map(entry => entry.expected);
        const check = await this.verifyAgainst(nodeUuid, resolvedCid, property, expected);
        const failures = referenceErrors.map(err => `reference write failed: ${err}`)
            .concat(check.mismatches)
            .concat(check.persistence.mismatches.map(m => `would not survive a save — ${m}`));

        if (failures.length) {
            return {
                success: false,
                error: `${componentType}.${property} did not land as requested: ${failures.join('; ')}`,
                data: {
                    nodeUuid, componentType, property,
                    elementType: template.type,
                    requested: expected,
                    actualValue: check.actual,
                    changeVerified: false,
                    ...this.serializerReport(check, property)
                }
            };
        }
        return {
            success: true,
            message: `Set ${componentType}.${property} = ${template.type}[${elements.length}]`
                + `${references.length ? `, ${references.length} nested reference(s) resolved` : ''}`,
            ...(check.found ? {} : { warning: `Wrote ${property} but the dump does not expose it for read-back.` }),
            data: {
                nodeUuid, componentType, property,
                elementType: template.type,
                elementCount: elements.length,
                references: references.map(reference => `${reference.path} = ${reference.uuid || '(cleared)'}`),
                actualValue: check.actual,
                changeVerified: check.found,
                ...this.serializerReport(check, property)
            }
        };
    }

    /**
     * Write a serializable @ccclass held inline by a component — `enter` on a StagingTween, not
     * an array element. The editor wants a RECURSIVE dump here: every member spelled as its own
     * {value,type} descriptor. Handing it the caller's flat object instead made it walk into a
     * raw number looking for `.value` and throw `Cannot use 'in' operator to search for 'value'
     * in 0.5`, so a whole authored block could not be written at all.
     *
     * Members the caller omits keep what they hold now — the live descriptor IS the template, so
     * this patches rather than replaces. That is the opposite of the array case above, and
     * deliberately: an array is addressed as a whole, a named block is addressed by member.
     */
    private async writeClassValue(
        nodeUuid: string,
        resolvedCid: string,
        componentType: string,
        property: string,
        basePath: string,
        descriptor: any,
        rawValue: any
    ): Promise<ToolResponse> {
        const supplied = this.unwrapDumpValue(rawValue);
        const built = this.buildClassPatch(descriptor, supplied, basePath);
        if (built.unknown.length) {
            return {
                success: false,
                error: `${componentType}.${property} (${descriptor.type}) has no member(s) `
                    + `${built.unknown.join(', ')}. Members: ${Object.keys(descriptor.value || {}).join(', ')}`
            };
        }

        try {
            await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: basePath, dump: built.dump });
        } catch (err: any) {
            return { success: false, error: `set-property failed for '${basePath}': ${err.message}` };
        }

        const referenceErrors: string[] = [];
        for (const reference of built.refs) {
            try {
                await Editor.Message.request('scene', 'set-property', {
                    uuid: nodeUuid,
                    path: reference.path,
                    dump: { type: reference.type, value: { uuid: reference.uuid } }
                });
            } catch (err: any) {
                referenceErrors.push(`${reference.path} (${reference.type}): ${err.message}`);
            }
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        const check = await this.verifyAgainst(nodeUuid, resolvedCid, property, built.expected);
        const failures = referenceErrors.map(err => `reference write failed: ${err}`)
            .concat(check.mismatches)
            .concat(check.persistence.mismatches.map(m => `would not survive a save — ${m}`));
        if (failures.length) {
            return {
                success: false,
                error: `${componentType}.${property} did not land as requested: ${failures.join('; ')}`,
                data: {
                    nodeUuid, componentType, property, dumpType: descriptor.type,
                    requested: built.expected, actualValue: check.actual, changeVerified: false,
                    ...this.serializerReport(check, property)
                }
            };
        }
        return {
            success: true,
            message: `Set ${componentType}.${property} (${descriptor.type}): `
                + `${Object.keys(built.expected).join(', ')}`,
            ...(check.found ? {} : { warning: `Wrote ${property} but the dump does not expose it for read-back.` }),
            data: {
                nodeUuid, componentType, property, dumpType: descriptor.type,
                membersWritten: Object.keys(built.expected),
                actualValue: check.actual, changeVerified: check.found,
                ...this.serializerReport(check, property)
            }
        };
    }

    /**
     * The live dump for an inline @ccclass with the supplied members overwritten in place, so
     * every member the caller did not name keeps its current value and its declared type.
     *
     * Reference members are stripped from the inline dump whether or not they were supplied: the
     * editor decodes a nested reference by assigning the dump onto the live object rather than
     * resolving the uuid, which silently empties the slot (the same reason writeClassArray writes
     * them by dotted path). A supplied one goes out as its own set-property call; an untouched
     * one is simply not written.
     */
    private buildClassPatch(
        descriptor: any, supplied: any, basePath: string
    ): { dump: any; refs: Array<{ path: string; type: string; uuid: string }>; expected: any; unknown: string[] } {
        const dump = JSON.parse(JSON.stringify(descriptor));
        const fields: Record<string, any> = dump.value || {};
        const refs: Array<{ path: string; type: string; uuid: string }> = [];
        const expected: Record<string, any> = {};
        const unknown: string[] = [];
        const given: Record<string, any> = (supplied && typeof supplied === 'object' && !Array.isArray(supplied))
            ? supplied : {};

        for (const [field, fieldTemplate] of Object.entries<any>(fields)) {
            if (this.isReferenceDescriptor(fieldTemplate)) delete fields[field];
        }

        for (const [field, value] of Object.entries(given)) {
            const fieldTemplate = (descriptor.value || {})[field];
            if (!fieldTemplate) { unknown.push(field); continue; }
            const fieldPath = `${basePath}.${field}`;

            if (this.isReferenceDescriptor(fieldTemplate)) {
                const uuid = this.toUuidString(value) || '';
                refs.push({ path: fieldPath, type: fieldTemplate.type, uuid });
                expected[field] = { uuid };
                continue;
            }
            if (this.isClassArrayDescriptor(fieldTemplate)) {
                const items: any[] = Array.isArray(value) ? value : [];
                const inner = items.map((item, index) =>
                    this.buildClassElement(fieldTemplate.elementTypeData, item, `${fieldPath}.${index}`));
                fields[field] = { type: fieldTemplate.elementTypeData.type, value: inner.map(entry => entry.dump) };
                inner.forEach(entry => refs.push(...entry.refs));
                expected[field] = inner.map(entry => entry.expected);
                continue;
            }
            if (this.isClassDescriptor(fieldTemplate)) {
                const inner = this.buildClassPatch(fieldTemplate, value, fieldPath);
                fields[field] = inner.dump;
                refs.push(...inner.refs);
                expected[field] = inner.expected;
                unknown.push(...inner.unknown.map(name => `${field}.${name}`));
                continue;
            }

            const leaf = this.buildTypedDump('', value, fieldTemplate.type, field, fieldTemplate);
            fields[field] = { ...fieldTemplate, value: leaf ? leaf.value : value };
            expected[field] = fields[field].value;
        }

        return { dump, refs, expected, unknown };
    }

    /**
     * One element of a serializable-class array: the dump to write inline, the reference fields
     * to write afterwards by path, and what the whole element should read back as. A field the
     * caller omitted takes the element type's declared default, so the array is a full
     * replacement rather than a patch over whatever occupied the index before.
     */
    private buildClassElement(
        template: any, supplied: any, pathPrefix: string
    ): { dump: any; refs: Array<{ path: string; type: string; uuid: string }>; expected: any } {
        const fields: Record<string, any> = (template && template.value) || {};
        const given: Record<string, any> = (supplied && typeof supplied === 'object' && !Array.isArray(supplied))
            ? supplied : {};
        const dumpValue: Record<string, any> = {};
        const refs: Array<{ path: string; type: string; uuid: string }> = [];
        const expected: Record<string, any> = {};

        for (const [field, fieldTemplate] of Object.entries<any>(fields)) {
            const fieldPath = `${pathPrefix}.${field}`;
            const hasValue = Object.prototype.hasOwnProperty.call(given, field);

            if (this.isReferenceDescriptor(fieldTemplate)) {
                const uuid = hasValue ? (this.toUuidString(given[field]) || '') : '';
                refs.push({ path: fieldPath, type: fieldTemplate.type, uuid });
                expected[field] = { uuid };
                continue;
            }
            if (fieldTemplate?.isArray === true && this.isReferenceDescriptor(fieldTemplate.elementTypeData)) {
                const items: any[] = hasValue && Array.isArray(given[field]) ? given[field] : [];
                const uuids = items.map(item => this.toUuidString(item) || '');
                const elementType = fieldTemplate.elementTypeData.type;
                dumpValue[field] = { type: elementType, value: uuids.map(uuid => ({ uuid })) };
                uuids.forEach((uuid, index) => refs.push({ path: `${fieldPath}.${index}`, type: elementType, uuid }));
                expected[field] = uuids.map(uuid => ({ uuid }));
                continue;
            }
            if (this.isClassArrayDescriptor(fieldTemplate)) {
                const items: any[] = hasValue && Array.isArray(given[field]) ? given[field] : [];
                const inner = items.map((item, index) =>
                    this.buildClassElement(fieldTemplate.elementTypeData, item, `${fieldPath}.${index}`));
                dumpValue[field] = {
                    type: fieldTemplate.elementTypeData.type,
                    value: inner.map(entry => entry.dump)
                };
                inner.forEach(entry => refs.push(...entry.refs));
                expected[field] = inner.map(entry => entry.expected);
                continue;
            }
            if (this.isClassDescriptor(fieldTemplate)) {
                const inner = this.buildClassElement(fieldTemplate, hasValue ? given[field] : {}, fieldPath);
                dumpValue[field] = inner.dump;
                refs.push(...inner.refs);
                expected[field] = inner.expected;
                continue;
            }

            const fallback = fieldTemplate?.value !== undefined ? fieldTemplate.value : fieldTemplate?.default;
            const plainValue = hasValue ? given[field] : fallback;
            dumpValue[field] = { type: fieldTemplate?.type, value: plainValue };
            expected[field] = plainValue;
        }

        return { dump: { type: template?.type, value: dumpValue }, refs, expected };
    }

    /** "an ARRAY of WaveSquad entries, e.g. [{"prefab":"<cc.Prefab asset uuid>","count":3}]" */
    private describeClassArrayForm(descriptor: any): string {
        const template = descriptor?.elementTypeData;
        return `an ARRAY of ${template?.type || 'object'} entries, `
            + `e.g. ${JSON.stringify([this.exampleForClass(template)])}`;
    }

    private exampleForClass(template: any): any {
        const example: Record<string, any> = {};
        for (const [field, fieldTemplate] of Object.entries<any>((template && template.value) || {})) {
            if (this.isAssetDescriptor(fieldTemplate)) {
                example[field] = `<${fieldTemplate.type} asset uuid>`;
            } else if (this.isNodeDescriptor(fieldTemplate) || this.isComponentDescriptor(fieldTemplate)) {
                example[field] = '<node uuid>';
            } else if (this.isClassArrayDescriptor(fieldTemplate)) {
                example[field] = [this.exampleForClass(fieldTemplate.elementTypeData)];
            } else if (this.isClassDescriptor(fieldTemplate)) {
                example[field] = this.exampleForClass(fieldTemplate);
            } else {
                example[field] = fieldTemplate?.value !== undefined ? fieldTemplate.value : fieldTemplate?.default;
            }
        }
        return example;
    }

    /** Everything the dump can describe: one typed dump through the editor set-property channel. */
    private async writeTypedProperty(
        nodeUuid: string,
        resolvedCid: string,
        componentType: string,
        property: string,
        basePath: string,
        propertyType: string,
        value: any,
        descriptor: any,
        targetComponent: any
    ): Promise<ToolResponse> {
        if (!descriptor && !propertyType) {
            const available = Object.keys(targetComponent?.properties || {});
            return {
                success: false,
                error: `Property '${property}' is not in ${componentType}'s dump and no propertyType was given, `
                    + `so its shape is unknown. Available properties: ${available.join(', ')}`,
                instruction: property.includes('.')
                    ? `A dotted path only resolves through values that already exist — set the parent array or object first, then address its elements.`
                    : `Pass propertyType to write a property the dump does not expose (e.g. a settable getter).`
            };
        }

        const leafName = property.split('.').pop() || property;
        const dump = this.buildTypedDump(propertyType, value, descriptor?.type, leafName, descriptor);
        if (!dump) {
            return {
                success: false,
                error: `Could not build a typed dump for '${property}' `
                    + `(propertyType='${propertyType || '(none)'}', dump type='${descriptor?.type || 'unknown'}', `
                    + `value=${JSON.stringify(value)})`
            };
        }

        try {
            await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path: basePath, dump });
        } catch (err: any) {
            return { success: false, error: `set-property failed for '${basePath}': ${err.message}` };
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        const check = await this.verifyAgainst(nodeUuid, resolvedCid, property, dump.value);
        const failures = (check.found ? check.mismatches : []).concat(
            check.persistence.mismatches.map(m => `would not survive a save — ${m}`));
        if (failures.length) {
            return {
                success: false,
                error: `The editor did not apply ${componentType}.${property}: ${failures.join('; ')}`,
                data: {
                    nodeUuid, componentType, property,
                    dumpType: dump.type || descriptor?.type || 'inferred',
                    requested: dump.value,
                    actualValue: check.actual,
                    changeVerified: false,
                    ...this.serializerReport(check, property)
                }
            };
        }
        return {
            success: true,
            message: `Successfully set ${componentType}.${property}`,
            ...(check.found ? {} : {
                warning: `Set ${componentType}.${property} but could not read it back for verification — `
                    + `'${property}' is not exposed in the component dump. The write itself did not error.`
            }),
            data: {
                nodeUuid, componentType, property,
                dumpType: dump.type || descriptor?.type || 'inferred',
                actualValue: check.actual,
                changeVerified: check.found,
                ...this.serializerReport(check, property)
            }
        };
    }

    /**
     * A component-typed field. The editor stores it by the target COMPONENT's scene uuid, so
     * the node uuid the caller passes is resolved against the field's declared component class.
     */
    private async writeComponentRef(
        nodeUuid: string,
        resolvedCid: string,
        componentType: string,
        property: string,
        basePath: string,
        value: any
    ): Promise<ToolResponse> {
        const targetNodeUuid = this.toUuidString(value);
        if (!targetNodeUuid) {
            return {
                success: false,
                error: `Component reference '${property}' expects the uuid of the NODE holding the target `
                    + `component; got ${JSON.stringify(value)}.`
            };
        }

        const info = await this.getComponentInfo(nodeUuid, componentType, [property]);
        const meta: any = info.success && info.data?.properties?.[property];
        let expectedComponentType = '';
        if (meta && typeof meta === 'object') {
            if (meta.type) {
                expectedComponentType = meta.type;
            } else if (meta.ctor) {
                expectedComponentType = meta.ctor;
            } else if (Array.isArray(meta.extends)) {
                for (const parent of meta.extends) {
                    if (parent.startsWith('cc.') && parent !== 'cc.Component' && parent !== 'cc.Object') {
                        expectedComponentType = parent;
                        break;
                    }
                }
            }
        }
        if (!expectedComponentType) {
            return {
                success: false,
                error: `Unable to determine the component type required by '${property}' on '${componentType}'.`,
                instruction: `Use set_component_ref — it assigns on the live object and needs no Inspector metadata.`
            };
        }

        const targetNodeData: any = await Editor.Message.request('scene', 'query-node', targetNodeUuid);
        const targetComps: any[] = (targetNodeData && targetNodeData.__comps__) || [];
        const match = targetComps.find((comp: any) => comp.type === expectedComponentType);
        const componentId: string | undefined = match?.value?.uuid?.value;
        if (!componentId) {
            return {
                success: false,
                error: `Component '${expectedComponentType}' not found on node ${targetNodeUuid}. `
                    + `Available: ${targetComps.map((comp: any) => comp.type).join(', ') || '(none)'}`
            };
        }

        try {
            await Editor.Message.request('scene', 'set-property', {
                uuid: nodeUuid,
                path: basePath,
                dump: { value: { uuid: componentId }, type: expectedComponentType }
            });
        } catch (err: any) {
            return { success: false, error: `set-property failed for '${basePath}': ${err.message}` };
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        const check = await this.verifyAgainst(nodeUuid, resolvedCid, property, { uuid: componentId });
        if (check.found && check.mismatches.length) {
            return {
                success: false,
                error: `The editor did not apply ${componentType}.${property}: ${check.mismatches.join('; ')}`,
                data: { nodeUuid, componentType, property, actualValue: check.actual, changeVerified: false }
            };
        }
        return {
            success: true,
            message: `Set ${componentType}.${property} -> ${expectedComponentType} on node ${targetNodeUuid}`,
            data: {
                nodeUuid, componentType, property,
                targetComponentType: expectedComponentType,
                targetComponentUuid: componentId,
                actualValue: check.actual,
                changeVerified: check.found
            }
        };
    }

    /** cc.UITransform stores contentSize and anchorPoint as two scalar fields each. */
    private async writeUITransformPair(
        nodeUuid: string, resolvedCid: string, rawIndex: number, property: string, value: any
    ): Promise<ToolResponse> {
        const isSize = property.toLowerCase().includes('contentsize');
        const fallback = isSize ? 100 : 0.5;
        // Number.isFinite, not `|| fallback`, so a legitimate 0 is not clobbered by the default.
        const pick = (raw: any) => Number.isFinite(Number(raw)) ? Number(raw) : fallback;
        const fields: Array<[string, number]> = isSize
            ? [['width', pick(value?.width)], ['height', pick(value?.height)]]
            : [['anchorX', pick(value?.x)], ['anchorY', pick(value?.y)]];

        for (const [field, fieldValue] of fields) {
            await Editor.Message.request('scene', 'set-property', {
                uuid: nodeUuid,
                path: `__comps__.${rawIndex}.${field}`,
                dump: { value: fieldValue }
            });
        }

        await new Promise(resolve => setTimeout(resolve, 200));
        const mismatches: string[] = [];
        const actual: Record<string, any> = {};
        for (const [field, fieldValue] of fields) {
            const check = await this.verifyAgainst(nodeUuid, resolvedCid, field, fieldValue);
            actual[field] = check.actual;
            mismatches.push(...check.mismatches);
        }
        if (mismatches.length) {
            return {
                success: false,
                error: `The editor did not apply cc.UITransform.${property}: ${mismatches.join('; ')}`,
                data: { nodeUuid, componentType: 'cc.UITransform', property, actualValue: actual, changeVerified: false }
            };
        }
        return {
            success: true,
            message: `Successfully set cc.UITransform.${property}`,
            data: { nodeUuid, componentType: 'cc.UITransform', property, actualValue: actual, changeVerified: true }
        };
    }

    /** Particle GradientRange — the only route that can write GradientColorKey arrays. */
    private async writeParticleGradient(
        nodeUuid: string, componentType: string, property: string, value: any
    ): Promise<ToolResponse> {
        const colorKeys = Array.isArray(value?.colorKeys) ? value.colorKeys : [];
        const alphaKeys = Array.isArray(value?.alphaKeys) ? value.alphaKeys : [];
        const enableModule = value?.enable === true || /module/i.test(property);
        let result: any;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'setParticleGradient',
                args: [nodeUuid, componentType, property, colorKeys, alphaKeys, value?.mode, enableModule]
            });
        } catch (err: any) {
            return { success: false, error: `Gradient scene script failed: ${err.message}` };
        }
        if (result && result.success) {
            const applied = Number(result.data?.colorKeys || 0);
            return {
                success: applied > 0,
                message: `Set gradient ${componentType}.${property} (${result.data?.colorKeys} colour / ${result.data?.alphaKeys} alpha keys)`,
                ...(applied > 0 ? {} : { error: `No gradient colour keys were applied to ${componentType}.${property}` }),
                data: { nodeUuid, componentType, property, ...result.data, changeVerified: applied > 0 }
            };
        }
        return { success: false, error: result?.error || 'Gradient set failed' };
    }

    /** Particle CurveRange — same reason as the gradient: set-property cannot write keyframes. */
    private async writeParticleCurve(
        nodeUuid: string, componentType: string, property: string, value: any
    ): Promise<ToolResponse> {
        const keyframes = Array.isArray(value?.keyframes) ? value.keyframes
            : (Array.isArray(value) ? value : []);
        const enableModule = value?.enable === true || /module/i.test(property);
        let result: any;
        try {
            result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'setParticleCurve',
                args: [nodeUuid, componentType, property, keyframes, value?.mode, value?.multiplier, enableModule]
            });
        } catch (err: any) {
            return { success: false, error: `Curve scene script failed: ${err.message}` };
        }
        if (result && result.success) {
            const keyCount = Number(result.data?.keyCount || 0);
            return {
                success: keyCount > 0,
                message: `Set curve ${componentType}.${property} (${result.data?.keyCount} keys, eval 0→1: ${result.data?.eval0}→${result.data?.eval1})`,
                ...(keyCount > 0 ? {} : { error: `No curve keyframes were applied to ${componentType}.${property}` }),
                data: { nodeUuid, componentType, property, ...result.data, changeVerified: keyCount > 0 }
            };
        }
        return { success: false, error: result?.error || 'Curve set failed' };
    }

    // ----- Read-back verification --------------------------------------------------------

    /**
     * Read the property back and report every place it disagrees with what was requested.
     * `found: false` means the dump does not expose the property at all — no evidence either
     * way, which is not the same as a contradiction and must not be reported as a failure.
     */
    private async verifyAgainst(
        nodeUuid: string, componentType: string, property: string, expected: any
    ): Promise<VerifyResult> {
        const persistence = await this.verifyPersisted(nodeUuid, componentType, property, expected);
        const sceneNeedsSave = await this.sceneNeedsSave();
        const read = await this.readDumpProperty(nodeUuid, componentType, property);
        if (!read.found) return { found: false, actual: undefined, mismatches: [], persistence, sceneNeedsSave };
        const actual = this.unwrapDumpValue(read.entry);
        const mismatches: string[] = [];
        this.collectMismatches(expected, actual, property, mismatches);
        return { found: true, actual, mismatches, persistence, sceneNeedsSave };
    }

    // The editor's dirty flag counts undo steps, which a set-property never moves; asked per write
    // because restoring the value the file already holds leaves nothing to save.
    private async sceneNeedsSave(): Promise<boolean | null> {
        try {
            const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'sceneDirtyAgainstDisk',
                args: []
            });
            if (!result || result.success !== true) return null;
            return result.data?.differsFromDisk === true;
        } catch {
            return null;
        }
    }

    /**
     * Compare the request against what the editor's serializer emits for the component, which is
     * the call the save path runs — not against the Inspector dump the live read-back uses.
     *
     * This catches a property the dump exposes but the serializer does not write, which is a write
     * that does nothing on save while reading back as applied. It does NOT prove the scene file
     * changed — nothing here writes the file — and it does not prove the value is safe either: the
     * serializer walks the same live object graph, so a loss that happened before it ran is
     * invisible to both checks. That boundary is why the result reports `serializerVerified` as its
     * own verdict instead of folding into `changeVerified`, and why an unreachable serializer
     * leaves `checked` false and says so rather than implying a pass.
     */
    private async verifyPersisted(
        nodeUuid: string, resolvedCid: string, property: string, expected: any
    ): Promise<{ checked: boolean; found: boolean; actual: any; mismatches: string[]; reason?: string }> {
        try {
            const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'serializedComponentValue',
                args: [nodeUuid, resolvedCid, property]
            });
            if (!result || result.success !== true) {
                return { checked: false, found: false, actual: undefined, mismatches: [], reason: result?.error || 'scene script unavailable' };
            }
            if (!result.data?.found) {
                return { checked: true, found: false, actual: undefined, mismatches: [] };
            }
            const actual = result.data.value;
            const mismatches: string[] = [];
            this.collectMismatches(expected, actual, property, mismatches);
            return { checked: true, found: true, actual, mismatches };
        } catch (err: any) {
            return { checked: false, found: false, actual: undefined, mismatches: [], reason: err?.message || String(err) };
        }
    }

    /**
     * How a write is reported once both checks have run. `changeVerified` means the live component
     * agrees; `serializerVerified` means the editor's serializer emits the value, so a save would
     * carry it.
     *
     * The field used to be `persistenceVerified`, which reads as "it is on disk" — and it never
     * was. `sceneNeedsSave` is the one field here that has looked at the file.
     */
    private serializerReport(check: VerifyResult, property: string): Record<string, any> {
        const { persistence, sceneNeedsSave } = check;
        if (!persistence.checked) {
            return {
                serializerVerified: false,
                sceneNeedsSave,
                serializerNote: `'${property}' was NOT verified against the serialized form `
                    + `(${persistence.reason || 'serializer unavailable'}). The live component agrees, which does `
                    + `not prove the value survives a save.`
            };
        }
        if (!persistence.found) {
            return {
                serializerVerified: false,
                sceneNeedsSave,
                serializerNote: `The serializer does not emit '${property}', so it could not be confirmed that `
                    + `a save would carry the value. The write itself did not error.`
            };
        }
        return { serializerVerified: true, serializedValue: persistence.actual, sceneNeedsSave };
    }

    /** Keys absent from `expected` are not compared — a partial write is checked partially. */
    private collectMismatches(expected: any, actual: any, path: string, out: string[]): void {
        if (expected === undefined) return;
        if (Array.isArray(expected)) {
            if (!Array.isArray(actual)) {
                out.push(`${path}: expected an array of ${expected.length}, read ${JSON.stringify(actual)}`);
                return;
            }
            if (actual.length !== expected.length) {
                out.push(`${path}: expected ${expected.length} element(s), read ${actual.length}`);
            }
            for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
                this.collectMismatches(expected[i], actual[i], `${path}.${i}`, out);
            }
            return;
        }
        if (expected && typeof expected === 'object') {
            if (!actual || typeof actual !== 'object') {
                out.push(`${path}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
                return;
            }
            for (const [key, nested] of Object.entries(expected)) {
                this.collectMismatches(nested, (actual as any)[key], `${path}.${key}`, out);
            }
            return;
        }
        if (!this.scalarEquals(expected, actual)) {
            out.push(`${path}: expected ${JSON.stringify(expected)}, read ${JSON.stringify(actual)}`);
        }
    }

    private scalarEquals(expected: any, actual: any): boolean {
        if (expected === actual) return true;
        if (expected === null || expected === undefined) return actual === null || actual === undefined;
        const expectedNumber = Number(expected);
        const actualNumber = Number(actual);
        if (Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) {
            return Math.abs(expectedNumber - actualNumber) < 1e-5;
        }
        return String(expected) === String(actual);
    }

    /**
     * Build a correctly typed editor `dump` ({type,value}) from the dump descriptor and the
     * caller's propertyType hint. Returns null when the value cannot be coerced.
     *
     * The `…Array` keywords and the asset keywords are aliases for shapes the descriptor
     * describes on its own; they stay accepted so existing callers keep working, and each one
     * produces the dump the editor already took before this was one path.
     */
    private buildTypedDump(propertyType: string, value: any, discovered?: string, propertyName?: string, descriptor?: any): any | null {
        const clamp = (v: any) => Math.min(255, Math.max(0, Number(v) || 0));
        const pt = propertyType || '';
        const dt = discovered || '';
        const wants = (kw: string, cc: string) => pt === kw || pt === cc || dt === cc;
        const asList = (v: any): any[] => Array.isArray(v) ? v : [v];
        const isArrayTarget = descriptor?.isArray === true || Array.isArray(value);

        if (pt === 'nodeArray' || (isArrayTarget && this.isNodeDescriptor(descriptor?.elementTypeData))) {
            const uuids = asList(value).map(item => this.toUuidString(item)).filter((u): u is string => u !== null);
            return { value: uuids.map(uuid => ({ uuid })) };
        }
        if (pt === 'colorArray' || (isArrayTarget && descriptor?.elementTypeData?.type === 'cc.Color')) {
            const colors = asList(value).map((item: any) => (typeof item === 'string')
                ? this.parseColorString(item)
                : {
                    r: clamp(item?.r), g: clamp(item?.g), b: clamp(item?.b),
                    a: item?.a !== undefined ? clamp(item.a) : 255
                });
            return { type: 'cc.Color', value: colors };
        }
        if (pt === 'numberArray' || (isArrayTarget && descriptor?.elementTypeData?.type === 'Number')) {
            return { value: asList(value).map(Number) };
        }
        if (pt === 'stringArray' || (isArrayTarget && descriptor?.elementTypeData?.type === 'String')) {
            return { value: asList(value).map(String) };
        }
        if (isArrayTarget && this.isAssetDescriptor(descriptor?.elementTypeData)) {
            const elementType = descriptor.elementTypeData.type;
            const uuids = asList(value).map(item => this.toUuidString(item) || '');
            return { type: elementType, value: uuids.map(uuid => ({ uuid })) };
        }
        if (pt === 'spriteFrame' || pt === 'prefab' || pt === 'asset' || this.isAssetDescriptor(descriptor)) {
            const uuid = this.toUuidString(value);
            if (uuid === null) return null;
            const assetType = dt.startsWith('cc.') ? dt
                : pt.startsWith('cc.') ? pt
                : pt === 'prefab' ? 'cc.Prefab'
                : pt === 'spriteFrame' ? 'cc.SpriteFrame'
                : this.guessAssetTypeByName(propertyName || '');
            return { type: assetType, value: { uuid } };
        }

        if (wants('color', 'cc.Color')) {
            const v = (typeof value === 'string')
                ? this.parseColorString(value)
                : {
                    r: clamp(value?.r), g: clamp(value?.g), b: clamp(value?.b),
                    a: value?.a !== undefined ? clamp(value.a) : 255
                };
            return { type: 'cc.Color', value: v };
        }
        if (wants('vec3', 'cc.Vec3')) {
            return { type: 'cc.Vec3', value: { x: Number(value?.x) || 0, y: Number(value?.y) || 0, z: Number(value?.z) || 0 } };
        }
        if (wants('vec2', 'cc.Vec2')) {
            return { type: 'cc.Vec2', value: { x: Number(value?.x) || 0, y: Number(value?.y) || 0 } };
        }
        if (wants('size', 'cc.Size')) {
            return { type: 'cc.Size', value: { width: Number(value?.width) || 0, height: Number(value?.height) || 0 } };
        }
        if (wants('node', 'cc.Node')) {
            const uuid = typeof value === 'string' ? value : value?.uuid;
            if (!uuid) return null;
            return { type: 'cc.Node', value: { uuid } };
        }
        if (pt === 'enum' || dt === 'Enum') {
            return { value: Number(value) };
        }
        if (pt === 'boolean' || pt === 'cc.Boolean' || dt === 'Boolean') {
            return { value: Boolean(value) };
        }
        if (pt === 'string' || pt === 'cc.String' || dt === 'String') {
            return { value: String(value) };
        }
        if (pt === 'number' || pt === 'integer' || pt === 'float' || dt === 'Number') {
            return { value: Number(value) };
        }
        // A cc.* asset/type given as a uuid string (mesh/material/effect/etc.).
        if (dt.startsWith('cc.') && typeof value === 'string') {
            return { type: dt, value: { uuid: value } };
        }
        if ((pt.startsWith('cc.') || dt.startsWith('cc.')) && value && typeof value === 'object' && 'uuid' in value) {
            return { type: pt.startsWith('cc.') ? pt : dt, value: { uuid: value.uuid } };
        }
        // Last resort: pass a plain object/primitive through with whatever type we know.
        if (value !== undefined && value !== null) {
            const type = pt.startsWith('cc.') ? pt : (dt || undefined);
            return type ? { type, value } : { value };
        }
        return null;
    }

    /**
     * Read one property's dump entry through the exact call `get_components` serves, so a
     * read-back can never disagree with what the reporting tool shows. `found` separates
     * "the dump says something else" (a real failure) from "the dump does not expose this
     * property" (no evidence either way) — the two used to collapse into a false negative.
     */
    private async readDumpProperty(
        nodeUuid: string, componentType: string, property: string
    ): Promise<{ found: boolean; value: any; entry: any }> {
        const miss = { found: false, value: undefined, entry: undefined };
        try {
            const all = await this.getComponents(nodeUuid);
            const comps: any[] = (all.success && all.data?.components) || [];
            const comp = comps.find((c: any) => this.componentMatches(c, componentType));
            if (!comp) return miss;
            const segs = property.split('.');
            let cur: any = (comp.properties || {})[segs[0]];
            for (let i = 1; i < segs.length && cur != null; i++) {
                cur = cur.value ? cur.value[segs[i]] : undefined;
            }
            if (cur === undefined || cur === null) return miss;
            const value = (typeof cur === 'object' && 'value' in cur) ? cur.value : cur;
            return { found: true, value, entry: cur };
        } catch {
            return miss;
        }
    }

    /**
     * Metadata-driven asset assignment. Returns a ToolResponse when it handled the
     * property, or null when the property is not an asset assignment (so the caller
     * falls back to the normal typed-value path). Persists via the editor `set-property`
     * channel — the only route that serializes to disk.
     */
    private async trySetAssetProperty(
        nodeUuid: string,
        componentType: string,
        property: string,
        propertyType: string,
        value: any,
        targetComponent: any
    ): Promise<ToolResponse | null> {
        const dumpMap: Record<string, any> = (targetComponent && targetComponent.properties) || {};

        // Resolve the effective dump property. Renderers (cc.MeshRenderer, cc.SkinnedMeshRenderer)
        // expose an editable `sharedMaterials` array but no scalar `material`; the editor
        // inspector edits `sharedMaterials`, so map material/materials onto it.
        let effectiveProperty = property;
        let entry = dumpMap[property];
        if (!entry && (property === 'material' || property === 'materials') && dumpMap['sharedMaterials']) {
            effectiveProperty = 'sharedMaterials';
            entry = dumpMap['sharedMaterials'];
        }
        if (!entry) {
            return null; // Unknown property here; let the normal path report/handle it.
        }

        // Is this an asset-typed property? Assets extend cc.Asset. Detect from dump metadata
        // (scalar `extends`, or array element `extends`); the caller's propertyType hint can
        // also force asset handling. Node/component refs do NOT extend cc.Asset, so they are
        // correctly left to the normal path.
        const extendsHasAsset = (e: any): boolean =>
            Array.isArray(e?.extends) && e.extends.includes('cc.Asset');
        const isArray = entry.isArray === true || Array.isArray(entry.value);
        const elementMeta = entry.elementTypeData || (isArray ? undefined : entry);
        const assetByMeta = extendsHasAsset(entry) || extendsHasAsset(elementMeta);
        const assetByHint = propertyType === 'asset' || propertyType === 'spriteFrame' || propertyType === 'prefab';
        if (!assetByMeta && !assetByHint) {
            return null; // Not an asset assignment — normal path handles nodes/values/etc.
        }

        // The concrete asset class used as the dump `type` hint (e.g. cc.Material, cc.Mesh).
        const assetClass: string =
            (isArray ? (elementMeta?.type || entry.type) : entry.type) ||
            this.guessAssetTypeByName(effectiveProperty);

        // Normalize the incoming value into an array of uuid strings.
        const toUuid = (v: any): string | null => {
            if (typeof v === 'string') return v;
            if (v && typeof v === 'object' && typeof v.uuid === 'string') return v.uuid;
            return null;
        };
        const uuids: string[] = Array.isArray(value)
            ? value.map(toUuid).filter((u): u is string => u !== null)
            : (toUuid(value) !== null ? [toUuid(value) as string] : []);
        if (uuids.length === 0) {
            return {
                success: false,
                error: `Asset property '${property}' expects an asset uuid string or an array of uuid strings; got ${JSON.stringify(value)}`
            };
        }

        // Locate the component index in the raw node dump.
        const rawNodeData: any = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (!rawNodeData || !rawNodeData.__comps__) {
            return { success: false, error: 'Failed to get raw node data for asset assignment' };
        }
        let rawIndex = -1;
        for (let i = 0; i < rawNodeData.__comps__.length; i++) {
            const comp = rawNodeData.__comps__[i] as any;
            const compType = comp.__type__ || comp.cid || comp.type || 'Unknown';
            if (compType === componentType) { rawIndex = i; break; }
        }
        if (rawIndex === -1) {
            return { success: false, error: `Could not find component '${componentType}' index for asset assignment` };
        }

        const basePath = `__comps__.${rawIndex}.${effectiveProperty}`;
        try {
            if (isArray) {
                // Assign each provided uuid into its slot (slot 0 for a single material).
                for (let slot = 0; slot < uuids.length; slot++) {
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `${basePath}.${slot}`,
                        dump: { value: { uuid: uuids[slot] }, type: assetClass }
                    });
                }
            } else {
                await Editor.Message.request('scene', 'set-property', {
                    uuid: nodeUuid,
                    path: basePath,
                    dump: { value: { uuid: uuids[0] }, type: assetClass }
                });
            }
        } catch (err: any) {
            return { success: false, error: `Failed to set asset property '${property}' (${assetClass}): ${err.message}` };
        }

        // Verify by re-reading the assigned uuid(s) from the dump.
        await new Promise(r => setTimeout(r, 200));
        const verifyValue = await this.quickVerifyAsset(nodeUuid, componentType, effectiveProperty);
        const readUuids: string[] = [];
        const collect = (v: any) => {
            if (!v) return;
            if (Array.isArray(v)) { v.forEach(collect); return; }
            if (typeof v === 'object') {
                if (typeof v.uuid === 'string') readUuids.push(v.uuid);
                else if (v.value) collect(v.value);
            }
        };
        collect(verifyValue);
        const readable = readUuids.length > 0;
        const verified = readable && uuids.every(u => readUuids.includes(u));

        if (readable && !verified) {
            return {
                success: false,
                error: `The editor did not apply ${componentType}.${effectiveProperty}: requested `
                    + `[${uuids.join(', ')}] but read back [${readUuids.join(', ')}]`,
                data: {
                    nodeUuid,
                    componentType,
                    property: effectiveProperty,
                    requestedProperty: property,
                    assetType: assetClass,
                    assignedUuids: uuids,
                    isArray,
                    changeVerified: false,
                    actualValue: verifyValue
                }
            };
        }

        return {
            success: true,
            message: `Set ${componentType}.${effectiveProperty} = ${assetClass}[${uuids.join(', ')}]${effectiveProperty !== property ? ` (via '${property}')` : ''}`,
            ...(readable ? {} : {
                warning: `Set ${componentType}.${effectiveProperty} but no asset uuid read back from the dump, `
                    + `so the assignment is unverified. The write itself did not error.`
            }),
            data: {
                nodeUuid,
                componentType,
                property: effectiveProperty,
                requestedProperty: property,
                assetType: assetClass,
                assignedUuids: uuids,
                isArray,
                changeVerified: verified,
                actualValue: verifyValue
            }
        };
    }

    /** Fallback asset-class guess from a property name (used only when the dump lacks a type). */
    private guessAssetTypeByName(property: string): string {
        const p = property.toLowerCase();
        if (p.includes('material')) return 'cc.Material';
        if (p.includes('mesh')) return 'cc.Mesh';
        if (p.includes('texture')) return 'cc.Texture2D';
        if (p.includes('spriteframe') || p.includes('sprite')) return 'cc.SpriteFrame';
        if (p.includes('prefab')) return 'cc.Prefab';
        if (p.includes('font')) return 'cc.Font';
        if (p.includes('clip') || p.includes('audio')) return 'cc.AudioClip';
        if (p.includes('effect')) return 'cc.EffectAsset';
        return 'cc.Asset';
    }

    private async attachScript(nodeUuid: string, scriptPath: string): Promise<ToolResponse> {
        // A script component does NOT appear under its class name in the node dump — it
        // registers under the script asset's class-id (cid, e.g. "78573A5d...").
        // The reliable identity is therefore the script ASSET uuid, exposed on each
        // component's dump as `__scriptAsset.value.uuid`. We key idempotency and
        // verification on that, never on class-name === component type.
        const scriptName = scriptPath.split('/').pop()?.replace(/\.(ts|js)$/, '') ?? scriptPath;

        // Resolve the script asset uuid from its db:// path.
        let scriptAssetUuid: string | null = null;
        try {
            scriptAssetUuid = await Editor.Message.request('asset-db', 'query-uuid', scriptPath);
        } catch { /* fall through to asset-info */ }
        if (!scriptAssetUuid) {
            try {
                const info: any = await Editor.Message.request('asset-db', 'query-asset-info', scriptPath);
                scriptAssetUuid = info?.uuid ?? null;
            } catch { /* ignore */ }
        }
        if (!scriptAssetUuid) {
            return {
                success: false,
                error: `Could not resolve script asset at '${scriptPath}'. Provide a db:// path to the script, e.g. db://assets/MyScript.ts`
            };
        }

        const getComps = async (): Promise<any[]> => {
            const info = await this.getComponents(nodeUuid);
            return info.success && info.data?.components ? info.data.components : [];
        };
        // Match an attached script component by its script-asset uuid; returns its cid.
        const matchCid = (comps: any[]): string | null => {
            for (const comp of comps) {
                const attachedUuid = comp?.properties?.__scriptAsset?.value?.uuid;
                if (attachedUuid && attachedUuid === scriptAssetUuid) {
                    return comp.type; // the cid
                }
            }
            return null;
        };

        // Idempotency: if the script is already on the node, do not add a duplicate.
        const before = await getComps();
        const alreadyCid = matchCid(before);
        if (alreadyCid) {
            return {
                success: true,
                message: `Script '${scriptName}' is already attached (cid '${alreadyCid}')`,
                data: { nodeUuid, scriptName, componentType: alreadyCid, scriptUuid: scriptAssetUuid, existing: true }
            };
        }
        const beforeCount = before.length;

        const tryCreate = async (component: string): Promise<void> => {
            try {
                await Editor.Message.request('scene', 'create-component', { uuid: nodeUuid, component });
            } catch { /* ignore; verification below decides success */ }
        };

        // Attempt 1: add by class name (the common case where filename === @ccclass name).
        await tryCreate(scriptName);
        await new Promise(r => setTimeout(r, 200));
        let after = await getComps();
        let cid = matchCid(after);

        // Attempt 2: only if attempt 1 neither matched nor changed the component count
        // (so we never create a duplicate) — retry using the script asset uuid.
        if (!cid && after.length === beforeCount) {
            await tryCreate(scriptAssetUuid);
            await new Promise(r => setTimeout(r, 200));
            after = await getComps();
            cid = matchCid(after);
        }

        // The __scriptAsset field can lag briefly after creation; settle once more.
        if (!cid && after.length > beforeCount) {
            await new Promise(r => setTimeout(r, 300));
            after = await getComps();
            cid = matchCid(after);
            // Best effort: if the uuid still hasn't populated, report the new component's cid.
            if (!cid) {
                const beforeCids = new Set(before.map((c: any) => c.type));
                const added = after.find((c: any) => !beforeCids.has(c.type));
                if (added) cid = added.type;
            }
        }

        if (cid) {
            return {
                success: true,
                message: `Script '${scriptName}' attached (registered as cid '${cid}')`,
                data: { nodeUuid, scriptName, componentType: cid, scriptUuid: scriptAssetUuid, existing: false }
            };
        }
        return {
            success: false,
            error: `Failed to attach script '${scriptName}' to node ${nodeUuid}.`,
            instruction: 'Ensure the script is a compiled cc.Component subclass (@ccclass) and the project has finished importing/compiling, then retry.'
        };
    }

        private parseColorString(colorStr: string): { r: number; g: number; b: number; a: number } {
        const str = colorStr.trim();
        
        // Only hexadecimal format supported: #RRGGBB or #RRGGBBAA
        if (str.startsWith('#')) {
            if (str.length === 7) { // #RRGGBB
                const r = parseInt(str.substring(1, 3), 16);
                const g = parseInt(str.substring(3, 5), 16);
                const b = parseInt(str.substring(5, 7), 16);
                return { r, g, b, a: 255 };
            } else if (str.length === 9) { // #RRGGBBAA
                const r = parseInt(str.substring(1, 3), 16);
                const g = parseInt(str.substring(3, 5), 16);
                const b = parseInt(str.substring(5, 7), 16);
                const a = parseInt(str.substring(7, 9), 16);
                return { r, g, b, a };
            }
        }
        
        // Return error if not a valid hexadecimal format
        throw new Error(`Invalid color format: "${colorStr}". Only hexadecimal format is supported (e.g., "#FF0000" or "#FF0000FF")`);
    }

    /**
     * Detect node-level properties and redirect to the appropriate node method.
     */
    private async checkAndRedirectNodeProperties(args: any): Promise<ToolResponse | null> {
        const { nodeUuid, componentType, property, propertyType, value } = args;
        
        // Detect basic node properties (should use set_node_property)
        const nodeBasicProperties = [
            'name', 'active', 'layer', 'mobility', 'parent', 'children', 'hideFlags'
        ];
        
        // Detect node transform properties (should use set_node_transform)
        const nodeTransformProperties = [
            'position', 'rotation', 'scale', 'eulerAngles', 'angle'
        ];
        
        // Detect attempts to set cc.Node properties (common mistake)
        if (componentType === 'cc.Node' || componentType === 'Node') {
            if (nodeBasicProperties.includes(property)) {
                return {
                    success: false,
                                          error: `Property '${property}' is a node basic property, not a component property`,
                      instruction: `Please use set_node_property method to set node properties: set_node_property(uuid="${nodeUuid}", property="${property}", value=${JSON.stringify(value)})`
                  };
              } else if (nodeTransformProperties.includes(property)) {
                  return {
                      success: false,
                      error: `Property '${property}' is a node transform property, not a component property`,
                      instruction: `Please use set_node_transform method to set transform properties: set_node_transform(uuid="${nodeUuid}", ${property}=${JSON.stringify(value)})`
                  };
              }
          }
          
          // Detect common incorrect usage
          if (nodeBasicProperties.includes(property) || nodeTransformProperties.includes(property)) {
              const methodName = nodeTransformProperties.includes(property) ? 'set_node_transform' : 'set_node_property';
              return {
                  success: false,
                  error: `Property '${property}' is a node property, not a component property`,
                  instruction: `Property '${property}' should be set using ${methodName} method, not set_component_property. Please use: ${methodName}(uuid="${nodeUuid}", ${nodeTransformProperties.includes(property) ? property : `property="${property}"`}=${JSON.stringify(value)})`
              };
          }
          
          return null; // Not a node property, continue normal processing
      }

      /**
       * Generate a suggestion message when the requested component type is not found.
       */
      private generateComponentSuggestion(requestedType: string, availableTypes: string[], property: string): string {
          // Check for similar component types
          const similarTypes = availableTypes.filter(type => 
              type.toLowerCase().includes(requestedType.toLowerCase()) || 
              requestedType.toLowerCase().includes(type.toLowerCase())
          );
          
          let instruction = '';
          
          if (similarTypes.length > 0) {
              instruction += `\n\n🔍 Found similar components: ${similarTypes.join(', ')}`;
              instruction += `\n💡 Suggestion: Perhaps you meant to set the '${similarTypes[0]}' component?`;
          }
          
          // Recommend possible components based on property name
          const propertyToComponentMap: Record<string, string[]> = {
              'string': ['cc.Label', 'cc.RichText', 'cc.EditBox'],
              'text': ['cc.Label', 'cc.RichText'],
              'fontSize': ['cc.Label', 'cc.RichText'],
              'spriteFrame': ['cc.Sprite'],
              'color': ['cc.Label', 'cc.Sprite', 'cc.Graphics'],
              'normalColor': ['cc.Button'],
              'pressedColor': ['cc.Button'],
              'target': ['cc.Button'],
              'contentSize': ['cc.UITransform'],
              'anchorPoint': ['cc.UITransform']
          };
          
          const recommendedComponents = propertyToComponentMap[property] || [];
          const availableRecommended = recommendedComponents.filter(comp => availableTypes.includes(comp));
          
          if (availableRecommended.length > 0) {
              instruction += `\n\n🎯 Based on property '${property}', recommended components: ${availableRecommended.join(', ')}`;
          }
          
          // Provide operation suggestions
          instruction += `\n\n📋 Suggested Actions:`;
          instruction += `\n1. Use get_components(nodeUuid="${requestedType.includes('uuid') ? 'YOUR_NODE_UUID' : 'nodeUuid'}") to view all components on the node`;
          instruction += `\n2. If you need to add a component, use add_component(nodeUuid="...", componentType="${requestedType}")`;
          instruction += `\n3. Verify that the component type name is correct (case-sensitive)`;
          
                  return instruction;
    }

    /**
     * Quickly verify that an asset assignment was applied correctly.
     */
    private async quickVerifyAsset(nodeUuid: string, componentType: string, property: string): Promise<any> {
        try {
            const rawNodeData = await Editor.Message.request('scene', 'query-node', nodeUuid);
            if (!rawNodeData || !rawNodeData.__comps__) {
                return null;
            }
            
            // Find component
            const component = rawNodeData.__comps__.find((comp: any) => {
                const compType = comp.__type__ || comp.cid || comp.type;
                return compType === componentType;
            });
            
            if (!component) {
                return null;
            }
            
            // Extract property value
            const properties = this.extractComponentProperties(component);
            const propertyData = properties[property];
            
            if (propertyData && typeof propertyData === 'object' && 'value' in propertyData) {
                return propertyData.value;
            } else {
                return propertyData;
            }
        } catch (error) {
            console.error(`[quickVerifyAsset] Error:`, error);
            return null;
        }
    }
}