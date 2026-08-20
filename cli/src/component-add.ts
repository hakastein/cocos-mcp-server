import type { Driver } from '@cocos-cli/shared';
import { settle } from './settle.ts';
import { componentClassNames, selectComponent } from './property/component-dump.ts';
import type { ComponentDump } from './property/component-dump.ts';

const CC_PREFIX = 'cc.';

function bareComponentType(type: string): string {
    return type.indexOf(CC_PREFIX) === 0 ? type.slice(CC_PREFIX.length) : type;
}

/**
 * The editor's `create-component` message silently does nothing for the spelling it does not
 * register under, and the scene-side fallback throws `Component type not found` for the other —
 * so both spellings are tried, caller's own first.
 */
function spellingCandidates(type: string): string[] {
    const bare = bareComponentType(type);
    const prefixed = `${CC_PREFIX}${bare}`;
    return type === bare ? [bare, prefixed] : [prefixed, bare];
}

export async function queryComponents(client: Driver, nodeUuid: string): Promise<ComponentDump[]> {
    const node = await client.editor.scene.queryNode(nodeUuid);
    return ((node && node.__comps__) as ComponentDump[] | undefined) || [];
}

/** Registered class names — `cc.MeshRenderer`, `GameBootstrap` — the way every other subcommand
 * names a component. `getNodeInfo` would answer the bare JS class instead. */
async function componentNamesNow(client: Driver, nodeUuid: string): Promise<string[]> {
    return componentClassNames(await queryComponents(client, nodeUuid));
}

/**
 * The first type in `after` a running count from `before` cannot account for. A growing
 * multiset rather than a set difference, because a node can already carry several components of
 * the same type — the only way to tell an old instance from the one just added is by count.
 */
function newlyAppearedType(before: string[], after: string[]): string | null {
    const remaining = new Map<string, number>();
    for (const type of before) remaining.set(type, (remaining.get(type) || 0) + 1);
    for (const type of after) {
        const left = remaining.get(type) || 0;
        if (left > 0) { remaining.set(type, left - 1); continue; }
        return type;
    }
    return null;
}

export interface PollOptions {
    timeoutMs?: number;
    intervalMs?: number;
}

async function pollForNewComponent(
    client: Driver, nodeUuid: string, before: string[], pollOptions?: PollOptions
): Promise<string | null> {
    let found: string | null = null;
    await settle(async () => {
        found = newlyAppearedType(before, await componentNamesNow(client, nodeUuid));
        return found !== null;
    }, pollOptions);
    return found;
}

export interface ComponentAddOutcome {
    /** The name the component actually registered under — never the spelling the caller typed. */
    type: string;
    alreadyPresent: boolean;
}

/** Neither add path is trusted on its own word — each spelling is tried, then polled for. Shared by
 * `component add` and `node create --component` so success and failure both take one shape. */
export async function addComponent(
    client: Driver, nodeUuid: string, type: string, pollOptions?: PollOptions
): Promise<ComponentAddOutcome> {
    const components = await queryComponents(client, nodeUuid);
    const present = selectComponent(components, type);
    if (present) return { type: present.className, alreadyPresent: true };
    const before = componentClassNames(components);

    for (const candidate of spellingCandidates(type)) {
        await client.editor.scene.createComponent({ uuid: nodeUuid, component: candidate }).catch(() => undefined);
        let found = await pollForNewComponent(client, nodeUuid, before, pollOptions);
        if (found) return { type: found, alreadyPresent: false };

        const fallback = await client.scene.call('addComponentToNode', nodeUuid, candidate);
        if (fallback.success) {
            found = await pollForNewComponent(client, nodeUuid, before, pollOptions);
            if (found) return { type: found, alreadyPresent: false };
        }
    }

    const after = await componentNamesNow(client, nodeUuid);
    throw new Error(
        `component '${type}' did not appear on node ${nodeUuid} after the add; the node carries: ${
            after.join(', ') || '(none)'}`);
}
