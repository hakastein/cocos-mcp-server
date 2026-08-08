import { SceneTools } from './tools/scene-tools';
import { NodeTools } from './tools/node-tools';
import { ComponentTools } from './tools/component-tools';
import { PrefabTools } from './tools/prefab-tools';
import { ProjectTools } from './tools/project-tools';
import { DebugTools } from './tools/debug-tools';
import { PreferencesTools } from './tools/preferences-tools';
import { ServerTools } from './tools/server-tools';
import { BroadcastTools } from './tools/broadcast-tools';
import { SceneAdvancedTools } from './tools/scene-advanced-tools';
import { SceneViewTools } from './tools/scene-view-tools';
import { ReferenceImageTools } from './tools/reference-image-tools';
import { AssetAdvancedTools } from './tools/asset-advanced-tools';
import { ValidationTools } from './tools/validation-tools';
import { SkeletalAnimationTools } from './tools/skeletal-animation-tools';
import { BatchTools } from './tools/batch-tools';
import { EcsTools } from './tools/ecs-tools';

export type ToolDispatcher = (toolName: string, args: any) => Promise<any>;

/**
 * The one list of tool categories.
 *
 * MCPServer used to build its own and ToolManager another, and a category present in the first
 * and absent from the second was silently dropped from the advertised list: ToolManager's saved
 * configuration is what `tools/list` filters by, so `skeletalAnimation_*` and later
 * `ecs_component_census` shipped, ran, and could not be called by anyone. Both now read this.
 */
export function createToolInstances(dispatch?: ToolDispatcher): Record<string, any> {
    return {
        scene: new SceneTools(),
        node: new NodeTools(),
        component: new ComponentTools(),
        prefab: new PrefabTools(),
        project: new ProjectTools(),
        debug: new DebugTools(),
        preferences: new PreferencesTools(),
        server: new ServerTools(),
        broadcast: new BroadcastTools(),
        sceneAdvanced: new SceneAdvancedTools(),
        sceneView: new SceneViewTools(),
        referenceImage: new ReferenceImageTools(),
        assetAdvanced: new AssetAdvancedTools(),
        validation: new ValidationTools(),
        skeletalAnimation: new SkeletalAnimationTools(),
        ecs: new EcsTools(),
        batch: new BatchTools(dispatch)
    };
}
