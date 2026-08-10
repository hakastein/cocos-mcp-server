import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { fromScene, textOf } from './shared';
import { signatureOf, hashSignature, diffSignatures, SignatureDiff } from '../scene-signature';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';
import type { SceneDirtyReport } from '../scene-contract';

async function waitSceneReady(ctx: ToolContext, maxWaitMs = 1500): Promise<boolean> {
    for (let waited = 0; waited <= maxWaitMs; waited += 150) {
        try {
            if (await ctx.editor.scene.querySceneReady()) return true;
        } catch {
        }
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    return false;
}

function emptySceneTemplate(sceneName: string): unknown[] {
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

export const sceneGetCurrentScene = defineTool({
    name: 'scene_get_current_scene',
    description: 'The scene the editor has open right now: name, uuid, its db:// url, whether that url '
        + 'exists at all (an unsaved scene has none), whether loading has finished, and how many root '
        + 'nodes it has. Ask this before any scene-wide call, so the answer is known to be about the '
        + 'scene you think is open.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const ready = await waitSceneReady(ctx);
        let tree;
        try {
            tree = await ctx.editor.scene.queryNodeTree();
        } catch (treeError) {
            try {
                return fromScene(await ctx.sceneScript.call('getCurrentSceneInfo'));
            } catch (scriptError) {
                return fail('scene_unavailable',
                    `Editor API failed: ${textOf(treeError)}; Scene script failed: ${textOf(scriptError)}`);
            }
        }
        if (!tree?.uuid) return fail('no_scene', 'No scene data available');

        const url = await ctx.editor.assetDb.queryUrl(tree.uuid).catch(() => null);
        return ok({
            name: tree.name ?? 'Current Scene',
            uuid: tree.uuid,
            type: tree.type ?? 'cc.Scene',
            active: tree.active ?? true,
            url,
            saved: !!url,
            ready,
            nodeCount: tree.children?.length ?? 0
        });
    }
});

export const sceneGetSceneList = defineTool({
    name: 'scene_get_scene_list',
    description: 'Every .scene asset in the project as name + db:// path + uuid. This is the whole set '
        + 'of scenes there is — a scene absent here does not exist, whatever a path was expected to be.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const assets = await ctx.editor.assetDb.queryAssets('db://assets/**/*.scene');
        return ok(assets.map(asset => ({ name: asset.name, path: asset.url, uuid: asset.uuid })));
    }
});

export const sceneOpenScene = defineTool({
    name: 'scene_open_scene',
    description: 'Open a scene by its db:// path, replacing whatever is open. The path is resolved to a '
        + 'uuid first, so a path naming no asset is reported instead of opening nothing.',
    schema: z.object({
        scenePath: z.string().describe('The scene file path, e.g. db://assets/scenes/main.scene')
    }),
    async handler(args, ctx) {
        const uuid = await ctx.editor.assetDb.queryUuid(args.scenePath);
        if (!uuid) return fail('scene_not_found', `Scene not found: ${args.scenePath}`);
        await ctx.editor.scene.openScene(uuid);
        return ok(undefined, `Scene opened: ${args.scenePath}`);
    }
});

export const sceneSaveScene = defineTool({
    name: 'scene_save_scene',
    description: 'Write the open scene to its file. This saves everything the scene holds, including '
        + 'whatever the person at the editor has in flight — so a scene reported dirty is theirs to '
        + 'save, not yours.',
    schema: z.object({}),
    async handler(_args, ctx) {
        await ctx.editor.scene.saveScene();
        return ok(undefined, 'Scene saved successfully');
    }
});

export const sceneCloseScene = defineTool({
    name: 'scene_close_scene',
    description: 'Close the open scene. Unsaved changes die silently: nothing prompts, and a write made '
        + 'through this bridge leaves no undo step for the editor to notice. Check scene_query_dirty '
        + 'first. A refusal from the editor is reported rather than swallowed.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const closed = await ctx.editor.scene.closeScene();
        if (!closed) {
            return fail('close_rejected', 'The editor refused to close the scene',
                'This is what the editor answers when there is no scene to close, or when closing was '
                + 'declined. The scene is still open.');
        }
        return ok(undefined, 'Scene closed successfully');
    }
});

export const sceneCreateScene = defineTool({
    name: 'scene_create_scene',
    description: 'Create a .scene asset holding an EMPTY scene: the scene root and its global settings '
        + '(ambient, skybox, fog, octree) and nothing else — no Canvas, no camera, no light. Everything '
        + 'the scene needs is added afterwards. The asset is written to disk; it is not opened.',
    schema: z.object({
        sceneName: z.string().describe('Name of the new scene'),
        savePath: z.string().describe('Where to write it: a full db://assets/scenes/NewScene.scene, or a '
            + 'folder, in which case sceneName.scene is appended')
    }),
    async handler(args, ctx) {
        const fullPath = args.savePath.endsWith('.scene')
            ? args.savePath
            : `${args.savePath}/${args.sceneName}.scene`;
        const content = JSON.stringify(emptySceneTemplate(args.sceneName), null, 2);
        const created = await ctx.editor.assetDb.createAsset(fullPath, content);
        if (!created) {
            return fail('create_failed', `The asset database did not create ${fullPath}`,
                'Most often the path already exists or its folder does not. Check with '
                + 'scene_get_scene_list and pass a free path.');
        }
        return ok(
            { uuid: created.uuid, url: created.url, name: args.sceneName },
            `Scene '${args.sceneName}' created at ${created.url}`
        );
    }
});

export const sceneDump = defineTool({
    name: 'scene_dump',
    description: 'One call returning EVERY node in the scene as a flat list: uuid, name, full slash path, '
        + 'parentUuid, active, activeInHierarchy, childCount and (by default) each component\'s class name, '
        + 'uuid and enabled flag. Use this instead of walking the tree node-by-node or parsing the .scene '
        + 'file from disk — it is engine-side, so class names are real and activeInHierarchy is accurate.',
    schema: z.object({
        includeComponents: booleanArg.optional().describe('Include each node\'s components (default true)'),
        includeTransform: booleanArg.optional().describe('Include position/rotation(euler)/scale (default false)'),
        rootUuid: z.string().optional().describe('Dump only this node\'s subtree (default: whole scene)')
    }),
    async handler(args, ctx) {
        return fromScene(await ctx.sceneScript.call('dumpSceneNodes', {
            includeComponents: args.includeComponents,
            includeTransform: args.includeTransform,
            rootUuid: args.rootUuid
        }));
    }
});

interface ChecksumReport {
    hash: string;
    nodeCount: number;
    signature: Record<string, string>;
    pathCollisions?: number;
    warning?: string;
    diff?: SignatureDiff;
    matches?: boolean;
}

export const sceneChecksum = defineTool({
    name: 'scene_checksum',
    description: 'Scene-state signature for regression checks: per-node-path active/activeInHierarchy plus '
        + 'its sorted component class names, and a sha1 over all of it. Capture it BEFORE scene surgery, '
        + 'then call again afterwards passing the previous signature as `baseline` to get added/removed/changed '
        + 'nodes in one call — this is how you catch an accidentally deactivated node (e.g. the camera).',
    schema: z.object({
        baseline: z.record(z.string()).optional().describe('The `signature` object returned by an earlier '
            + 'checksum call — the signature itself, not the whole response. When given, the answer adds '
            + '`diff` and `matches`.')
    }),
    async handler(args, ctx) {
        const dump = await ctx.sceneScript.call('dumpSceneNodes', { includeComponents: true });
        if (!dump?.success) return fromScene(dump);

        const nodes = dump.data.nodes || [];
        const signature = signatureOf(nodes);
        const report: ChecksumReport = { hash: hashSignature(signature), nodeCount: nodes.length, signature };

        const keyCount = Object.keys(signature).length;
        if (keyCount !== nodes.length) {
            report.pathCollisions = nodes.length - keyCount;
            report.warning = `${report.pathCollisions} node(s) share a path and were merged in the `
                + 'signature — the diff is blind to those.';
        }
        if (args.baseline) {
            report.diff = diffSignatures(args.baseline, signature);
            report.matches = !report.diff.added.length
                && !report.diff.removed.length
                && !report.diff.changed.length;
        }
        return ok(report);
    }
});

export const sceneFindComponentOwners = defineTool({
    name: 'scene_find_component_owners',
    description: 'Every node in the open scene that carries a component of the given class, as node path + '
        + 'uuid + component uuid. Use this to answer "which node owns component X" instead of inferring it '
        + 'from a .scene/.prefab file, where components are written as a 23-char compressed uuid and the '
        + 'usual shortcut ("it is in the file, so it is on the root") cannot actually tell the difference. '
        + 'Accepts the @ccclass name or a builtin spelled either "Sprite" or "cc.Sprite".',
    schema: z.object({
        className: z.string().describe('Component class name, e.g. CharacterAnimator or cc.Sprite'),
        includeInactive: booleanArg.optional().describe('Include nodes that are inactive in the hierarchy '
            + '(default true)')
    }),
    aliases: { componentType: 'className', component: 'className', type: 'className', name: 'className' },
    async handler(args, ctx) {
        return fromScene(await ctx.sceneScript.call('findComponentOwners', {
            className: args.className,
            includeInactive: args.includeInactive
        }));
    }
});

export const sceneQueryDirty = defineTool({
    name: 'scene_query_dirty',
    description: 'Whether the open scene holds changes its file does not. Decided by serializing the scene '
        + 'the way the save path does and diffing that against the file, so it sees a property written '
        + 'through this bridge — which the editor\'s own undo-based dirty flag does not, and which is why '
        + 'that flag alone reported such a scene as clean. Returns `dirty`, `differsFromDisk`, the editor\'s '
        + '`editorUndoDirty` for comparison, and up to 20 differing paths. `comparedAgainstDisk: false` '
        + 'means only the undo flag was available and `dirty: false` means "unknown". A dirty scene is for '
        + 'the person at the editor to save.',
    schema: z.object({}),
    async handler(_args, ctx) {
        let undoDirty: boolean | null = null;
        try {
            undoDirty = await ctx.editor.scene.queryDirty();
        } catch {
            undoDirty = null;
        }

        let comparison: SceneDirtyReport | null = null;
        let comparisonError = '';
        try {
            const result = await ctx.sceneScript.call('sceneDirtyAgainstDisk');
            if (result?.success) comparison = result.data;
            else comparisonError = result?.error || 'scene script unavailable';
        } catch (error) {
            comparisonError = textOf(error);
        }

        if (!comparison) {
            return ok(
                { dirty: undoDirty === true, comparedAgainstDisk: false, editorUndoDirty: undoDirty },
                `The scene could not be compared against its file (${comparisonError}), so this is the `
                + 'editor\'s undo state alone. That state does not see a property written through this '
                + 'bridge — treat \'dirty: false\' here as "unknown", not as "clean".'
            );
        }

        const dirty = comparison.differsFromDisk === true || undoDirty === true;
        return ok(
            {
                dirty,
                comparedAgainstDisk: true,
                differsFromDisk: comparison.differsFromDisk,
                editorUndoDirty: undoDirty,
                scenePath: comparison.scenePath,
                diffs: comparison.diffs
            },
            dirty
                ? `The open scene differs from ${comparison.scenePath} and must be saved by the person at `
                    + 'the editor. Do not call scene_save_scene on their behalf — it would also write '
                    + 'whatever they have open in the Inspector.'
                : 'The open scene matches its file on disk.'
        );
    }
});

export const sceneQueryReady = defineTool({
    name: 'scene_query_ready',
    description: 'Whether the editor has finished loading the open scene. A scene read while this is false '
        + 'is still assembling, and answers about it are transient.',
    schema: z.object({}),
    async handler(_args, ctx) {
        const ready = await ctx.editor.scene.querySceneReady();
        return ok({ ready }, ready ? 'Scene is ready' : 'Scene is not ready');
    }
});

export const sceneSoftReload = defineTool({
    name: 'scene_soft_reload',
    description: 'Reload the open scene in place, which is how recompiled scripts reach a running scene '
        + 'without reopening it. Node uuids of prefab-instance roots are re-created by the reload, so a '
        + 'uuid list captured earlier goes stale — address nodes by path afterwards, or dump again.',
    schema: z.object({}),
    async handler(_args, ctx) {
        await ctx.editor.scene.softReload();
        return ok(undefined, 'Scene soft reloaded successfully');
    }
});

export const sceneBeginUndoRecording = defineTool({
    name: 'scene_begin_undo_recording',
    description: 'Open an undo step over one node and return its undoId, which scene_end_undo_recording '
        + 'commits and scene_cancel_undo_recording discards. Writes made outside such a pair leave no undo '
        + 'step at all, which is why Ctrl+Z does not take them back.',
    schema: z.object({
        nodeUuid: z.string().describe('Node UUID to record')
    }),
    async handler(args, ctx) {
        const undoId = await ctx.editor.scene.beginRecording(args.nodeUuid);
        return ok({ undoId }, 'Undo recording started');
    }
});

export const sceneEndUndoRecording = defineTool({
    name: 'scene_end_undo_recording',
    description: 'Commit the undo step opened by scene_begin_undo_recording, so everything recorded since '
        + 'is one Ctrl+Z away in the editor.',
    schema: z.object({
        undoId: z.string().describe('Undo recording ID from scene_begin_undo_recording')
    }),
    async handler(args, ctx) {
        await ctx.editor.scene.endRecording(args.undoId);
        return ok(undefined, 'Undo recording ended');
    }
});

export const sceneCancelUndoRecording = defineTool({
    name: 'scene_cancel_undo_recording',
    description: 'Discard the undo step opened by scene_begin_undo_recording without pushing it onto the '
        + 'editor\'s undo stack.',
    schema: z.object({
        undoId: z.string().describe('Undo recording ID to cancel')
    }),
    async handler(args, ctx) {
        await ctx.editor.scene.cancelRecording(args.undoId);
        return ok(undefined, 'Undo recording cancelled');
    }
});

export const sceneTools: RegisteredTool[] = [
    sceneGetCurrentScene,
    sceneGetSceneList,
    sceneOpenScene,
    sceneSaveScene,
    sceneCloseScene,
    sceneCreateScene,
    sceneDump,
    sceneChecksum,
    sceneFindComponentOwners,
    sceneQueryDirty,
    sceneQueryReady,
    sceneSoftReload,
    sceneBeginUndoRecording,
    sceneEndUndoRecording,
    sceneCancelUndoRecording
];
