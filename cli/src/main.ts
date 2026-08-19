import { Command } from 'commander';
import { discover, probeAddress } from './discovery';
import { renderInstances } from './render/instances';
import { resolveClient } from './resolve';
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

    return program;
}

if (require.main === module) {
    buildProgram().parseAsync(process.argv).catch((error: any) => {
        const code = typeof error?.code === 'string' ? error.code : '';
        if (code.startsWith('commander.')) {
            process.exitCode = error.exitCode === 0 ? EXIT.OK : EXIT.USAGE;
            return;
        }
        process.stderr.write(String(error?.message || error) + '\n');
        process.exitCode = EXIT.PROTOCOL;
    });
}
