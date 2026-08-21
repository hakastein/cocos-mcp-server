import { Command } from 'commander';
import { DEFAULT_KIT, kitRoot, readKit } from '../ecs/kit.ts';
import { withProject } from './shared.ts';
import type { Report } from '../render/present.ts';
import type { ResolvedProject } from '../resolve.ts';

export interface CensusSpec {
    projectPath: string;
    kit?: string;
}

/**
 * The kit is read off disk and parsed; the driver is not asked anything, because the editor knows
 * what a scene holds and not what a system reads. The parser comes in on this line rather than at
 * the top of the file: it is 9 MB, and every other command would pay for loading it.
 */
export async function ecsCensus(spec: CensusSpec): Promise<Report> {
    const { runCensus } = await import('../ecs/census.ts');
    const root = kitRoot(spec.projectPath, spec.kit);
    const scan = readKit(root);
    return {
        kind: 'census',
        root,
        narrowed: spec.kit !== undefined && spec.kit !== DEFAULT_KIT,
        unreadable: scan.unreadable,
        result: runCensus(scan.sources, { filesSkipped: scan.unreadable.length })
    };
}

export function registerEcs(program: Command, resolve: () => Promise<ResolvedProject>): void {
    const ecs = program.command('ecs').description('the project\'s ECS kit, read from its sources');

    ecs.command('census')
        .description('per-component-key read/write/add/remove sweep of the kit')
        .option('--kit <path>', `directory to sweep: a ${DEFAULT_KIT} url or a path`, DEFAULT_KIT)
        .option('--json', 'print the structural form instead of text')
        .action(async (options: { kit: string; json?: boolean }) => {
            await withProject(
                resolve,
                async hello => ecsCensus({ projectPath: hello.projectPath, kit: options.kit }),
                { json: options.json });
        });
}
