import Table from 'cli-table3';
import type { Hello } from '@cocos-cli/shared';

export function renderInstances(instances: Hello[]): string {
    if (!instances.length) return 'no open Cocos editor found';
    const table = new Table({ head: ['project', 'path', 'pid'] });
    for (const hello of instances) table.push([hello.project, hello.projectPath, String(hello.pid)]);
    return table.toString();
}
