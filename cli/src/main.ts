import { Command, CommanderError } from 'commander';
import { discover, probeAddress } from './discovery';
import { renderInstances } from './render/instances';
import { resolveClient } from './resolve';
import { registerScene } from './commands/scene';
import { EXIT } from './exit';

export function buildProgram(): Command {
    const program = new Command('cocos');
    program
        .description('Драйвер открытых редакторов Cocos Creator')
        .option('-p, --project <substring>', 'какой редактор, если открыто несколько')
        .option('--json', 'выдать структурную форму вместо текста')
        .exitOverride();

    program
        .command('instances')
        .description('перечислить открытые редакторы')
        .action(async () => {
            const found = await discover(probeAddress);
            if (program.opts().json) {
                process.stdout.write(JSON.stringify(found) + '\n');
            } else {
                process.stdout.write(renderInstances(found) + '\n');
            }
            process.exitCode = found.length ? EXIT.OK : EXIT.NO_EDITOR;
        });

    registerScene(program, () => resolveClient(program.opts().project));

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
