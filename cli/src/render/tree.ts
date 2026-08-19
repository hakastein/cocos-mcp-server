import archy from 'archy';

export interface DumpNode {
    uuid: string;
    name: string;
    parentUuid: string;
    active: boolean;
    components?: { type: string }[];
}

export interface TreeOptions {
    uuid?: boolean;
}

export function renderTree(nodes: DumpNode[], options: TreeOptions = {}): string {
    const known = new Set(nodes.map(node => node.uuid));
    const children = new Map<string, DumpNode[]>();
    for (const node of nodes) {
        const list = children.get(node.parentUuid) || [];
        list.push(node);
        children.set(node.parentUuid, list);
    }

    const label = (node: DumpNode): string => {
        const types = (node.components || []).map(component => component.type).join(',');
        return node.name
            + (types ? `  [${types}]` : '')
            + (node.active ? '' : '  (off)')
            + (options.uuid ? `  ${node.uuid}` : '');
    };

    // Список приходит плоским и может содержать цикл, если сцена читалась во время правки;
    // посещённые узлы обрывают обход, чтобы рендер не ушёл в бесконечность.
    const seen = new Set<string>();
    const build = (node: DumpNode): archy.Data => {
        if (seen.has(node.uuid)) return { label: label(node), nodes: [] };
        seen.add(node.uuid);
        return { label: label(node), nodes: (children.get(node.uuid) || []).map(build) };
    };

    return nodes
        .filter(node => !known.has(node.parentUuid))
        .map(root => archy(build(root)))
        .join('')
        .replace(/\n+$/, '');
}
