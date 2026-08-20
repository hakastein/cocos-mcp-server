import { Command, CommanderError } from 'commander';
import { discover, probeAddress } from './discovery';
import { present } from './render/present';
import { emit } from './commands/shared';
import { resolveClient } from './resolve';
import { registerScene } from './commands/scene';
import { registerNode } from './commands/node';
import { registerComponent } from './commands/component';
import { registerPrefab } from './commands/prefab';
import { registerAsset } from './commands/asset';
import { EXIT } from './exit';

export function buildProgram(): Command {
    const program = new Command('cocos');
    program
        .description('drives open Cocos Creator editors')
        .option('-p, --project <substring>', 'which editor, when several are open')
        .exitOverride();

    program
        .command('instances')
        .description('list the open editors')
        .option('--json', 'print the structural form instead of text')
        .action(async (options: { json?: boolean }) => {
            const found = await discover(probeAddress);
            emit(present({ kind: 'instances', instances: found }, { json: options.json }));
            process.exitCode = found.length ? EXIT.OK : EXIT.NO_EDITOR;
        });

    registerScene(program, () => resolveClient(program.opts().project));
    registerNode(program, () => resolveClient(program.opts().project));
    registerComponent(program, () => resolveClient(program.opts().project));
    registerPrefab(program, () => resolveClient(program.opts().project));
    registerAsset(program, () => resolveClient(program.opts().project));

    return program;
}

if (require.main === module) {
    buildProgram().parseAsync(process.argv).catch((error: unknown) => {
        if (error instanceof CommanderError) {
            process.exitCode = error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
            return;
        }
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(message + '\n');
        process.exitCode = EXIT.PROTOCOL;
    });
}
