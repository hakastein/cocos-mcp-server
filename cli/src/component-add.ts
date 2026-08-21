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

async function componentNamesNow(client: Driver, nodeUuid: string): Promise<string[]> {
    return componentClassNames(await queryComponents(client, nodeUuid));
}

/**
 * Every type in `after` a running count from `before` cannot account for. A growing multiset rather
 * than a set difference, because a node can already carry several components of the same type — the
 * only way to tell an old instance from the one just added is by count.
 */
function newlyAppearedTypes(before: string[], after: string[]): string[] {
    const remaining = new Map<string, number>();
    for (const type of before) remaining.set(type, (remaining.get(type) || 0) + 1);
    const appeared: string[] = [];
    for (const type of after) {
        const left = remaining.get(type) || 0;
        if (left > 0) { remaining.set(type, left - 1); continue; }
        appeared.push(type);
    }
    return appeared;
}

export interface PollOptions {
    timeoutMs?: number;
    intervalMs?: number;
}

interface Appearance {
    matched: string | null;
    appeared: string[];
}

/**
 * A class declaring a requirement makes the editor attach that requirement AHEAD of it, so the
 * first component to appear is not the one that was asked for. The wait therefore runs until a
 * spelling of the asked-for type appears, and what else the node gained comes back with it.
 */
async function pollForNewComponent(
    client: Driver, nodeUuid: string, before: string[], spellings: string[], pollOptions?: PollOptions
): Promise<Appearance> {
    let appeared: string[] = [];
    await settle(async () => {
        appeared = newlyAppearedTypes(before, await componentNamesNow(client, nodeUuid));
        return appeared.some(type => spellings.includes(type));
    }, pollOptions);
    return { matched: appeared.find(type => spellings.includes(type)) || null, appeared };
}

/** An add whose component was read back: `type` is the name it actually registered under. */
export interface ComponentRegistered {
    verified: true;
    type: string;
    alreadyPresent: boolean;
}

/**
 * The node gained several components and no spelling of the type asked for names any of them, so
 * every registered name on offer is a guess — which is the choice this outcome refuses to make.
 */
export interface ComponentUnverified {
    verified: false;
    spellings: string[];
    appeared: string[];
}

export type ComponentAddOutcome = ComponentRegistered | ComponentUnverified;

/** What an add with no registered name to report says in place of naming one. */
export function unverifiedAddNote(outcome: ComponentUnverified): string {
    return `the node gained ${outcome.appeared.join(', ')}`
        + `, nothing named ${outcome.spellings.join(' or ')}`;
}

/**
 * A spelling of the type asked for names the component; failing that, a single new component is the
 * one the add produced and there is nothing to choose between.
 */
function outcomeOf(spellings: string[], seen: Appearance): ComponentAddOutcome {
    const named = seen.matched || (seen.appeared.length === 1 ? seen.appeared[0] : null);
    if (named) return { verified: true, type: named, alreadyPresent: false };
    return { verified: false, spellings, appeared: seen.appeared };
}

/** Neither add path is trusted on its own word — each spelling is tried, then polled for. Shared by
 * `component add` and `node create --component` so success and failure both take one shape. */
export async function addComponent(
    client: Driver, nodeUuid: string, type: string, pollOptions?: PollOptions
): Promise<ComponentAddOutcome> {
    const components = await queryComponents(client, nodeUuid);
    const present = selectComponent(components, type);
    if (present) return { verified: true, type: present.className, alreadyPresent: true };
    const before = componentClassNames(components);
    const spellings = spellingCandidates(type);

    for (const candidate of spellings) {
        await client.editor.scene.createComponent({ uuid: nodeUuid, component: candidate }).catch(() => undefined);
        let seen = await pollForNewComponent(client, nodeUuid, before, spellings, pollOptions);
        // Anything at all on the node is this add's doing; a further add would only pile up a copy.
        if (seen.appeared.length) return outcomeOf(spellings, seen);

        const fallback = await client.scene.call('addComponentToNode', nodeUuid, candidate);
        if (fallback.success) {
            seen = await pollForNewComponent(client, nodeUuid, before, spellings, pollOptions);
            if (seen.appeared.length) return outcomeOf(spellings, seen);
        }
    }

    const after = await componentNamesNow(client, nodeUuid);
    throw new Error(
        `component '${type}' did not appear on node ${nodeUuid} after the add; the node carries: ${
            after.join(', ') || '(none)'}`);
}
