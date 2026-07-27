import { ToolDefinition, ToolResponse, ToolExecutor, ComponentInfo } from '../types';
import { ANY_VALUE_TYPE, coerceJsonArg } from '../json-arg';

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
                            description: 'Target node UUID. REQUIRED: You must specify the exact node to add the component to. Use get_all_nodes or find_node_by_name to get the UUID of the desired node.'
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
                description: 'Get specific component information',
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
                        }
                    },
                    required: ['nodeUuid', 'componentType']
                }
            },
            {
                name: 'set_component_property',
                description: 'Set component property values for UI components or custom script components. Supports setting properties of built-in UI components (e.g., cc.Label, cc.Sprite) and custom script components. Note: For node basic properties (name, active, layer, etc.), use set_node_property. For node transform properties (position, rotation, scale, etc.), use set_node_transform.',
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
                            description: 'Property type - Must explicitly specify the property data type for correct value conversion and validation',
                            enum: [
                                'string', 'number', 'boolean', 'integer', 'float',
                                'color', 'vec2', 'vec3', 'size', 'enum', 'gradient', 'curve',
                                'node', 'component', 'spriteFrame', 'prefab', 'asset',
                                'nodeArray', 'colorArray', 'numberArray', 'stringArray'
                            ]
                            // Also accepts a real cc.* class name (e.g. "cc.Node", "cc.Color",
                            // "cc.Vec3") — the value is typed accordingly. Use "enum" for
                            // enumerations (pass the numeric value) and "gradient" for a
                            // particle GradientRange (see the value docs).
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
                                '  How to get: Use get_all_nodes or find_node_by_name to get node UUIDs\n' +
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
                    required: ['nodeUuid', 'componentType', 'property', 'propertyType', 'value']
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
                name: 'get_available_components',
                description: 'Get list of available component types',
                inputSchema: {
                    type: 'object',
                    properties: {
                        category: {
                            type: 'string',
                            description: 'Component category filter',
                            enum: ['all', 'renderer', 'ui', 'physics', 'animation', 'audio'],
                            default: 'all'
                        }
                    }
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
                    'node. Assigns on the live engine object, so it works for custom scripts with no Inspector ' +
                    'metadata and for a second component of the same class (componentIndex). Fails loudly if the ' +
                    'value does not read back.',
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
                return await this.getComponentInfo(args.nodeUuid, args.componentType);
            case 'set_component_property':
                return await this.setComponentProperty(args);
            case 'attach_script':
                return await this.attachScript(args.nodeUuid, args.scriptPath);
            case 'get_available_components':
                return await this.getAvailableComponents(args.category);
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

    /**
     * Write a node/component reference on the live component via the scene script. The editor
     * set-property channel needs Inspector metadata to infer the field's component class and
     * hard-errors without it, and it can only address a component by its owning node.
     */
    private async setComponentRef(args: any): Promise<ToolResponse> {
        try {
            const result = await Editor.Message.request('scene', 'execute-scene-script', {
                name: 'cocos-mcp-server',
                method: 'setComponentReference',
                args: [args]
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

    private async getComponentInfo(nodeUuid: string, componentType: string): Promise<ToolResponse> {
        return new Promise((resolve) => {
            // Prefer Editor API for node info query
            Editor.Message.request('scene', 'query-node', nodeUuid).then((nodeData: any) => {
                if (nodeData && nodeData.__comps__) {
                    const component = nodeData.__comps__.find((comp: any) => this.componentMatches(comp, componentType));

                    if (component) {
                        resolve({
                            success: true,
                            data: {
                                nodeUuid: nodeUuid,
                                componentType: componentType,
                                resolvedCid: this.componentCid(component),
                                className: this.componentClassName(component) || undefined,
                                enabled: component.enabled !== undefined ? component.enabled : true,
                                properties: this.extractComponentProperties(component)
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
                                    ...component
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

    private async setComponentProperty(args: any): Promise<ToolResponse> {
        const { nodeUuid, componentType, property, propertyType } = args;
        const value = this.coerceIncomingValue(args.value, propertyType);

        return new Promise(async (resolve) => {
            try {
                console.log(`[ComponentTools] Setting ${componentType}.${property} (type: ${propertyType}) = ${JSON.stringify(value)} (raw: ${JSON.stringify(args.value)}) on node ${nodeUuid}`);
                
                // Step 0: Detect node-level properties and redirect to the appropriate node method
                const nodeRedirectResult = await this.checkAndRedirectNodeProperties(args);
                if (nodeRedirectResult) {
                    resolve(nodeRedirectResult);
                    return;
                }
                
                // Step 1: Get component info using the same method as getComponents
                const componentsResponse = await this.getComponents(nodeUuid);
                if (!componentsResponse.success || !componentsResponse.data) {
                    resolve({
                        success: false,
                        error: `Failed to get components for node '${nodeUuid}': ${componentsResponse.error}`,
                        instruction: `Please verify that node UUID '${nodeUuid}' is correct. Use get_all_nodes or find_node_by_name to get the correct node UUID.`
                    });
                    return;
                }
                
                const allComponents = componentsResponse.data.components;
                
                // Step 2: Find target component by cid OR @ccclass name / builtin type.
                let targetComponent: any = null;
                let resolvedCid: string = componentType; // the actual cid, used for raw dump matching
                const availableTypes: string[] = [];

                for (let i = 0; i < allComponents.length; i++) {
                    const comp = allComponents[i];
                    availableTypes.push(comp.className ? `${comp.className}(${comp.type})` : comp.type);

                    if (this.componentMatches(comp, componentType)) {
                        targetComponent = comp;
                        resolvedCid = comp.type;
                        break;
                    }
                }
                
                if (!targetComponent) {
                    // Provide detailed error info and suggestions
                    const instruction = this.generateComponentSuggestion(componentType, availableTypes, property);
                    resolve({
                        success: false,
                        error: `Component '${componentType}' not found on node. Available components: ${availableTypes.join(', ')}`,
                        instruction: instruction
                    });
                    return;
                }

                // Fast path: asset-typed property assignment (mesh, material(s), texture,
                // spriteFrame, prefab, effect, ...). This is metadata-driven — it reads the
                // component dump to find the exact asset class and array shape — so it works
                // for ANY asset property and for MeshRenderer's `sharedMaterials` array
                // (settable getters like `material` are handled here, before analyzeProperty,
                // which would otherwise reject them because they are absent from the dump).
                const assetResult = await this.trySetAssetProperty(
                    nodeUuid, resolvedCid, property, propertyType, value, targetComponent
                );
                if (assetResult) {
                    resolve(assetResult);
                    return;
                }

                // Advanced typed / nested / gradient set. Handles what the legacy keyword
                // switch could not: real cc.* type names (cc.Node/cc.Color/cc.Vec3),
                // dotted sub-property paths (e.g. `colorOverLifetimeModule.color`,
                // `rateOverTime.constant`), Enum leaves, and particle GradientRanges. It
                // routes through the editor Inspector `set-property` channel with a properly
                // typed dump (or the engine API for gradient keys). Returns null to fall
                // through to the legacy single-level keyword path below.
                const advResult = await this.trySetAdvancedProperty(
                    nodeUuid, resolvedCid, componentType, property, propertyType, value, targetComponent
                );
                if (advResult) {
                    resolve(advResult);
                    return;
                }

                // Step 3: Auto-detect and convert property value
                let propertyInfo;
                try {
                    console.log(`[ComponentTools] Analyzing property: ${property}`);
                    propertyInfo = this.analyzeProperty(targetComponent, property);
                } catch (analyzeError: any) {
                    console.error(`[ComponentTools] Error in analyzeProperty:`, analyzeError);
                    resolve({
                        success: false,
                        error: `Failed to analyze property '${property}': ${analyzeError.message}`
                    });
                    return;
                }
                
                if (!propertyInfo.exists) {
                    resolve({
                        success: false,
                        error: `Property '${property}' not found on component '${componentType}'. Available properties: ${propertyInfo.availableProperties.join(', ')}`
                    });
                    return;
                }
                
                // Step 4: Process property value and apply
                const originalValue = propertyInfo.originalValue;
                let processedValue: any;
                
                // Process value based on explicit propertyType
                switch (propertyType) {
                    case 'string':
                        processedValue = String(value);
                        break;
                    case 'number':
                    case 'integer':
                    case 'float':
                        processedValue = Number(value);
                        break;
                    case 'boolean':
                        processedValue = Boolean(value);
                        break;
                    case 'color':
                        if (typeof value === 'string') {
                            // String format: supports hex, color names, rgb()/rgba()
                            processedValue = this.parseColorString(value);
                        } else if (typeof value === 'object' && value !== null) {
                            // Object format: validate and convert RGBA values
                            processedValue = {
                                r: Math.min(255, Math.max(0, Number(value.r) || 0)),
                                g: Math.min(255, Math.max(0, Number(value.g) || 0)),
                                b: Math.min(255, Math.max(0, Number(value.b) || 0)),
                                a: value.a !== undefined ? Math.min(255, Math.max(0, Number(value.a))) : 255
                            };
                        } else {
                            throw new Error('Color value must be an object with r, g, b properties or a hexadecimal string (e.g., "#FF0000")');
                        }
                        break;
                    case 'vec2':
                        if (typeof value === 'object' && value !== null) {
                            processedValue = {
                                x: Number(value.x) || 0,
                                y: Number(value.y) || 0
                            };
                        } else {
                            throw new Error('Vec2 value must be an object with x, y properties');
                        }
                        break;
                    case 'vec3':
                        if (typeof value === 'object' && value !== null) {
                            processedValue = {
                                x: Number(value.x) || 0,
                                y: Number(value.y) || 0,
                                z: Number(value.z) || 0
                            };
                        } else {
                            throw new Error('Vec3 value must be an object with x, y, z properties');
                        }
                        break;
                    case 'size':
                        if (typeof value === 'object' && value !== null) {
                            processedValue = {
                                width: Number(value.width) || 0,
                                height: Number(value.height) || 0
                            };
                        } else {
                            throw new Error('Size value must be an object with width, height properties');
                        }
                        break;
                    case 'node':
                        if (typeof value === 'string') {
                            processedValue = { uuid: value };
                        } else if (value && typeof value === 'object' && typeof value.uuid === 'string') {
                            processedValue = { uuid: value.uuid };
                        } else {
                            throw new Error('Node reference value must be a uuid string or a { uuid } object');
                        }
                        break;
                    case 'component':
                        if (typeof value === 'string') {
                            // Component references need special handling: find component __id__ via node UUID
                            processedValue = value; // Store node UUID for now, will be converted to __id__ later
                        } else {
                            throw new Error('Component reference value must be a string (node UUID containing the target component)');
                        }
                        break;
                    case 'spriteFrame':
                    case 'prefab':
                    case 'asset':
                        if (typeof value === 'string') {
                            processedValue = { uuid: value };
                        } else if (value && typeof value === 'object' && typeof value.uuid === 'string') {
                            processedValue = { uuid: value.uuid };
                        } else {
                            throw new Error(`${propertyType} value must be a uuid string or a { uuid } object`);
                        }
                        break;
                    case 'nodeArray':
                        if (Array.isArray(value)) {
                            processedValue = value.map((item: any) => {
                                if (typeof item === 'string') {
                                    return { uuid: item };
                                } else {
                                    throw new Error('NodeArray items must be string UUIDs');
                                }
                            });
                        } else {
                            throw new Error('NodeArray value must be an array');
                        }
                        break;
                    case 'colorArray':
                        if (Array.isArray(value)) {
                            processedValue = value.map((item: any) => {
                                if (typeof item === 'object' && item !== null && 'r' in item) {
                                    return {
                                        r: Math.min(255, Math.max(0, Number(item.r) || 0)),
                                        g: Math.min(255, Math.max(0, Number(item.g) || 0)),
                                        b: Math.min(255, Math.max(0, Number(item.b) || 0)),
                                        a: item.a !== undefined ? Math.min(255, Math.max(0, Number(item.a))) : 255
                                    };
                                } else {
                                    return { r: 255, g: 255, b: 255, a: 255 };
                                }
                            });
                        } else {
                            throw new Error('ColorArray value must be an array');
                        }
                        break;
                    case 'numberArray':
                        if (Array.isArray(value)) {
                            processedValue = value.map((item: any) => Number(item));
                        } else {
                            throw new Error('NumberArray value must be an array');
                        }
                        break;
                    case 'stringArray':
                        if (Array.isArray(value)) {
                            processedValue = value.map((item: any) => String(item));
                        } else {
                            throw new Error('StringArray value must be an array');
                        }
                        break;
                    default:
                        throw new Error(`Unsupported property type: ${propertyType}`);
                }
                
                console.log(`[ComponentTools] Converting value: ${JSON.stringify(value)} -> ${JSON.stringify(processedValue)} (type: ${propertyType})`);
                console.log(`[ComponentTools] Property analysis result: propertyInfo.type="${propertyInfo.type}", propertyType="${propertyType}"`);
                console.log(`[ComponentTools] Will use color special handling: ${propertyType === 'color' && processedValue && typeof processedValue === 'object'}`);
                
                // Actual expected value for verification (component refs need special handling)
                let actualExpectedValue = processedValue;
                
                // Step 5: Get raw node data to build correct property path
                const rawNodeData = await Editor.Message.request('scene', 'query-node', nodeUuid);
                if (!rawNodeData || !rawNodeData.__comps__) {
                    resolve({
                        success: false,
                        error: `Failed to get raw node data for property setting`
                    });
                    return;
                }
                
                // Find the index of the target component in raw data (match by resolved cid).
                let rawComponentIndex = -1;
                for (let i = 0; i < rawNodeData.__comps__.length; i++) {
                    const comp = rawNodeData.__comps__[i] as any;
                    const compType = comp.__type__ || comp.cid || comp.type || 'Unknown';
                    if (compType === resolvedCid) {
                        rawComponentIndex = i;
                        break;
                    }
                }
                
                if (rawComponentIndex === -1) {
                    resolve({
                        success: false,
                        error: `Could not find component index for setting property`
                    });
                    return;
                }
                
                // Build the correct property path
                let propertyPath = `__comps__.${rawComponentIndex}.${property}`;
                
                // Special handling for asset-type properties
                if (propertyType === 'asset' || propertyType === 'spriteFrame' || propertyType === 'prefab' || 
                    (propertyInfo.type === 'asset' && propertyType === 'string')) {
                    
                    console.log(`[ComponentTools] Setting asset reference:`, {
                        value: processedValue,
                        property: property,
                        propertyType: propertyType,
                        path: propertyPath
                    });
                    
                    // Determine asset type based on property name
                    let assetType = 'cc.SpriteFrame'; // default
                    if (property.toLowerCase().includes('texture')) {
                        assetType = 'cc.Texture2D';
                    } else if (property.toLowerCase().includes('material')) {
                        assetType = 'cc.Material';
                    } else if (property.toLowerCase().includes('font')) {
                        assetType = 'cc.Font';
                    } else if (property.toLowerCase().includes('clip')) {
                        assetType = 'cc.AudioClip';
                    } else if (propertyType === 'prefab') {
                        assetType = 'cc.Prefab';
                    }
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: processedValue,
                            type: assetType
                        }
                    });
                } else if (componentType === 'cc.UITransform' && (property === '_contentSize' || property === 'contentSize')) {
                    // Special handling for UITransform contentSize - set width and height separately.
                    // Use Number.isFinite (not `|| 100`) so a legitimate 0 is not clobbered to the default.
                    const parsedW = Number(value.width);
                    const parsedH = Number(value.height);
                    const width = Number.isFinite(parsedW) ? parsedW : 100;
                    const height = Number.isFinite(parsedH) ? parsedH : 100;
                    
                    // Set width first
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${rawComponentIndex}.width`,
                        dump: { value: width }
                    });
                    
                    // Then set height
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${rawComponentIndex}.height`,
                        dump: { value: height }
                    });
                } else if (componentType === 'cc.UITransform' && (property === '_anchorPoint' || property === 'anchorPoint')) {
                    // Special handling for UITransform anchorPoint - set anchorX and anchorY separately.
                    // Use Number.isFinite (not `|| 0.5`) so a legitimate 0 is not clobbered to the default.
                    const parsedX = Number(value.x);
                    const parsedY = Number(value.y);
                    const anchorX = Number.isFinite(parsedX) ? parsedX : 0.5;
                    const anchorY = Number.isFinite(parsedY) ? parsedY : 0.5;
                    
                    // Set anchorX first
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${rawComponentIndex}.anchorX`,
                        dump: { value: anchorX }
                    });
                    
                    // Then set anchorY  
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: `__comps__.${rawComponentIndex}.anchorY`,
                        dump: { value: anchorY }
                    });
                } else if (propertyType === 'color' && processedValue && typeof processedValue === 'object') {
                    // Special handling for color properties to ensure correct RGBA values
                    // Cocos Creator color values range 0-255
                    const colorValue = {
                        r: Math.min(255, Math.max(0, Number(processedValue.r) || 0)),
                        g: Math.min(255, Math.max(0, Number(processedValue.g) || 0)),
                        b: Math.min(255, Math.max(0, Number(processedValue.b) || 0)),
                        a: processedValue.a !== undefined ? Math.min(255, Math.max(0, Number(processedValue.a))) : 255
                    };
                    
                    console.log(`[ComponentTools] Setting color value:`, colorValue);
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: colorValue,
                            type: 'cc.Color'
                        }
                    });
                } else if (propertyType === 'vec3' && processedValue && typeof processedValue === 'object') {
                    // Special handling for Vec3 properties
                    const vec3Value = {
                        x: Number(processedValue.x) || 0,
                        y: Number(processedValue.y) || 0,
                        z: Number(processedValue.z) || 0
                    };
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: vec3Value,
                            type: 'cc.Vec3'
                        }
                    });
                } else if (propertyType === 'vec2' && processedValue && typeof processedValue === 'object') {
                    // Special handling for Vec2 properties
                    const vec2Value = {
                        x: Number(processedValue.x) || 0,
                        y: Number(processedValue.y) || 0
                    };
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: vec2Value,
                            type: 'cc.Vec2'
                        }
                    });
                } else if (propertyType === 'size' && processedValue && typeof processedValue === 'object') {
                    // Special handling for Size properties
                    const sizeValue = {
                        width: Number(processedValue.width) || 0,
                        height: Number(processedValue.height) || 0
                    };
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: sizeValue,
                            type: 'cc.Size'
                        }
                    });
                } else if (propertyType === 'node' && processedValue && typeof processedValue === 'object' && 'uuid' in processedValue) {
                    // Special handling for node references
                    console.log(`[ComponentTools] Setting node reference with UUID: ${processedValue.uuid}`);
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: processedValue,
                            type: 'cc.Node'
                        }
                    });
                } else if (propertyType === 'component' && typeof processedValue === 'string') {
                    // Special handling for component references: find __id__ via node UUID
                    const targetNodeUuid = processedValue;
                    console.log(`[ComponentTools] Setting component reference - finding component on node: ${targetNodeUuid}`);
                    
                    // Get expected component type from current component attribute metadata
                    let expectedComponentType = '';
                    
                    // Get current component details including attribute metadata
                    const currentComponentInfo = await this.getComponentInfo(nodeUuid, componentType);
                    if (currentComponentInfo.success && currentComponentInfo.data?.properties?.[property]) {
                        const propertyMeta = currentComponentInfo.data.properties[property];
                        
                        // Extract component type info from attribute metadata
                        if (propertyMeta && typeof propertyMeta === 'object') {
                            // Check for type field indicating component type
                            if (propertyMeta.type) {
                                expectedComponentType = propertyMeta.type;
                            } else if (propertyMeta.ctor) {
                                // Some properties may use ctor field
                                expectedComponentType = propertyMeta.ctor;
                            } else if (propertyMeta.extends && Array.isArray(propertyMeta.extends)) {
                                // Check extends array; first entry is typically most specific type
                                for (const extendType of propertyMeta.extends) {
                                    if (extendType.startsWith('cc.') && extendType !== 'cc.Component' && extendType !== 'cc.Object') {
                                        expectedComponentType = extendType;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    
                    if (!expectedComponentType) {
                        throw new Error(`Unable to determine required component type for property '${property}' on component '${componentType}'. Property metadata may not contain type information.`);
                    }
                    
                    console.log(`[ComponentTools] Detected required component type: ${expectedComponentType} for property: ${property}`);
                    
                    try {
                        // Get component info for target node
                        const targetNodeData = await Editor.Message.request('scene', 'query-node', targetNodeUuid);
                        if (!targetNodeData || !targetNodeData.__comps__) {
                            throw new Error(`Target node ${targetNodeUuid} not found or has no components`);
                        }
                        
                        // Log target node component overview
                        console.log(`[ComponentTools] Target node ${targetNodeUuid} has ${targetNodeData.__comps__.length} components:`);
                        targetNodeData.__comps__.forEach((comp: any, index: number) => {
                            const sceneId = comp.value && comp.value.uuid && comp.value.uuid.value ? comp.value.uuid.value : 'unknown';
                            console.log(`[ComponentTools] Component ${index}: ${comp.type} (scene_id: ${sceneId})`);
                        });
                        
                        // Find matching component
                        let targetComponent = null;
                        let componentId: string | null = null;
                        
                        // Search _components array for specified component type
                        // Note: __comps__ and _components share the same index
                        console.log(`[ComponentTools] Searching for component type: ${expectedComponentType}`);
                        
                        for (let i = 0; i < targetNodeData.__comps__.length; i++) {
                            const comp = targetNodeData.__comps__[i] as any;
                            console.log(`[ComponentTools] Checking component ${i}: type=${comp.type}, target=${expectedComponentType}`);
                            
                            if (comp.type === expectedComponentType) {
                                targetComponent = comp;
                                console.log(`[ComponentTools] Found matching component at index ${i}: ${comp.type}`);
                                
                                // Get scene ID from component value.uuid.value
                                if (comp.value && comp.value.uuid && comp.value.uuid.value) {
                                    componentId = comp.value.uuid.value;
                                    console.log(`[ComponentTools] Got componentId from comp.value.uuid.value: ${componentId}`);
                                } else {
                                    console.log(`[ComponentTools] Component structure:`, {
                                        hasValue: !!comp.value,
                                        hasUuid: !!(comp.value && comp.value.uuid),
                                        hasUuidValue: !!(comp.value && comp.value.uuid && comp.value.uuid.value),
                                        uuidStructure: comp.value ? comp.value.uuid : 'No value'
                                    });
                                    throw new Error(`Unable to extract component ID from component structure`);
                                }
                                
                                break;
                            }
                        }
                        
                        if (!targetComponent) {
                            // Component not found - list available ones with their real scene IDs
                            const availableComponents = targetNodeData.__comps__.map((comp: any, index: number) => {
                                let sceneId = 'unknown';
                                // Get scene ID from component value.uuid.value
                                if (comp.value && comp.value.uuid && comp.value.uuid.value) {
                                    sceneId = comp.value.uuid.value;
                                }
                                return `${comp.type}(scene_id:${sceneId})`;
                            });
                            throw new Error(`Component type '${expectedComponentType}' not found on node ${targetNodeUuid}. Available components: ${availableComponents.join(', ')}`);
                        }
                        
                        console.log(`[ComponentTools] Found component ${expectedComponentType} with scene ID: ${componentId} on node ${targetNodeUuid}`);
                        
                        // Update expected value to actual component ID object format for later verification
                        if (componentId) {
                            actualExpectedValue = { uuid: componentId };
                        }
                        
                        // Try the same {uuid: componentId} format as node/asset references
                        // Test whether component reference can be set correctly this way
                        await Editor.Message.request('scene', 'set-property', {
                            uuid: nodeUuid,
                            path: propertyPath,
                            dump: { 
                                value: { uuid: componentId },  // Use object format, same as node/asset references
                                type: expectedComponentType
                            }
                        });
                        
                    } catch (error) {
                        console.error(`[ComponentTools] Error setting component reference:`, error);
                        throw error;
                    }
                } else if (propertyType === 'nodeArray' && Array.isArray(processedValue)) {
                    // Special handling for node arrays - preserve pre-processed format
                    console.log(`[ComponentTools] Setting node array:`, processedValue);
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: processedValue  // Keep [{uuid: "..."}, {uuid: "..."}] format
                        }
                    });
                } else if (propertyType === 'colorArray' && Array.isArray(processedValue)) {
                    // Special handling for color arrays
                    const colorArrayValue = processedValue.map((item: any) => {
                        if (item && typeof item === 'object' && 'r' in item) {
                            return {
                                r: Math.min(255, Math.max(0, Number(item.r) || 0)),
                                g: Math.min(255, Math.max(0, Number(item.g) || 0)),
                                b: Math.min(255, Math.max(0, Number(item.b) || 0)),
                                a: item.a !== undefined ? Math.min(255, Math.max(0, Number(item.a))) : 255
                            };
                        } else {
                            return { r: 255, g: 255, b: 255, a: 255 };
                        }
                    });
                    
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { 
                            value: colorArrayValue,
                            type: 'cc.Color'
                        }
                    });
                } else {
                    // Normal property setting for non-asset properties
                    await Editor.Message.request('scene', 'set-property', {
                        uuid: nodeUuid,
                        path: propertyPath,
                        dump: { value: processedValue }
                    });
                }
                
                // Step 5: Wait for Editor to finish updating, then verify
                await new Promise(resolve => setTimeout(resolve, 200)); // Wait 200ms for Editor to finish updating
                
                const verification = await this.verifyPropertyChange(nodeUuid, resolvedCid, property, originalValue, actualExpectedValue);

                // Honest success: for primitive and node-reference types the read-back
                // comparison in verifyPropertyChange is reliable, so a failed verification means
                // the editor silently did NOT apply the value (e.g. Boolean("false") no-op, or a
                // node ref the target rejected). Report that as success:false instead of the old
                // unconditional success:true. Object-shaped types (vec/color/arrays) keep
                // success:true but still expose the honest changeVerified flag, because their
                // JSON-equality check can false-negative on editor-side normalisation.
                // A property the dump does not expose at all yields no evidence either way, so
                // it is reported applied-but-unverified — a failure there would abort a batch
                // over a value that did land.
                const strictVerifyTypes = ['boolean', 'number', 'integer', 'float', 'string', 'node'];
                const strict = strictVerifyTypes.includes((propertyType || '').toString());
                const contradicted = strict && verification.readable && !verification.verified;
                const applied = !contradicted;

                resolve({
                    success: applied,
                    message: applied
                        ? `Successfully set ${componentType}.${property}`
                        : `Editor did not apply ${componentType}.${property}: requested ${JSON.stringify(actualExpectedValue)} but read back ${JSON.stringify(verification.actualValue)}`,
                    ...(contradicted ? { error: `Property '${property}' was not applied by the editor (changeVerified=false). The value read back does not match the requested value.` } : {}),
                    ...(applied && !verification.readable ? { warning: `Set ${componentType}.${property} but could not read it back for verification — '${property}' is not exposed in the component dump. The write itself did not error.` } : {}),
                    data: {
                        nodeUuid,
                        componentType,
                        property,
                        actualValue: verification.actualValue,
                        changeVerified: verification.verified
                    }
                });
                
            } catch (error: any) {
                console.error(`[ComponentTools] Error setting property:`, error);
                resolve({
                    success: false,
                    error: `Failed to set property: ${error.message}`
                });
            }
        });
    }


    /**
     * Advanced typed / nested / gradient property set. Returns a ToolResponse when it
     * handled the property, or null to defer to the legacy keyword switch.
     *
     * Triggers (leaving simple single-level keyword sets — 'color','vec3','node',… — to
     * the legacy path so nothing that already worked regresses) when ANY of:
     *   - `property` is a dotted path (a nested sub-property / sub-module),
     *   - `propertyType` is 'gradient' or 'enum',
     *   - `propertyType` is a real cc.* class name (cc.Node / cc.Color / cc.Vec3 / …).
     *
     * For gradients it calls the engine-API scene script (the only route that can write
     * GradientColorKey arrays). For everything else it builds a correctly typed dump —
     * discovering the target's type from the live component dump when the caller did not
     * name it — and applies it via the editor `set-property` channel, supporting nested
     * paths (`__comps__.<i>.<a>.<b>…`), then reads the value back to verify.
     */
    private async trySetAdvancedProperty(
        nodeUuid: string,
        resolvedCid: string,
        componentType: string,
        property: string,
        propertyType: string,
        value: any,
        targetComponent: any
    ): Promise<ToolResponse | null> {
        const pt = (propertyType || '').toString();
        const isNested = property.includes('.');
        const isGradient = pt === 'gradient';
        const isCurve = pt === 'curve';
        const isTypedCc = pt.startsWith('cc.') || pt === 'enum';
        if (!isNested && !isGradient && !isCurve && !isTypedCc) {
            return null; // simple keyword set — let the legacy switch handle it unchanged
        }

        // Resolve the component's index in the raw node dump.
        const rawNodeData: any = await Editor.Message.request('scene', 'query-node', nodeUuid);
        if (!rawNodeData || !rawNodeData.__comps__) {
            return { success: false, error: 'Failed to get raw node data for advanced property set' };
        }
        let idx = -1;
        for (let i = 0; i < rawNodeData.__comps__.length; i++) {
            const c = rawNodeData.__comps__[i] as any;
            const t = c.__type__ || c.cid || c.type || 'Unknown';
            if (t === resolvedCid) { idx = i; break; }
        }
        if (idx === -1) {
            return { success: false, error: `Could not find component '${componentType}' index for advanced set` };
        }

        // --- Gradient: engine-API scene script (set-property cannot write gradient keys) ---
        if (isGradient) {
            const colorKeys = Array.isArray(value?.colorKeys) ? value.colorKeys : [];
            const alphaKeys = Array.isArray(value?.alphaKeys) ? value.alphaKeys : [];
            const mode = value?.mode;
            const enableModule = value?.enable === true || /module/i.test(property);
            let res: any;
            try {
                res = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'cocos-mcp-server',
                    method: 'setParticleGradient',
                    args: [nodeUuid, componentType, property, colorKeys, alphaKeys, mode, enableModule]
                });
            } catch (err: any) {
                return { success: false, error: `Gradient scene script failed: ${err.message}` };
            }
            if (res && res.success) {
                const applied = Number(res.data?.colorKeys || 0);
                return {
                    success: true,
                    message: `Set gradient ${componentType}.${property} (${res.data?.colorKeys} colour / ${res.data?.alphaKeys} alpha keys)`,
                    data: { nodeUuid, componentType, property, ...res.data, changeVerified: applied > 0 }
                };
            }
            return { success: false, error: res?.error || 'Gradient set failed' };
        }

        // --- CurveRange animation curve: engine-API scene script ---
        if (isCurve) {
            const keyframes = Array.isArray(value?.keyframes) ? value.keyframes
                : (Array.isArray(value) ? value : []);
            const mode = value?.mode;
            const multiplier = value?.multiplier;
            const enableModule = value?.enable === true || /module/i.test(property);
            let res: any;
            try {
                res = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'cocos-mcp-server',
                    method: 'setParticleCurve',
                    args: [nodeUuid, componentType, property, keyframes, mode, multiplier, enableModule]
                });
            } catch (err: any) {
                return { success: false, error: `Curve scene script failed: ${err.message}` };
            }
            if (res && res.success) {
                return {
                    success: true,
                    message: `Set curve ${componentType}.${property} (${res.data?.keyCount} keys, eval 0→1: ${res.data?.eval0}→${res.data?.eval1})`,
                    data: { nodeUuid, componentType, property, ...res.data, changeVerified: Number(res.data?.keyCount || 0) > 0 }
                };
            }
            return { success: false, error: res?.error || 'Curve set failed' };
        }

        // --- Typed / nested leaf via the editor set-property channel ---
        const discovered = this.discoverDumpType(targetComponent, property);
        const dump = this.buildTypedDump(pt, value, discovered);
        if (!dump) {
            return {
                success: false,
                error: `Could not build a typed dump for '${property}' (propertyType='${propertyType}', discovered='${discovered || 'unknown'}', value=${JSON.stringify(value)})`
            };
        }
        const path = `__comps__.${idx}.${property}`;
        try {
            await Editor.Message.request('scene', 'set-property', { uuid: nodeUuid, path, dump });
        } catch (err: any) {
            return { success: false, error: `set-property failed for '${path}': ${err.message}` };
        }

        await new Promise(r => setTimeout(r, 150));
        const actual = await this.readDumpValueAtPath(nodeUuid, resolvedCid, property);
        return {
            success: true,
            message: `Set ${componentType}.${property}`,
            data: {
                nodeUuid,
                componentType,
                property,
                dumpType: dump.type || discovered || 'inferred',
                actualValue: actual,
                changeVerified: actual !== undefined && actual !== null
            }
        };
    }

    /**
     * Walk a (possibly dotted) property path through a processed component dump
     * (`targetComponent.properties` === the editor `comp.value`) and return the editor
     * `type` string of the addressed leaf, e.g. 'cc.Color', 'cc.Node', 'cc.Vec3',
     * 'Number', 'Boolean', 'Enum'. Undefined when the path does not resolve.
     */
    private discoverDumpType(targetComponent: any, property: string): string | undefined {
        const props = targetComponent?.properties || {};
        const segs = property.split('.');
        let cur: any = props[segs[0]];
        for (let i = 1; i < segs.length && cur != null; i++) {
            cur = cur.value ? cur.value[segs[i]] : undefined;
        }
        return cur?.type;
    }

    /**
     * Build a correctly typed editor `dump` ({type,value}) from the caller's propertyType
     * hint and/or the discovered dump type. Returns null when the value cannot be coerced.
     */
    private buildTypedDump(propertyType: string, value: any, discovered?: string): any | null {
        const clamp = (v: any) => Math.min(255, Math.max(0, Number(v) || 0));
        const pt = propertyType || '';
        const dt = discovered || '';
        const wants = (kw: string, cc: string) => pt === kw || pt === cc || dt === cc;

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

    /** Read back the dump `value` at a (possibly dotted) property path for verification. */
    private async readDumpValueAtPath(nodeUuid: string, componentType: string, property: string): Promise<any> {
        return (await this.readDumpProperty(nodeUuid, componentType, property)).value;
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
        const verified = uuids.every(u => readUuids.includes(u));

        return {
            success: true,
            message: `Set ${componentType}.${effectiveProperty} = ${assetClass}[${uuids.join(', ')}]${effectiveProperty !== property ? ` (via '${property}')` : ''}`,
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

    private async getAvailableComponents(category: string = 'all'): Promise<ToolResponse> {
        const componentCategories: Record<string, string[]> = {
            renderer: ['cc.Sprite', 'cc.Label', 'cc.RichText', 'cc.Mask', 'cc.Graphics'],
            ui: ['cc.Button', 'cc.Toggle', 'cc.Slider', 'cc.ScrollView', 'cc.EditBox', 'cc.ProgressBar'],
            physics: ['cc.RigidBody2D', 'cc.BoxCollider2D', 'cc.CircleCollider2D', 'cc.PolygonCollider2D'],
            animation: ['cc.Animation', 'cc.AnimationClip', 'cc.SkeletalAnimation'],
            audio: ['cc.AudioSource'],
            layout: ['cc.Layout', 'cc.Widget', 'cc.PageView', 'cc.PageViewIndicator'],
            effects: ['cc.MotionStreak', 'cc.ParticleSystem2D'],
            camera: ['cc.Camera'],
            light: ['cc.Light', 'cc.DirectionalLight', 'cc.PointLight', 'cc.SpotLight']
        };

        let components: string[] = [];
        
        if (category === 'all') {
            for (const cat in componentCategories) {
                components = components.concat(componentCategories[cat]);
            }
        } else if (componentCategories[category]) {
            components = componentCategories[category];
        }

        return {
            success: true,
            data: {
                category: category,
                components: components
            }
        };
    }

    private isValidPropertyDescriptor(propData: any): boolean {
        // Check if this is a valid property descriptor object
        if (typeof propData !== 'object' || propData === null) {
            return false;
        }
        
        try {
            const keys = Object.keys(propData);
            
            // Avoid traversing simple value objects like {width: 200, height: 150}
            const isSimpleValueObject = keys.every(key => {
                const value = propData[key];
                return typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean';
            });
            
            if (isSimpleValueObject) {
                return false;
            }
            
            // Check for property descriptor characteristic fields without using the 'in' operator
            const hasName = keys.includes('name');
            const hasValue = keys.includes('value');
            const hasType = keys.includes('type');
            const hasDisplayName = keys.includes('displayName');
            const hasReadonly = keys.includes('readonly');
            
            // Must have name or value field, typically also has type field
            const hasValidStructure = (hasName || hasValue) && (hasType || hasDisplayName || hasReadonly);
            
            // Extra check: skip deep traversal if default field exists with a complex structure
            if (keys.includes('default') && propData.default && typeof propData.default === 'object') {
                const defaultKeys = Object.keys(propData.default);
                if (defaultKeys.includes('value') && typeof propData.default.value === 'object') {
                    // Only return top-level properties; do not traverse into default.value
                    return hasValidStructure;
                }
            }
            
            return hasValidStructure;
        } catch (error) {
            console.warn(`[isValidPropertyDescriptor] Error checking property descriptor:`, error);
            return false;
        }
    }

    private analyzeProperty(component: any, propertyName: string): { exists: boolean; type: string; availableProperties: string[]; originalValue: any } {
        // Extract available properties from complex component structure
        const availableProperties: string[] = [];
        let propertyValue: any = undefined;
        let propertyExists = false;
        
        // Try multiple approaches to find the property:
        // 1. Direct property access
        if (Object.prototype.hasOwnProperty.call(component, propertyName)) {
            propertyValue = component[propertyName];
            propertyExists = true;
        }
        
        // 2. Search in nested structure (e.g., complex structure seen in test data)
        if (!propertyExists && component.properties && typeof component.properties === 'object') {
            // First check if properties.value exists (structure seen in getComponents)
            if (component.properties.value && typeof component.properties.value === 'object') {
                const valueObj = component.properties.value;
                for (const [key, propData] of Object.entries(valueObj)) {
                    // Check if propData is a valid property descriptor object
                    // Ensure propData is an object with expected property structure
                    if (this.isValidPropertyDescriptor(propData)) {
                        const propInfo = propData as any;
                        availableProperties.push(key);
                        if (key === propertyName) {
                            // Prefer value property; fall back to propData itself
                            try {
                                const propKeys = Object.keys(propInfo);
                                propertyValue = propKeys.includes('value') ? propInfo.value : propInfo;
                            } catch (error) {
                                // Fall back to propInfo if check fails
                                propertyValue = propInfo;
                            }
                            propertyExists = true;
                        }
                    }
                }
            } else {
                // Fallback: search directly in properties
                for (const [key, propData] of Object.entries(component.properties)) {
                    if (this.isValidPropertyDescriptor(propData)) {
                        const propInfo = propData as any;
                        availableProperties.push(key);
                        if (key === propertyName) {
                            // Prefer value property; fall back to propData itself
                            try {
                                const propKeys = Object.keys(propInfo);
                                propertyValue = propKeys.includes('value') ? propInfo.value : propInfo;
                            } catch (error) {
                                // Fall back to propInfo if check fails
                                propertyValue = propInfo;
                            }
                            propertyExists = true;
                        }
                    }
                }
            }
        }
        
        // 3. Extract simple property names from direct attributes
        if (availableProperties.length === 0) {
            for (const key of Object.keys(component)) {
                if (!key.startsWith('_') && !['__type__', 'cid', 'node', 'uuid', 'name', 'enabled', 'type', 'readonly', 'visible'].includes(key)) {
                    availableProperties.push(key);
                }
            }
        }
        
        if (!propertyExists) {
            return {
                exists: false,
                type: 'unknown',
                availableProperties,
                originalValue: undefined
            };
        }
        
        let type = 'unknown';
        
        // Smart type detection
        if (Array.isArray(propertyValue)) {
            // Array type detection
            if (propertyName.toLowerCase().includes('node')) {
                type = 'nodeArray';
            } else if (propertyName.toLowerCase().includes('color')) {
                type = 'colorArray';
            } else {
                type = 'array';
            }
        } else if (typeof propertyValue === 'string') {
            // Check if property name suggests it's an asset
            if (['spriteFrame', 'texture', 'material', 'font', 'clip', 'prefab'].includes(propertyName.toLowerCase())) {
                type = 'asset';
            } else {
                type = 'string';
            }
        } else if (typeof propertyValue === 'number') {
            type = 'number';
        } else if (typeof propertyValue === 'boolean') {
            type = 'boolean';
        } else if (propertyValue && typeof propertyValue === 'object') {
            try {
                const keys = Object.keys(propertyValue);
                if (keys.includes('r') && keys.includes('g') && keys.includes('b')) {
                    type = 'color';
                } else if (keys.includes('x') && keys.includes('y')) {
                    type = propertyValue.z !== undefined ? 'vec3' : 'vec2';
                } else if (keys.includes('width') && keys.includes('height')) {
                    type = 'size';
                } else if (keys.includes('uuid') || keys.includes('__uuid__')) {
                    // Check if this is a node reference (via property name or __id__ attribute)
                    if (propertyName.toLowerCase().includes('node') || 
                        propertyName.toLowerCase().includes('target') ||
                        keys.includes('__id__')) {
                        type = 'node';
                    } else {
                        type = 'asset';
                    }
                } else if (keys.includes('__id__')) {
                    // Node reference characteristic
                    type = 'node';
                } else {
                    type = 'object';
                }
            } catch (error) {
                console.warn(`[analyzeProperty] Error checking property type for: ${JSON.stringify(propertyValue)}`);
                type = 'object';
            }
        } else if (propertyValue === null || propertyValue === undefined) {
            // For null/undefined values, check property name to determine type
            if (['spriteFrame', 'texture', 'material', 'font', 'clip', 'prefab'].includes(propertyName.toLowerCase())) {
                type = 'asset';
            } else if (propertyName.toLowerCase().includes('node') || 
                      propertyName.toLowerCase().includes('target')) {
                type = 'node';
            } else if (propertyName.toLowerCase().includes('component')) {
                type = 'component';
            } else {
                type = 'unknown';
            }
        }
        
        return {
            exists: true,
            type,
            availableProperties,
            originalValue: propertyValue
        };
    }

    private smartConvertValue(inputValue: any, propertyInfo: any): any {
        const { type, originalValue } = propertyInfo;
        
        console.log(`[smartConvertValue] Converting ${JSON.stringify(inputValue)} to type: ${type}`);
        
        switch (type) {
            case 'string':
                return String(inputValue);
                
            case 'number':
                return Number(inputValue);
                
            case 'boolean':
                if (typeof inputValue === 'boolean') return inputValue;
                if (typeof inputValue === 'string') {
                    return inputValue.toLowerCase() === 'true' || inputValue === '1';
                }
                return Boolean(inputValue);
                
            case 'color':
                // Optimized color handling supporting multiple input formats
                if (typeof inputValue === 'string') {
                    // String format: hex, color names, rgb()/rgba()
                    return this.parseColorString(inputValue);
                } else if (typeof inputValue === 'object' && inputValue !== null) {
                    try {
                        const inputKeys = Object.keys(inputValue);
                        // If input is a color object, validate and convert
                        if (inputKeys.includes('r') || inputKeys.includes('g') || inputKeys.includes('b')) {
                            return {
                                r: Math.min(255, Math.max(0, Number(inputValue.r) || 0)),
                                g: Math.min(255, Math.max(0, Number(inputValue.g) || 0)),
                                b: Math.min(255, Math.max(0, Number(inputValue.b) || 0)),
                                a: inputValue.a !== undefined ? Math.min(255, Math.max(0, Number(inputValue.a))) : 255
                            };
                        }
                    } catch (error) {
                        console.warn(`[smartConvertValue] Invalid color object: ${JSON.stringify(inputValue)}`);
                    }
                }
                // Keep original value structure and update provided fields
                if (originalValue && typeof originalValue === 'object') {
                    try {
                        const inputKeys = typeof inputValue === 'object' && inputValue ? Object.keys(inputValue) : [];
                        return {
                            r: inputKeys.includes('r') ? Math.min(255, Math.max(0, Number(inputValue.r))) : (originalValue.r || 255),
                            g: inputKeys.includes('g') ? Math.min(255, Math.max(0, Number(inputValue.g))) : (originalValue.g || 255),
                            b: inputKeys.includes('b') ? Math.min(255, Math.max(0, Number(inputValue.b))) : (originalValue.b || 255),
                            a: inputKeys.includes('a') ? Math.min(255, Math.max(0, Number(inputValue.a))) : (originalValue.a || 255)
                        };
                    } catch (error) {
                        console.warn(`[smartConvertValue] Error processing color with original value: ${error}`);
                    }
                }
                // Default to white
                console.warn(`[smartConvertValue] Using default white color for invalid input: ${JSON.stringify(inputValue)}`);
                return { r: 255, g: 255, b: 255, a: 255 };
                
            case 'vec2':
                if (typeof inputValue === 'object' && inputValue !== null) {
                    return {
                        x: Number(inputValue.x) || originalValue.x || 0,
                        y: Number(inputValue.y) || originalValue.y || 0
                    };
                }
                return originalValue;
                
            case 'vec3':
                if (typeof inputValue === 'object' && inputValue !== null) {
                    return {
                        x: Number(inputValue.x) || originalValue.x || 0,
                        y: Number(inputValue.y) || originalValue.y || 0,
                        z: Number(inputValue.z) || originalValue.z || 0
                    };
                }
                return originalValue;
                
            case 'size':
                if (typeof inputValue === 'object' && inputValue !== null) {
                    return {
                        width: Number(inputValue.width) || originalValue.width || 100,
                        height: Number(inputValue.height) || originalValue.height || 100
                    };
                }
                return originalValue;
                
            case 'node':
                if (typeof inputValue === 'string') {
                    // Node references require special handling
                    return inputValue;
                } else if (typeof inputValue === 'object' && inputValue !== null) {
                    // Already object form: return UUID or full object
                    return inputValue.uuid || inputValue;
                }
                return originalValue;
                
            case 'asset':
                if (typeof inputValue === 'string') {
                    // Convert string path to asset object
                    return { uuid: inputValue };
                } else if (typeof inputValue === 'object' && inputValue !== null) {
                    return inputValue;
                }
                return originalValue;
                
            default:
                // For unknown types, try to preserve original structure
                if (typeof inputValue === typeof originalValue) {
                    return inputValue;
                }
                return originalValue;
        }
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

    private async verifyPropertyChange(nodeUuid: string, componentType: string, property: string, originalValue: any, expectedValue: any): Promise<{ verified: boolean; readable: boolean; actualValue: any; fullData: any }> {
        console.log(`[verifyPropertyChange] Starting verification for ${componentType}.${property}`);
        console.log(`[verifyPropertyChange] Expected value:`, JSON.stringify(expectedValue));
        console.log(`[verifyPropertyChange] Original value:`, JSON.stringify(originalValue));

        try {
            // Same read the get_components tool performs — see readDumpProperty.
            const read = await this.readDumpProperty(nodeUuid, componentType, property);
            console.log(`[verifyPropertyChange] readDumpProperty found:`, read.found);

            if (read.found) {
                const propertyData = read.entry;
                const actualValue = read.value;
                console.log(`[verifyPropertyChange] actualValue:`, JSON.stringify(actualValue));

                // Check whether actual value matches expected value
                let verified = false;

                if (typeof expectedValue === 'object' && expectedValue !== null && 'uuid' in expectedValue) {
                    // For reference types (node/component/asset), compare UUID
                    const actualUuid = actualValue && typeof actualValue === 'object' && 'uuid' in actualValue ? actualValue.uuid : '';
                    const expectedUuid = expectedValue.uuid || '';
                    verified = actualUuid === expectedUuid && expectedUuid !== '';
                    
                    console.log(`[verifyPropertyChange] Reference comparison:`);
                    console.log(`  - Expected UUID: "${expectedUuid}"`);
                    console.log(`  - Actual UUID: "${actualUuid}"`);
                    console.log(`  - UUID match: ${actualUuid === expectedUuid}`);
                    console.log(`  - UUID not empty: ${expectedUuid !== ''}`);
                    console.log(`  - Final verified: ${verified}`);
                } else {
                    // For other types, compare values directly
                    console.log(`[verifyPropertyChange] Value comparison:`);
                    console.log(`  - Expected type: ${typeof expectedValue}`);
                    console.log(`  - Actual type: ${typeof actualValue}`);
                    
                    if (typeof actualValue === typeof expectedValue) {
                        if (typeof actualValue === 'object' && actualValue !== null && expectedValue !== null) {
                            // Deep comparison for object types
                            verified = JSON.stringify(actualValue) === JSON.stringify(expectedValue);
                            console.log(`  - Object comparison (JSON): ${verified}`);
                        } else {
                            // Direct comparison for primitive types
                            verified = actualValue === expectedValue;
                            console.log(`  - Direct comparison: ${verified}`);
                        }
                    } else {
                        // Special handling for type mismatches (e.g. number vs string)
                        const stringMatch = String(actualValue) === String(expectedValue);
                        const numberMatch = Number(actualValue) === Number(expectedValue);
                        verified = stringMatch || numberMatch;
                        console.log(`  - String match: ${stringMatch}`);
                        console.log(`  - Number match: ${numberMatch}`);
                        console.log(`  - Type mismatch verified: ${verified}`);
                    }
                }
                
                console.log(`[verifyPropertyChange] Final verification result: ${verified}`);
                console.log(`[verifyPropertyChange] Final actualValue:`, JSON.stringify(actualValue));
                
                const result = {
                    verified,
                    readable: true,
                    actualValue,
                    fullData: {
                        // Return only modified property info, not full component data
                        modifiedProperty: {
                            name: property,
                            before: originalValue,
                            expected: expectedValue,
                            actual: actualValue,
                            verified,
                            propertyMetadata: propertyData // Only includes metadata for this property
                        },
                        componentSummary: { nodeUuid, componentType }
                    }
                };

                console.log(`[verifyPropertyChange] Returning result:`, JSON.stringify(result, null, 2));
                return result;
            } else {
                console.log(`[verifyPropertyChange] '${property}' is not exposed in the dump — cannot verify`);
            }
        } catch (error) {
            console.error('[verifyPropertyChange] Verification failed with error:', error);
            console.error('[verifyPropertyChange] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
        }

        // Nothing was read back, so this is "no evidence", not "the editor refused".
        return {
            verified: false,
            readable: false,
            actualValue: undefined,
            fullData: null
        };
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