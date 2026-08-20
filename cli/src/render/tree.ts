import archy from 'archy';
import { siblingLabels } from '@cocos-cli/shared';

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

    // The address is printed rather than the name: `siblingLabels` is the same rule the path
    // resolver indexes by, so a line lifted off the tree is accepted as a path unedited.
    const roots = nodes.filter(node => !known.has(node.parentUuid));
    const addressed = new Map<DumpNode, string>();
    const address = (siblings: DumpNode[]): void => {
        siblingLabels(siblings).forEach((text, i) => addressed.set(siblings[i], text));
    };
    address(roots);
    for (const node of nodes) {
        const list = children.get(node.uuid);
        if (list) address(list);
    }

    const label = (node: DumpNode): string => {
        const types = (node.components || []).map(component => component.type).join(',');
        return (addressed.get(node) || node.name)
            + (types ? `  [${types}]` : '')
            + (node.active ? '' : '  (off)')
            + (options.uuid ? `  ${node.uuid}` : '');
    };

    // The list arrives flat and can hold a cycle when the scene was read while being edited;
    // visited nodes cut the walk short so the render does not run forever.
    const seen = new Set<string>();
    const build = (node: DumpNode): archy.Data => {
        if (seen.has(node.uuid)) return { label: label(node), nodes: [] };
        seen.add(node.uuid);
        return { label: label(node), nodes: (children.get(node.uuid) || []).map(build) };
    };

    return roots
        .map(root => archy(build(root)))
        .join('')
        .replace(/\n+$/, '');
}
