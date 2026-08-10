import { PrefabTools } from './tools/prefab-tools';
import { ProjectTools } from './tools/project-tools';
import { DebugTools } from './tools/debug-tools';
import { SceneAdvancedTools } from './tools/scene-advanced-tools';
import { AssetAdvancedTools } from './tools/asset-advanced-tools';
import { SkeletalAnimationTools } from './tools/skeletal-animation-tools';
import { BatchTools } from './tools/batch-tools';
import { EcsTools } from './tools/ecs-tools';
import { ToolRegistry } from './registry';
import { legacyTools } from './legacy-adapter';
import { sceneTools } from './tools-v2/scene';
import { nodeTools } from './tools-v2/node';
import { componentTools } from './tools-v2/component';
import type { PreviewLogStore } from './preview-log-store';
import type { ToolContext } from './context';

export type ToolDispatcher = (toolName: string, args: any) => Promise<any>;

export interface ToolInstanceDeps {
    dispatch?: ToolDispatcher;
    logs?: PreviewLogStore;
}

export function createToolInstances(deps: ToolInstanceDeps = {}): Record<string, any> {
    return {
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

export interface ComposeDeps {
    logs?: PreviewLogStore;
    ctx?: ToolContext;
}

export function composeTools(deps: ComposeDeps = {}): ToolRegistry {
    let registry: ToolRegistry;
    const executors = createToolInstances({
        dispatch: (name, args) => registry.invoke(name, args, deps.ctx as ToolContext),
        logs: deps.logs
    });
    registry = new ToolRegistry([
        ...sceneTools,
        ...nodeTools,
        ...componentTools,
        ...Object.entries(executors).flatMap(([category, executor]) => legacyTools(category, executor))
    ]);
    return registry;
}
