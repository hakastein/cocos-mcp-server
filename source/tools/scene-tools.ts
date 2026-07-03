import { ToolDefinition, ToolResponse, ToolExecutor, SceneInfo } from '../types';

export class SceneTools implements ToolExecutor {
    getTools(): ToolDefinition[] {
        return [
            {
                name: 'get_current_scene',
                description: 'Get current scene information',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'get_scene_list',
                description: 'Get all scenes in the project',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'open_scene',
                description: 'Open a scene by path',
                inputSchema: {
                    type: 'object',
                    properties: {
                        scenePath: { type: 'string', description: 'The scene file path' }
                    },
                    required: ['scenePath']
                }
            },
            {
                name: 'save_scene',
                description: 'Save current scene',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'create_scene',
                description: 'Create a new scene asset',
                inputSchema: {
                    type: 'object',
                    properties: {
                        sceneName: { type: 'string', description: 'Name of the new scene' },
                        savePath: {
                            type: 'string',
                            description: 'Path to save the scene (e.g., db://assets/scenes/NewScene.scene)'
                        }
                    },
                    required: ['sceneName', 'savePath']
                }
            },
            {
                name: 'save_scene_as',
                description: 'Save scene as new file',
                inputSchema: {
                    type: 'object',
                    properties: {
                        path: { type: 'string', description: 'Path to save the scene' }
                    },
                    required: ['path']
                }
            },
            {
                name: 'close_scene',
                description: 'Close current scene',
                inputSchema: { type: 'object', properties: {} }
            },
            {
                name: 'get_scene_hierarchy',
                description: 'Get the complete hierarchy of current scene',
                inputSchema: {
                    type: 'object',
                    properties: {
                        includeComponents: {
                            type: 'boolean',
                            description: 'Include component information',
                            default: false
                        }
                    }
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        switch (toolName) {
            case 'get_current_scene':   return this.getCurrentScene();
            case 'get_scene_list':      return this.getSceneList();
            case 'open_scene':          return this.openScene(args.scenePath);
            case 'save_scene':          return this.saveScene();
            case 'create_scene':        return this.createScene(args.sceneName, args.savePath);
            case 'save_scene_as':       return this.saveSceneAs(args.path);
            case 'close_scene':         return this.closeScene();
            case 'get_scene_hierarchy': return this.getSceneHierarchy(args.includeComponents);
            default: throw new Error(`Unknown tool: ${toolName}`);
        }
    }

    /** Poll scene readiness briefly to avoid reading a transient/loading scene. */
    private async waitSceneReady(maxWaitMs = 1500): Promise<boolean> {
        for (let waited = 0; waited <= maxWaitMs; waited += 150) {
            try {
                const r: any = await Editor.Message.request('scene', 'query-is-ready');
                if (r === true || r?.ready === true) return true;
            } catch { /* ignore, retry */ }
            await new Promise(res => setTimeout(res, 150));
        }
        return false;
    }

    private async getCurrentScene(): Promise<ToolResponse> {
        try {
            // Wait until the scene has finished loading, so we never report a transient
            // untitled/empty scene while the real scene is still opening.
            const ready = await this.waitSceneReady();
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            if (tree?.uuid) {
                // Resolve the on-disk scene file so callers can tell WHICH scene is open
                // (and whether it is an unsaved/untitled scene) — key to spotting a stale
                // or wrong current scene.
                let url: string | null = null;
                try { url = await Editor.Message.request('asset-db', 'query-url', tree.uuid); } catch { /* untitled */ }
                return {
                    success: true,
                    data: {
                        name: tree.name ?? 'Current Scene',
                        uuid: tree.uuid,
                        type: tree.type ?? 'cc.Scene',
                        active: tree.active ?? true,
                        url,
                        saved: !!url,
                        ready,
                        nodeCount: tree.children?.length ?? 0
                    }
                };
            }
            return { success: false, error: 'No scene data available' };
        } catch (err: any) {
            // Fallback: query via scene script
            try {
                const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'cocos-mcp-server',
                    method: 'getCurrentSceneInfo',
                    args: []
                });
                return result;
            } catch (err2: any) {
                return { success: false, error: `Editor API failed: ${err.message}; Scene script failed: ${err2.message}` };
            }
        }
    }

    private async getSceneList(): Promise<ToolResponse> {
        try {
            const results: any[] = await Editor.Message.request('asset-db', 'query-assets', {
                pattern: 'db://assets/**/*.scene'
            });
            const scenes: SceneInfo[] = results.map(asset => ({
                name: asset.name,
                path: asset.url,
                uuid: asset.uuid
            }));
            return { success: true, data: scenes };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async openScene(scenePath: string): Promise<ToolResponse> {
        try {
            const uuid: string | null = await Editor.Message.request('asset-db', 'query-uuid', scenePath);
            if (!uuid) throw new Error('Scene not found');
            await Editor.Message.request('scene', 'open-scene', uuid);
            return { success: true, message: `Scene opened: ${scenePath}` };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async saveScene(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('scene', 'save-scene');
            return { success: true, message: 'Scene saved successfully' };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async createScene(sceneName: string, savePath: string): Promise<ToolResponse> {
        const fullPath = savePath.endsWith('.scene') ? savePath : `${savePath}/${sceneName}.scene`;
        const sceneContent = JSON.stringify(this.buildSceneTemplate(sceneName), null, 2);
        try {
            const result: any = await Editor.Message.request('asset-db', 'create-asset', fullPath, sceneContent);
            const sceneList = await this.getSceneList();
            const created = sceneList.data?.find((s: any) => s.uuid === result.uuid);
            return {
                success: true,
                data: {
                    uuid: result.uuid,
                    url: result.url,
                    name: sceneName,
                    message: `Scene '${sceneName}' created successfully`,
                    sceneVerified: !!created
                },
                verificationData: created
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async getSceneHierarchy(includeComponents: boolean = false): Promise<ToolResponse> {
        try {
            await this.waitSceneReady();
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            if (tree) {
                return { success: true, data: this.buildHierarchy(tree, includeComponents) };
            }
            return { success: false, error: 'No scene hierarchy available' };
        } catch (err: any) {
            // Fallback: query via scene script
            try {
                const result: any = await Editor.Message.request('scene', 'execute-scene-script', {
                    name: 'cocos-mcp-server',
                    method: 'getSceneHierarchy',
                    args: [includeComponents]
                });
                return result;
            } catch (err2: any) {
                return { success: false, error: `Editor API failed: ${err.message}; Scene script failed: ${err2.message}` };
            }
        }
    }

    private buildHierarchy(node: any, includeComponents: boolean): any {
        const result: any = {
            uuid: node.uuid,
            name: node.name,
            type: node.type,
            active: node.active,
            children: node.children?.map((child: any) => this.buildHierarchy(child, includeComponents)) ?? []
        };
        if (includeComponents && node.__comps__) {
            result.components = node.__comps__.map((comp: any) => ({
                type: comp.__type__ ?? 'Unknown',
                enabled: comp.enabled ?? true
            }));
        }
        return result;
    }

    private async saveSceneAs(path: string): Promise<ToolResponse> {
        // NOTE: the editor's `scene/save-as-scene` channel only opens the native file
        // dialog (and blocks until dismissed), so it is unusable headlessly. There is also
        // no `scene/serialize` message in 3.8.x. Instead we flush the current scene to its
        // own file and copy that file to the target path via the asset database.
        try {
            if (!path || !path.startsWith('db://')) {
                return {
                    success: false,
                    error: 'save_scene_as requires a db:// target path, e.g. db://assets/scenes/MyScene.scene'
                };
            }
            const targetPath = path.endsWith('.scene') ? path : `${path}.scene`;

            // Flush in-memory edits so the copy reflects the current scene state.
            // (This also writes the current scene's own file, as a real "Save As" does.)
            await Editor.Message.request('scene', 'save-scene');

            // Resolve the current scene's source url from its (runtime) root uuid.
            const tree: any = await Editor.Message.request('scene', 'query-node-tree');
            const sceneUuid: string | undefined = tree?.uuid;
            const sourceUrl: string | null = sceneUuid
                ? await Editor.Message.request('asset-db', 'query-url', sceneUuid).catch(() => null)
                : null;
            if (!sourceUrl) {
                return { success: false, error: 'Could not resolve the current scene source file to copy from' };
            }
            if (sourceUrl === targetPath) {
                return { success: true, data: { path: targetPath, message: 'Target equals current scene; saved in place' } };
            }

            // Copy the scene asset directly to the target (overwrite if it exists) — no dialog.
            const existing: string | null = await Editor.Message.request('asset-db', 'query-uuid', targetPath).catch(() => null);
            const result: any = await (Editor.Message.request as any)(
                'asset-db', 'copy-asset', sourceUrl, targetPath, { overwrite: true }
            );

            return {
                success: true,
                data: {
                    path: result?.url ?? targetPath,
                    uuid: result?.uuid ?? null,
                    source: sourceUrl,
                    overwritten: !!existing,
                    message: `Scene saved to ${targetPath} (headless copy of ${sourceUrl}, no dialog)`
                }
            };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private async closeScene(): Promise<ToolResponse> {
        try {
            await Editor.Message.request('scene', 'close-scene');
            return { success: true, message: 'Scene closed successfully' };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    }

    private buildSceneTemplate(sceneName: string): any[] {
        return [
            {
                '__type__': 'cc.SceneAsset', '_name': sceneName, '_objFlags': 0,
                '__editorExtras__': {}, '_native': '', 'scene': { '__id__': 1 }
            },
            {
                '__type__': 'cc.Scene', '_name': sceneName, '_objFlags': 0,
                '__editorExtras__': {}, '_parent': null, '_children': [],
                '_active': true, '_components': [], '_prefab': null,
                '_lpos': { '__type__': 'cc.Vec3', 'x': 0, 'y': 0, 'z': 0 },
                '_lrot': { '__type__': 'cc.Quat', 'x': 0, 'y': 0, 'z': 0, 'w': 1 },
                '_lscale': { '__type__': 'cc.Vec3', 'x': 1, 'y': 1, 'z': 1 },
                '_mobility': 0, '_layer': 1073741824,
                '_euler': { '__type__': 'cc.Vec3', 'x': 0, 'y': 0, 'z': 0 },
                'autoReleaseAssets': false, '_globals': { '__id__': 2 }, '_id': 'scene'
            },
            {
                '__type__': 'cc.SceneGlobals',
                'ambient': { '__id__': 3 }, 'skybox': { '__id__': 4 },
                'fog': { '__id__': 5 }, 'octree': { '__id__': 6 }
            },
            {
                '__type__': 'cc.AmbientInfo',
                '_skyColorHDR': { '__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.5, 'z': 0.8, 'w': 0.520833 },
                '_skyColor': { '__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.5, 'z': 0.8, 'w': 0.520833 },
                '_skyIllumHDR': 20000, '_skyIllum': 20000,
                '_groundAlbedoHDR': { '__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.2, 'z': 0.2, 'w': 1 },
                '_groundAlbedo': { '__type__': 'cc.Vec4', 'x': 0.2, 'y': 0.2, 'z': 0.2, 'w': 1 }
            },
            {
                '__type__': 'cc.SkyboxInfo',
                '_envLightingType': 0, '_envmapHDR': null, '_envmap': null,
                '_envmapLodCount': 0, '_diffuseMapHDR': null, '_diffuseMap': null,
                '_enabled': false, '_useHDR': true, '_editableMaterial': null,
                '_reflectionHDR': null, '_reflectionMap': null, '_rotationAngle': 0
            },
            {
                '__type__': 'cc.FogInfo', '_type': 0,
                '_fogColor': { '__type__': 'cc.Color', 'r': 200, 'g': 200, 'b': 200, 'a': 255 },
                '_enabled': false, '_fogDensity': 0.3, '_fogStart': 0.5, '_fogEnd': 300,
                '_fogAtten': 5, '_fogTop': 1.5, '_fogRange': 1.2, '_accurate': false
            },
            {
                '__type__': 'cc.OctreeInfo', '_enabled': false,
                '_minPos': { '__type__': 'cc.Vec3', 'x': -1024, 'y': -1024, 'z': -1024 },
                '_maxPos': { '__type__': 'cc.Vec3', 'x': 1024, 'y': 1024, 'z': 1024 },
                '_depth': 8
            }
        ];
    }
}
