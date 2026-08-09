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
import type { PreviewLogStore } from './preview-log-store';

export type ToolDispatcher = (toolName: string, args: any) => Promise<any>;

export interface ToolInstanceDeps {
    dispatch?: ToolDispatcher;
    logs?: PreviewLogStore;
}

export function createToolInstances(deps: ToolInstanceDeps = {}): Record<string, any> {
    return {
        scene: new SceneTools(),
        node: new NodeTools(),
        component: new ComponentTools(),
        prefab: new PrefabTools(),
        project: new ProjectTools(),
        debug: new DebugTools(deps.logs),
        sceneAdvanced: new SceneAdvancedTools(),
        assetAdvanced: new AssetAdvancedTools(),
        skeletalAnimation: new SkeletalAnimationTools(),
        ecs: new EcsTools(),
        batch: new BatchTools(deps.dispatch)
    };
}
