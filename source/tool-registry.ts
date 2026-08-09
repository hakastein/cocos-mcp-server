import { SceneTools } from './tools/scene-tools';
import { NodeTools } from './tools/node-tools';
import { ComponentTools } from './tools/component-tools';
import { PrefabTools } from './tools/prefab-tools';
import { ProjectTools } from './tools/project-tools';
import { DebugTools } from './tools/debug-tools';
import { SceneAdvancedTools } from './tools/scene-advanced-tools';
import { AssetAdvancedTools } from './tools/asset-advanced-tools';
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
        sceneAdvanced: new SceneAdvancedTools(),
        assetAdvanced: new AssetAdvancedTools(),
        skeletalAnimation: new SkeletalAnimationTools(),
        ecs: new EcsTools(),
        batch: new BatchTools(dispatch)
    };
}
