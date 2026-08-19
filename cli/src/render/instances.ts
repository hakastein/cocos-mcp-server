import Table from 'cli-table3';
import { Hello } from '@cocos-cli/shared';

export function renderInstances(instances: Hello[]): string {
    if (!instances.length) return 'ни одного открытого редактора Cocos не найдено';
    const table = new Table({ head: ['проект', 'путь', 'pid'] });
    for (const hello of instances) table.push([hello.project, hello.projectPath, String(hello.pid)]);
    return table.toString();
}
