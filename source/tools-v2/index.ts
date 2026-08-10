import { ToolRegistry } from '../registry';
import { sceneTools } from './scene';
import { nodeTools } from './node';
import { componentTools } from './component';
import { prefabTools } from './prefab';
import { sceneOpsTools } from './scene-ops';
import { assetTools } from './asset';
import { buildTools } from './build';
import { debugTools } from './debug';
import { batchTools } from './batch';
import { ecsTools } from './ecs';
import { skeletalTools } from './skeletal';
import type { ToolContext } from '../context';

export interface ComposeDeps {
    ctx?: ToolContext;
}

export function composeTools(deps: ComposeDeps = {}): ToolRegistry {
    let registry: ToolRegistry;
    const dispatch = (name: string, args: any) => registry.invoke(name, args, deps.ctx as ToolContext);
    registry = new ToolRegistry([
        ...sceneTools,
        ...nodeTools,
        ...componentTools,
        ...prefabTools,
        ...sceneOpsTools,
        ...assetTools,
        ...buildTools,
        ...debugTools,
        ...batchTools(dispatch),
        ...ecsTools,
        ...skeletalTools
    ]);
    return registry;
}
