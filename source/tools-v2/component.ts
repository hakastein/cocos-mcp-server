import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail, ToolFail, ToolResult } from '../result';
import { anyValued, fromScene, textOf } from './shared';
import { settle } from '../settle';
import { coerceJsonArg } from '../json-arg';
import { PropertyDescriptor, isArrayDescriptor, resolveKind } from '../property/kind';
import { projectDescriptor } from '../property/readers';
import { readBack, WriteTarget } from '../property/writers';
import { verifiedWrite, VerifiedWriteOptions } from '../property/verified-write';
import { readAssetText } from '../asset-json';
import { dumpPrefabTree } from '../prefab-json';
import { verdictForCid, scriptCidsInAssetText } from '../missing-scripts';
import type { RegisteredTool } from '../tool';
import type { ToolContext } from '../context';
import type { WriteReport, MissingScriptDump } from '../scene-contract';
import type { MissingVerdict, ScriptCidVerdict } from '../missing-scripts';
import type { PrefabDumpNode } from '../prefab-json';

export interface DumpComponent {
    __type__?: string;
    cid?: string;
    type?: string;
    enabled?: boolean;
    value?: Record<string, PropertyDescriptor>;
    [key: string]: unknown;
}

export function classNameOf(component: DumpComponent | undefined): string | null {
    const named = (component?.value as any)?.name?.value ?? (component as any)?.name?.value;
    const match = typeof named === 'string' ? named.match(/<([^>]+)>\s*$/) : null;
    return match ? match[1] : null;
}

export function cidOf(component: DumpComponent | undefined): string {
    return component?.__type__ || component?.cid || component?.type || 'Unknown';
}

export function componentMatches(component: DumpComponent, componentType: string): boolean {
    if (!componentType) return false;
    const ids = [component.type, component.__type__, component.cid];
    if (ids.indexOf(componentType) !== -1) return true;
    const className = classNameOf(component);
    return !!className && (className === componentType || `cc.${className}` === componentType);
}

/** A custom script is registered under a cid, which no engine-side lookup accepts. */
export function canonicalClassName(component: DumpComponent): string {
    const declared = cidOf(component);
    if (declared.indexOf('cc.') === 0) return declared;
    return classNameOf(component) || declared;
}

export function resolveDumpPath(
    properties: Record<string, PropertyDescriptor> | undefined, path: string
): PropertyDescriptor | undefined {
    const segments = path.split('.');
    let current: any = properties ? (properties as any)[segments[0]] : undefined;
    for (let index = 1; index < segments.length && current !== undefined && current !== null; index++) {
        current = current.value ? current.value[segments[index]] : undefined;
    }
    return current === undefined || current === null ? undefined : current;
}

export function propertyFilterOf(filter: unknown): string[] | null {
    const raw = coerceJsonArg(filter).value;
    const list = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw.trim() ? [raw] : null);
    if (!list) return null;
    const paths = list.map((entry: unknown) => String(entry).trim()).filter(Boolean);
    return paths.length ? paths : null;
}

const PLAIN: string[] = [];
const ASSET: string[] = ['cc.Asset'];
Object.freeze(PLAIN);
Object.freeze(ASSET);

const ASSET_HINTS: Record<string, string> = {
    asset: 'cc.Asset', prefab: 'cc.Prefab', spriteFrame: 'cc.SpriteFrame'
};

const HINTS: Record<string, PropertyDescriptor> = {
    string: { type: 'String', extends: PLAIN },
    'cc.String': { type: 'String', extends: PLAIN },
    number: { type: 'Number', extends: PLAIN },
    integer: { type: 'Number', extends: PLAIN },
    float: { type: 'Number', extends: PLAIN },
    boolean: { type: 'Boolean', extends: PLAIN },
    'cc.Boolean': { type: 'Boolean', extends: PLAIN },
    enum: { type: 'Enum', extends: PLAIN },
    color: { type: 'cc.Color', extends: PLAIN },
    'cc.Color': { type: 'cc.Color', extends: PLAIN },
    vec2: { type: 'cc.Vec2', extends: PLAIN },
    'cc.Vec2': { type: 'cc.Vec2', extends: PLAIN },
    vec3: { type: 'cc.Vec3', extends: PLAIN },
    'cc.Vec3': { type: 'cc.Vec3', extends: PLAIN },
    vec4: { type: 'cc.Vec4', extends: PLAIN },
    'cc.Vec4': { type: 'cc.Vec4', extends: PLAIN },
    size: { type: 'cc.Size', extends: PLAIN },
    'cc.Size': { type: 'cc.Size', extends: PLAIN },
    gradient: { type: 'cc.GradientRange', extends: PLAIN },
    curve: { type: 'cc.CurveRange', extends: PLAIN },
    node: { type: 'cc.Node', extends: PLAIN },
    'cc.Node': { type: 'cc.Node', extends: PLAIN },
    component: { type: 'cc.Component', extends: ['cc.Component'] },
    'cc.Component': { type: 'cc.Component', extends: ['cc.Component'] },
    nodeArray: { isArray: true, type: 'cc.Node', elementTypeData: { type: 'cc.Node', extends: PLAIN } },
    colorArray: { isArray: true, type: 'cc.Color', elementTypeData: { type: 'cc.Color', extends: PLAIN } },
    numberArray: { isArray: true, type: 'Number', elementTypeData: { type: 'Number', extends: PLAIN } },
    stringArray: { isArray: true, type: 'String', elementTypeData: { type: 'String', extends: PLAIN } }
};

export function hintedDescriptor(
    descriptor: PropertyDescriptor | undefined, propertyType?: string
): PropertyDescriptor | undefined {
    const hint = (propertyType || '').trim();
    if (!hint) return descriptor;
    const override = HINTS[hint];
    if (override) return { ...(descriptor || {}), ...override };

    const named = ASSET_HINTS[hint] || (hint.indexOf('cc.') === 0 ? hint : undefined);
    if (named === undefined) return descriptor || { type: hint };
    // The hint says only "this is an asset"; the concrete class is the dump's when it has one,
    // and it is what the editor set-property call is typed with.
    return { ...(descriptor || {}), extends: ASSET, type: descriptor?.type || named };
}

/** JSON-looking text in a field DECLARED String is authored content, not a stringified object. */
export function coerceValueArg(raw: unknown, descriptor?: PropertyDescriptor | null): unknown {
    if (typeof raw !== 'string') return raw;
    if (descriptor && descriptor.type === 'String' && !isArrayDescriptor(descriptor)) return raw;
    return coerceJsonArg(raw).value;
}

export function valueFromArgs(args: Record<string, unknown>): { value: unknown } | { error: string } {
    if (args.clear === true) return { value: null };
    if (args.targetUuids !== undefined) return { value: args.targetUuids };
    if (args.targetUuid !== undefined) return { value: args.targetUuid };
    if ('value' in args && args.value !== undefined) return { value: args.value };
    return {
        error: 'no value was given: pass `value`, or `targetUuid`/`targetUuids` for a reference field, '
            + 'or `clear: true` to empty it'
    };
}

interface LocatedComponent {
    index: number;
    component: DumpComponent;
    cid: string;
    className: string;
    componentUuid: string | null;
    properties: Record<string, PropertyDescriptor>;
}

function componentsOf(raw: unknown): DumpComponent[] {
    return ((raw as any)?.__comps__ || []) as DumpComponent[];
}

export function matchesOf(components: DumpComponent[], componentType: string): number[] {
    const found: number[] = [];
    components.forEach((component, index) => {
        if (componentMatches(component, componentType)) found.push(index);
    });
    return found;
}

/**
 * `sameClassIndex` counts components of the SAME class, the index space
 * `resolveComponentReference` uses; the position it lands on is the one every read and every
 * write path here then addresses.
 */
function locate(
    components: DumpComponent[], componentType: string, sameClassIndex = 0
): LocatedComponent | null {
    const index = matchesOf(components, componentType)[sameClassIndex];
    if (index === undefined) return null;
    const component = components[index];
    return {
        index,
        component,
        cid: cidOf(component),
        className: canonicalClassName(component),
        componentUuid: (component.value as any)?.uuid?.value ?? null,
        properties: (component.value || {}) as Record<string, PropertyDescriptor>
    };
}

function componentMiss(
    components: DumpComponent[], nodeUuid: string, componentType: string, sameClassIndex?: number
): string {
    const found = matchesOf(components, componentType).length;
    if (sameClassIndex !== undefined && found > 0) {
        return `Node ${nodeUuid} carries ${found} '${componentType}' component(s), so there is none at `
            + `componentIndex ${sameClassIndex} — that index counts components of the SAME class, from 0`;
    }
    return `No '${componentType}' on node ${nodeUuid}. Components there: ${spelledTypes(components)}`;
}

function spelledTypes(components: DumpComponent[]): string {
    return components
        .map(component => {
            const className = classNameOf(component);
            return className ? `${className} (${cidOf(component)})` : cidOf(component);
        })
        .join(', ') || '(none)';
}

function enabledOf(component: DumpComponent): boolean {
    const declared = (component.value as any)?.enabled?.value;
    if (typeof declared === 'boolean') return declared;
    return component.enabled === undefined ? true : component.enabled;
}

function describeProperty(descriptor: PropertyDescriptor): Record<string, unknown> {
    const described: Record<string, unknown> = {
        type: descriptor.type,
        kind: resolveKind(descriptor),
        value: projectDescriptor(descriptor)
    };
    if (isArrayDescriptor(descriptor)) described.isArray = true;
    const options = descriptor.enumList || descriptor.bitmaskList;
    if (Array.isArray(options) && options.length) described.options = options;
    return described;
}

function projectAll(properties: Record<string, PropertyDescriptor>): Record<string, unknown> {
    const projected: Record<string, unknown> = {};
    for (const [name, descriptor] of Object.entries(properties)) {
        projected[name] = projectDescriptor(descriptor);
    }
    return projected;
}

function pickProperties(
    properties: Record<string, PropertyDescriptor>, paths: string[]
): Record<string, unknown> {
    const picked: Record<string, unknown> = {};
    for (const path of paths) {
        const descriptor = resolveDumpPath(properties, path);
        picked[path] = descriptor
            ? describeProperty(descriptor)
            : {
                error: `'${path}' is not present in this component's dump`,
                availableProperties: Object.keys(properties)
            };
    }
    return picked;
}

function describeAll(properties: Record<string, PropertyDescriptor>): Record<string, unknown> {
    const described: Record<string, unknown> = {};
    for (const [name, descriptor] of Object.entries(properties)) {
        described[name] = describeProperty(descriptor);
    }
    return described;
}

async function queryComponents(ctx: ToolContext, nodeUuid: string): Promise<DumpComponent[]> {
    return componentsOf(await ctx.editor.scene.queryNode(nodeUuid));
}

export interface ComponentInfoReport {
    nodeUuid: string;
    componentType: string;
    componentIndex: number;
    resolvedCid: string;
    className: string;
    componentUuid: string | null;
    enabled: boolean;
    requestedProperties?: string[];
    properties: Record<string, unknown>;
}

export async function readComponentInfo(
    ctx: ToolContext, nodeUuid: string, componentType: string, wanted?: string[] | null,
    sameClassIndex?: number
): Promise<ToolResult<ComponentInfoReport>> {
    let components: DumpComponent[];
    try {
        components = await queryComponents(ctx, nodeUuid);
    } catch (error) {
        return fail('node_unreadable', `The editor did not answer for node ${nodeUuid}: ${textOf(error)}`);
    }
    const located = locate(components, componentType, sameClassIndex || 0);
    if (!located) {
        return fail('component_not_found',
            componentMiss(components, nodeUuid, componentType, sameClassIndex),
            'Pass a cid, an @ccclass class name or a builtin type; component_get_components lists both.');
    }
    return ok({
        nodeUuid,
        componentType,
        componentIndex: located.index,
        resolvedCid: located.cid,
        className: classNameOf(located.component) || located.className,
        componentUuid: located.componentUuid,
        enabled: enabledOf(located.component),
        ...(wanted ? { requestedProperties: wanted } : {}),
        properties: wanted ? pickProperties(located.properties, wanted) : describeAll(located.properties)
    });
}

export interface PersistenceVerdict {
    failed: boolean;
    note?: string;
}

export function persistenceVerdict(report: Pick<WriteReport, 'persisted' | 'channel'>): PersistenceVerdict {
    if (report.persisted === true) return { failed: false };
    if (report.persisted === null) {
        return { failed: false, note: 'whether a save carries it was NOT established' };
    }
    if (report.channel === 'live') {
        return { failed: false, note: 'assigned on the live object, which the editor does not record' };
    }
    return { failed: true };
}

export interface PropertyWriteArgs {
    nodeUuid: string;
    componentType: string;
    property: string;
    value: unknown;
    propertyType?: string;
    targetComponentType?: string;
    sameClassIndex?: number;
    verify?: VerifiedWriteOptions['verify'];
}

const NODE_OWN_PROPERTIES = ['name', 'active', 'layer', 'mobility', 'parent', 'children', 'hideFlags'];
const NODE_TRANSFORM_PROPERTIES = ['position', 'rotation', 'scale', 'eulerAngles', 'angle'];

function nodePropertyRedirect(componentType: string, property: string): ToolFail | null {
    if (componentType !== 'cc.Node' && componentType !== 'Node') return null;
    if (NODE_TRANSFORM_PROPERTIES.indexOf(property) !== -1) {
        return fail('node_property', `'${property}' belongs to the node, not to a component`,
            `Use node_set_node_transform(uuid, ${property}: …) — it also knows what a 2D node may carry.`);
    }
    if (NODE_OWN_PROPERTIES.indexOf(property) !== -1) {
        return fail('node_property', `'${property}' belongs to the node, not to a component`,
            `Use node_set_node_property(uuid, property: '${property}', value: …).`);
    }
    return null;
}

/** Renderers expose no scalar `material`; the Inspector edits the sharedMaterials slots. */
function effectiveProperty(properties: Record<string, PropertyDescriptor>, property: string): string {
    if (resolveDumpPath(properties, property) !== undefined) return property;
    const aliased = property === 'material' || property === 'materials';
    return aliased && properties.sharedMaterials ? 'sharedMaterials' : property;
}

export async function writeComponentProperty(
    ctx: ToolContext, args: PropertyWriteArgs
): Promise<ToolResult<Record<string, unknown>>> {
    const redirect = nodePropertyRedirect(args.componentType, args.property);
    if (redirect) return redirect;

    let raw: unknown;
    try {
        raw = await ctx.editor.scene.queryNode(args.nodeUuid);
    } catch (error) {
        return fail('node_unreadable', `The editor did not answer for node ${args.nodeUuid}: ${textOf(error)}`);
    }
    const components = componentsOf(raw);
    const located = locate(components, args.componentType, args.sameClassIndex || 0);
    if (!located) {
        return fail('component_not_found',
            componentMiss(components, args.nodeUuid, args.componentType, args.sameClassIndex),
            'Add it with component_add_component, or pass one of the spellings above.');
    }

    const propertyPath = effectiveProperty(located.properties, args.property);
    const descriptor = hintedDescriptor(resolveDumpPath(located.properties, propertyPath), args.propertyType);
    if (!descriptor) {
        return fail('property_not_in_dump',
            `'${args.property}' is not in ${located.className}'s dump and no propertyType was given, so its `
            + `shape is unknown. Declared properties: ${Object.keys(located.properties).join(', ')}`,
            args.property.indexOf('.') !== -1
                ? 'A dotted path only resolves through values that already exist — write the parent array or '
                    + 'block first, then address its members.'
                : 'Pass propertyType to write a property the dump does not expose (a settable getter, for one).');
    }

    const target: WriteTarget = {
        nodeUuid: args.nodeUuid,
        componentType: located.className,
        componentIndex: located.index,
        propertyPath,
        descriptor,
        ...((raw as any)?._prefabInstance ? { prefabInstanceRoot: args.nodeUuid } : {}),
        ...(args.targetComponentType !== undefined || args.sameClassIndex !== undefined
            ? {
                refOptions: {
                    ...(args.targetComponentType !== undefined ? { targetComponentType: args.targetComponentType } : {}),
                    ...(args.sameClassIndex !== undefined ? { sameClassIndex: args.sameClassIndex } : {})
                }
            }
            : {})
    };

    const value = coerceValueArg(args.value, descriptor);
    const report: WriteReport = await verifiedWrite(target, value, ctx, { verify: args.verify || 'serializer' });
    const observed = report.written && !report.verified
        ? await readBack(target, ctx).catch(() => undefined)
        : undefined;
    const named = `${located.className}.${propertyPath}`;
    const data = {
        nodeUuid: args.nodeUuid,
        componentType: located.className,
        componentIndex: located.index,
        property: propertyPath,
        ...(propertyPath === args.property ? {} : { requestedProperty: args.property }),
        kind: resolveKind(descriptor),
        requested: value,
        ...(observed === undefined ? {} : { actualValue: observed }),
        ...report
    };

    if (!report.written) {
        return fail('write_refused', `${named} was not written: ${report.detail}`, undefined, data);
    }
    if (!report.verified && observed !== undefined) {
        return fail('write_unverified', `${named} did not land as asked: ${report.detail}`, undefined, data);
    }
    const persistence = persistenceVerdict(report);
    if (persistence.failed) {
        return fail('write_not_persisted', `${named} was written but a save would not carry it: ${report.detail}`,
            'The value is on the live component only. A reference into a prefab instance needs a target '
            + 'override, and a property the serializer does not emit cannot be written from here at all.',
            data);
    }
    const notes = [
        report.verified ? '' : 'the dump does not expose it, so the write is unproven',
        persistence.note || ''
    ].filter(Boolean);
    return ok(data, `Set ${named}${notes.length ? ` (${notes.join('; ')})` : ''}`);
}

const jsonArrayArg = z.preprocess(value => coerceJsonArg(value).value, z.array(z.any()));
const uuidListArg = z.preprocess(
    value => {
        const coerced = coerceJsonArg(value).value;
        return typeof coerced === 'string' ? [coerced] : coerced;
    },
    z.array(z.string())
);

export const componentAddComponent = defineTool({
    name: 'component_add_component',
    description: 'Add a component to a node, idempotently: a node that already carries the type is reported '
        + 'as such and nothing is added twice. Pass a builtin type ("cc.Sprite"), an @ccclass name, or the '
        + 'db:// path of a script asset — a script is matched by its ASSET uuid, because a script component '
        + 'registers in the scene under a class-id (cid) and never under its class name, which is why '
        + 'checking for the name alone reported every script attachment as failed. The addition is polled '
        + 'until the scene shows it, and the cid it registered under comes back in `resolvedCid` — that is '
        + 'the spelling component_remove_component wants.',
    schema: z.object({
        nodeUuid: z.string().describe('Target node UUID'),
        componentType: z.string().describe('Component type (cc.Sprite), an @ccclass name (Locomotion), or a '
            + 'script asset path (db://assets/scripts/MyScript.ts)')
    }),
    aliases: { scriptPath: 'componentType', component: 'componentType', type: 'componentType' },
    async handler(args, ctx) {
        return args.componentType.indexOf('db://') === 0
            ? attachScript(ctx, args.nodeUuid, args.componentType)
            : addByType(ctx, args.nodeUuid, args.componentType);
    }
});

function addedReport(nodeUuid: string, componentType: string, component: DumpComponent, existing: boolean) {
    return {
        nodeUuid,
        componentType,
        resolvedCid: cidOf(component),
        className: classNameOf(component) || canonicalClassName(component),
        componentUuid: (component.value as any)?.uuid?.value ?? null,
        componentVerified: true,
        existing
    };
}

async function addByType(ctx: ToolContext, nodeUuid: string, componentType: string): Promise<ToolResult> {
    let before: DumpComponent[];
    try {
        before = await queryComponents(ctx, nodeUuid);
    } catch (error) {
        return fail('node_unreadable', `The editor did not answer for node ${nodeUuid}: ${textOf(error)}`);
    }
    const existing = before.find(component => componentMatches(component, componentType));
    if (existing) {
        return ok(addedReport(nodeUuid, componentType, existing, true),
            `'${componentType}' is already on the node (cid '${cidOf(existing)}')`);
    }
    const beforeCids = new Set(before.map(cidOf));

    try {
        await ctx.editor.scene.createComponent({ uuid: nodeUuid, component: componentType });
    } catch (error) {
        const fallback = await ctx.sceneScript.call('addComponentToNode', nodeUuid, componentType)
            .catch(() => null);
        if (!fallback || fallback.success !== true) {
            return fail('create_component_failed',
                `Neither the editor nor the scene script added '${componentType}': ${textOf(error)}`
                + `${fallback ? `; ${fallback.error}` : ''}`);
        }
    }

    let added: DumpComponent | undefined;
    await settle(async () => {
        const after = await queryComponents(ctx, nodeUuid).catch(() => [] as DumpComponent[]);
        const appeared = after.filter(component => !beforeCids.has(cidOf(component)));
        added = after.find(component => componentMatches(component, componentType))
            || (appeared.length === 1 ? appeared[0] : undefined);
        return !!added;
    });
    if (!added) {
        const after = await queryComponents(ctx, nodeUuid).catch(() => [] as DumpComponent[]);
        return fail('component_unverified',
            `'${componentType}' is not on node ${nodeUuid} after adding it. Components there: `
            + spelledTypes(after),
            'The editor accepted the call without registering the component — check the spelling, and that '
            + 'the script compiled.');
    }
    return ok(addedReport(nodeUuid, componentType, added, false),
        `'${componentType}' added (registered as cid '${cidOf(added)}')`);
}

function scriptAssetOf(component: DumpComponent): string | undefined {
    return (component.value as any)?.__scriptAsset?.value?.uuid;
}

async function attachScript(ctx: ToolContext, nodeUuid: string, scriptPath: string): Promise<ToolResult> {
    const scriptUuid = await ctx.editor.assetDb.queryUuid(scriptPath).catch(() => null)
        || (await ctx.editor.assetDb.queryAssetInfo(scriptPath).catch(() => null))?.uuid;
    if (!scriptUuid) {
        return fail('script_not_found', `No script asset at '${scriptPath}'`,
            'Pass the db:// path of a .ts/.js script, e.g. db://assets/scripts/MyScript.ts');
    }
    const scriptName = (scriptPath.split('/').pop() || scriptPath).replace(/\.(ts|js)$/, '');

    const carrying = (components: DumpComponent[]) =>
        components.find(component => scriptAssetOf(component) === scriptUuid);

    let before: DumpComponent[];
    try {
        before = await queryComponents(ctx, nodeUuid);
    } catch (error) {
        return fail('node_unreadable', `The editor did not answer for node ${nodeUuid}: ${textOf(error)}`);
    }
    const already = carrying(before);
    if (already) {
        return ok(
            { ...addedReport(nodeUuid, scriptName, already, true), scriptUuid, scriptPath },
            `Script '${scriptName}' is already attached (cid '${cidOf(already)}')`
        );
    }
    const beforeCids = new Set(before.map(cidOf));

    const create = (component: string) =>
        ctx.editor.scene.createComponent({ uuid: nodeUuid, component }).catch(() => undefined);
    let after: DumpComponent[] = before;
    let attached: DumpComponent | undefined;
    const look = async () => {
        after = await queryComponents(ctx, nodeUuid).catch(() => after);
        attached = carrying(after);
        return !!attached;
    };

    await create(scriptName);
    await settle(look);
    // The uuid retry runs only while the component count has NOT grown, or it doubles the script.
    if (!attached && after.length === before.length) {
        await create(scriptUuid);
        await settle(look);
    }
    if (!attached) {
        const appeared = after.filter(component => !beforeCids.has(cidOf(component)));
        if (appeared.length === 1) attached = appeared[0];
    }
    if (!attached) {
        return fail('attach_failed', `Script '${scriptName}' did not attach to node ${nodeUuid}`,
            'The class must be a compiled @ccclass cc.Component subclass and the project must have finished '
            + 'importing — check the editor console, then retry.');
    }
    return ok(
        { ...addedReport(nodeUuid, scriptName, attached, false), scriptUuid, scriptPath },
        `Script '${scriptName}' attached (registered as cid '${cidOf(attached)}')`
    );
}

export const componentRemoveComponent = defineTool({
    name: 'component_remove_component',
    description: 'Remove a component from a node. Addressed the same way as everywhere else — a cid, an '
        + '@ccclass name or a builtin type — and removed by the COMPONENT\'s own scene uuid, which is the '
        + 'only form 3.8 accepts for a script component. The removal is polled until the node stops '
        + 'reporting the cid, so a component the editor declined to remove is reported instead of being '
        + 'called a success. With several components of one class on the node, componentIndex picks which.',
    schema: z.object({
        nodeUuid: z.string().describe('Node UUID'),
        componentType: z.string().describe('Component cid, @ccclass class name or builtin type, e.g. '
            + '"cc.Sprite" or "9b4a7ueT9xD6aRE+AlOusy1"'),
        componentIndex: z.coerce.number().optional().describe('Which component of the SAME class to remove '
            + '(default 0). Counts only components of that class, not the position in the node\'s list.')
    }),
    aliases: { component: 'componentType', type: 'componentType' },
    async handler(args, ctx) {
        let components: DumpComponent[];
        try {
            components = await queryComponents(ctx, args.nodeUuid);
        } catch (error) {
            return fail('node_unreadable',
                `The editor did not answer for node ${args.nodeUuid}: ${textOf(error)}`);
        }
        const located = locate(components, args.componentType, args.componentIndex || 0);
        if (!located) {
            return fail('component_not_found',
                componentMiss(components, args.nodeUuid, args.componentType, args.componentIndex));
        }

        const payloads: Array<{ uuid: string; component?: string }> = [];
        if (located.componentUuid) payloads.push({ uuid: located.componentUuid });
        payloads.push({ uuid: args.nodeUuid, component: located.cid });

        // A sibling of the same class carries the same cid, so only the component's own uuid can
        // say whether THIS one went; without it, the count of that cid has to drop.
        const carried = components.filter(component => cidOf(component) === located.cid).length;
        const stillThere = async () => {
            const after = await queryComponents(ctx, args.nodeUuid).catch(() => components);
            if (located.componentUuid) {
                return after.some(component =>
                    (component.value as any)?.uuid?.value === located.componentUuid);
            }
            return after.filter(component => cidOf(component) === located.cid).length >= carried;
        };

        let refusal = '';
        for (const payload of payloads) {
            try {
                await ctx.editor.scene.removeComponent(payload);
            } catch (error) {
                refusal = textOf(error);
                continue;
            }
            if (await settle(async () => !(await stillThere()))) {
                return ok({
                    nodeUuid: args.nodeUuid,
                    componentType: args.componentType,
                    resolvedCid: located.cid,
                    componentUuid: located.componentUuid
                }, `'${args.componentType}' (cid '${located.cid}') removed`);
            }
        }
        return fail('remove_unverified',
            `'${args.componentType}' (cid '${located.cid}') is still on node ${args.nodeUuid} after removing it`
            + `${refusal ? `. Last refusal: ${refusal}` : ''}`);
    }
});

export const componentGetComponents = defineTool({
    name: 'component_get_components',
    description: 'Every component on a node: its class-id (`type`), readable `className`, own scene uuid, '
        + 'enabled flag and — unless you turn them off — its property VALUES, projected out of the editor '
        + 'dump (a reference reads as its uuid, a colour as rgba, an unset reference as null). This is the '
        + 'compact answer; component_get_component_info gives one component\'s declared types and enum '
        + 'options. `index` is the component\'s position in the node\'s own list. If the editor cannot '
        + 'answer, the reply falls back to the scene script, which reports each component as `type` and '
        + '`enabled` only — no className, no uuid, no properties; the message says so when that happens.',
    schema: z.object({
        nodeUuid: z.string().describe('Node UUID'),
        includeProperties: booleanArg.optional().describe('Include each component\'s property values '
            + '(default true); false gives just the identity of each component')
    }),
    async handler(args, ctx) {
        const includeProperties = args.includeProperties !== false;
        let components: DumpComponent[] | null = null;
        let refusal = '';
        try {
            const raw = await ctx.editor.scene.queryNode(args.nodeUuid);
            if (raw && (raw as any).__comps__) components = componentsOf(raw);
            else refusal = `the editor reports no components for node ${args.nodeUuid}`;
        } catch (error) {
            refusal = textOf(error);
        }

        if (components) {
            return ok({
                nodeUuid: args.nodeUuid,
                components: components.map((component, index) => ({
                    index,
                    type: cidOf(component),
                    className: classNameOf(component) || undefined,
                    uuid: (component.value as any)?.uuid?.value ?? null,
                    enabled: enabledOf(component),
                    ...(includeProperties
                        ? { properties: projectAll((component.value || {}) as Record<string, PropertyDescriptor>) }
                        : {})
                }))
            });
        }

        const fallback = await ctx.sceneScript.call('getNodeInfo', args.nodeUuid).catch(() => null);
        if (!fallback || fallback.success !== true) {
            return fail('components_unreadable',
                `Editor API failed (${refusal}); scene script failed (${fallback?.error || 'no answer'})`);
        }
        return ok(
            { nodeUuid: args.nodeUuid, components: fallback.data.components },
            'Read through the scene script, which reports each component\'s type and enabled flag only'
        );
    }
});

export const componentGetComponentInfo = defineTool({
    name: 'component_get_component_info',
    description: 'One component in detail: for every property its declared `type`, the `kind` this bridge '
        + 'writes it as (assetRef, nodeRef, componentRef, color, vec, enum, bitmask, nestedClass, '
        + 'classArray, gradient, curve, plain), its current `value` and, for an enum or bitmask, the '
        + '`options` the editor offers. Pass `properties` to fetch only the entries you asked about — a '
        + 'component with nested serializable arrays describes tens of KB otherwise. Dotted paths address '
        + 'nested fields and array indices, e.g. "waves.0.squads". Material slots are `sharedMaterials`.',
    schema: z.object({
        nodeUuid: z.string().describe('Node UUID'),
        componentType: z.string().describe('Component cid, @ccclass class name or builtin type'),
        properties: z.union([z.array(z.string()), z.string()]).optional()
            .describe('Return only these property entries; dotted paths allowed. Omit for the whole component.'),
        componentIndex: z.coerce.number().optional().describe('Which component of the SAME class to read '
            + '(default 0) — the same index component_set_component_property writes through')
    }),
    aliases: { component: 'componentType', type: 'componentType', property: 'properties' },
    async handler(args, ctx) {
        return readComponentInfo(ctx, args.nodeUuid, args.componentType,
            propertyFilterOf(args.properties), args.componentIndex);
    }
});

export const componentSetComponentProperty = anyValued(defineTool({
    name: 'component_set_component_property',
    description: 'Write ONE property of a component — this is the only property writer for a scene. The '
        + 'target\'s real shape comes from the component dump, so the same call writes primitives, '
        + 'colours and vectors, enums and bitmasks, asset / node / component REFERENCES and arrays of '
        + 'those, an inline serializable @ccclass, an ARRAY of a serializable @ccclass with references '
        + 'inside its elements, particle gradients and curves, and nested members addressed by a DOTTED '
        + 'PATH. An array is written whole: to add or remove an element, read it, edit it, set it back. An '
        + 'inline @ccclass is the opposite — it PATCHES the members you name and leaves the rest alone, '
        + 'and a misspelled member is an error rather than a silent no-op. Material slots are '
        + '`sharedMaterials` (there is no scalar `material`); `material`/`materials` are accepted as '
        + 'spellings of it. For a reference field you may pass the target as `value`, or as '
        + '`targetUuid`/`targetUuids` — which also accept targetPath/targetPaths and survive a scene '
        + 'reload. THE WRITE LANDS IN THE OPEN SCENE, NOT IN THE FILE: `written` says the editor took it, '
        + '`verified` says the component reads it back, `channel` says which route took the value, and '
        + '`detail` says what is in doubt and why. `persisted` has THREE states: true — the editor\'s '
        + 'serializer, the call a save runs, emits the value; false — it does not; null — nobody could '
        + 'check (the prefab asset was unreadable, the serializer does not name the field, or verify was '
        + 'set to readback). A PROVEN false on the editor channel FAILS the call. null succeeds with the '
        + 'reason said out loud — an unproven write is not a bad one. A gradient, a curve, or a reference '
        + 'the editor channel refused goes through the live object instead and reports channel "live" with '
        + 'persisted false BY DESIGN: the value is real, the editor recorded nothing, so the person at the '
        + 'editor has to save. '
        + 'Node properties (name, active, layer, position, rotation, scale) belong to node_set_node_* .',
    schema: z.object({
        nodeUuid: z.string().describe('UUID of the node holding the component that OWNS the property'),
        componentType: z.string().describe('Component cid, @ccclass class name or builtin type, e.g. '
            + 'cc.Label or Locomotion. component_get_components lists both spellings.'),
        property: z.string().describe('Property name, or a DOTTED PATH into it: "fontSize", '
            + '"rateOverTime.constant", "colorOverLifetimeModule.color", "waves.0.squads"'),
        value: z.any().optional().describe('The value, in the shape the property declares: a number, a '
            + 'string, true/false, {"r":255,"g":0,"b":0,"a":255} or "#FF0000" for a colour, {"x":..,"y":..} '
            + 'for a vector, {"width":..,"height":..} for a size, a bare uuid for an asset / node / '
            + 'component reference, an array of those for an array field, [{"prefab":"<uuid>","count":3}] '
            + 'for an array of a serializable @ccclass, {"keyframes":[{"time":0,"value":1}],"mode":1} for a '
            + 'curve, {"colorKeys":[…],"alphaKeys":[…],"mode":1} for a gradient. null clears a scalar '
            + 'reference.'),
        propertyType: z.string().optional().describe('OPTIONAL type hint. The shape is read from the dump, '
            + 'so omit it and the value is typed correctly on its own; pass it to override the dump or to '
            + 'write a property the dump does not expose. Open-ended: the keywords string, number, integer, '
            + 'float, boolean, color, vec2, vec3, vec4, size, enum, node, component, asset, prefab, '
            + 'spriteFrame, gradient, curve, nodeArray, colorArray, numberArray, stringArray, or any cc.* '
            + 'class name.'),
        targetUuid: z.string().optional().describe('For a REFERENCE property: the node or component uuid to '
            + 'assign, instead of `value`'),
        targetUuids: uuidListArg.optional().describe('For an ARRAY of references: the uuids to assign, '
            + 'instead of `value`'),
        targetComponentType: z.string().optional().describe('Assign THIS component of the target node '
            + 'rather than the node itself, or rather than the component the field\'s declared type implies'),
        componentIndex: z.coerce.number().optional().describe('Which component of the SAME class on the '
            + 'owning node holds the field (default 0) — this is an index among same-class components, not '
            + 'the position in the node\'s component list'),
        clear: booleanArg.optional().describe('Empty the property instead of assigning: null for a scalar '
            + 'reference, [] for an array of references. An ARRAY OF ASSETS (sharedMaterials and the like) '
            + 'cannot be emptied or shortened here — the editor channel writes slots, never the array\'s '
            + 'length; assign the slots you want instead.'),
        verify: z.enum(['readback', 'disk', 'serializer']).optional().describe('How far to check the write: '
            + '"serializer" (default) compares against what a save would emit, "readback" reads the live '
            + 'component only, "disk" additionally says whether the open scene now differs from its file')
    }),
    async handler(args, ctx) {
        const chosen = valueFromArgs(args);
        if ('error' in chosen) {
            return fail('invalid_args', `component_set_component_property: ${chosen.error}`);
        }
        return writeComponentProperty(ctx, {
            nodeUuid: args.nodeUuid,
            componentType: args.componentType,
            property: args.property,
            value: chosen.value,
            propertyType: args.propertyType,
            targetComponentType: args.targetComponentType,
            sameClassIndex: args.componentIndex,
            verify: args.verify
        });
    }
}), 'value');

export const componentExecuteComponentMethod = defineTool({
    name: 'component_execute_component_method',
    description: 'Call a method on a live component in the open scene. `uuid` is the COMPONENT\'s own scene '
        + 'uuid (component_get_components reports it as `uuid`), not the node\'s. The call runs against the '
        + 'live object, so whatever it changes is an unrecorded scene change like any other engine-side '
        + 'write.',
    schema: z.object({
        uuid: z.string().describe('Component UUID'),
        name: z.string().describe('Method name'),
        args: jsonArrayArg.optional().describe('Method arguments, in order')
    }),
    aliases: { method: 'name', componentUuid: 'uuid' },
    async handler(args, ctx) {
        try {
            const result = await ctx.editor.scene.executeComponentMethod({
                uuid: args.uuid, name: args.name, args: args.args || []
            });
            return ok({ uuid: args.uuid, method: args.name, result }, `Method '${args.name}' executed`);
        } catch (error) {
            return fail('method_failed', `'${args.name}' did not run on component ${args.uuid}: `
                + textOf(error));
        }
    }
});

export interface MissingFinding {
    where: 'scene' | 'prefab';
    location: string;
    nodePath: string;
    cid: string;
    scriptUuid: string | null;
    verdict: MissingVerdict;
    reason: string;
    removed: boolean;
    componentUuid?: string;
    nodeUuid?: string;
    mounted?: boolean;
}

/** queryAssetInfo throws on a dropped request, not just on a missing asset — catch that as null, not false. */
function assetExistenceCache(ctx: ToolContext): (uuid: string) => Promise<boolean | null> {
    const answered = new Map<string, Promise<boolean | null>>();
    return (uuid: string) => {
        const known = answered.get(uuid);
        if (known) return known;
        const asked = ctx.editor.assetDb.queryAssetInfo(uuid)
            .then(info => !!info)
            .catch(() => null);
        answered.set(uuid, asked);
        return asked;
    };
}

async function judge(
    cid: string,
    exists: (uuid: string) => Promise<boolean | null>
): Promise<ScriptCidVerdict> {
    const shape = verdictForCid(cid, null);
    if (!shape.scriptUuid) return shape;
    return verdictForCid(cid, await exists(shape.scriptUuid));
}

async function sceneFindings(
    ctx: ToolContext,
    exists: (uuid: string) => Promise<boolean | null>,
    rootUuid?: string,
    recursive?: boolean
): Promise<{ findings: MissingFinding[] } | { failure: ToolFail }> {
    const answer = fromScene(
        await ctx.sceneScript.call('dumpMissingScripts', { rootUuid, recursive })
    );
    if (!answer.success) return { failure: answer as ToolFail };
    const dump = answer.data as MissingScriptDump;
    const findings: MissingFinding[] = [];
    for (const entry of dump.entries) {
        const verdict = entry.cid
            ? await judge(entry.cid, exists)
            : verdictForCid('<no serialized __type__>', null);
        findings.push({
            where: 'scene',
            location: entry.nodePath,
            nodePath: entry.nodePath,
            cid: verdict.cid,
            scriptUuid: verdict.scriptUuid,
            verdict: verdict.verdict,
            reason: verdict.reason,
            removed: false,
            componentUuid: entry.componentUuid,
            nodeUuid: entry.nodeUuid
        });
    }
    return { findings };
}

const MOUNTED_NODE_PATH = '(mounted onto a nested prefab instance — this file names no node for it)';

/** `ref.__id__` here indexes straight into `data`; dumpPrefabTree never reaches these, only node._components. */
function mountedComponentCids(data: any[]): string[] {
    const found: string[] = [];
    for (const entry of data) {
        if (!entry || entry.__type__ !== 'cc.MountedComponentsInfo') continue;
        for (const ref of entry.components || []) {
            const component = typeof ref?.__id__ === 'number' ? data[ref.__id__] : undefined;
            if (component && typeof component.__type__ === 'string') found.push(component.__type__);
        }
    }
    return found;
}

function pushFinding(
    findings: MissingFinding[], prefabPath: string, nodePath: string, verdict: ScriptCidVerdict, mounted: boolean
): void {
    if (verdict.verdict === 'script_exists') return;
    if (verdict.verdict === 'unverifiable' && !verdict.scriptUuid) return;
    findings.push({
        where: 'prefab',
        location: prefabPath,
        nodePath,
        cid: verdict.cid,
        scriptUuid: verdict.scriptUuid,
        verdict: verdict.verdict,
        reason: verdict.reason,
        removed: false,
        ...(mounted ? { mounted: true } : {})
    });
}

/**
 * Findings read straight out of a prefab FILE, so a report costs no scene switch. The apply pass
 * re-derives them from the live graph after opening the prefab, which is what actually gets removed.
 */
async function prefabFindings(
    prefabPath: string,
    exists: (uuid: string) => Promise<boolean | null>
): Promise<{ findings: MissingFinding[] } | { failure: ToolFail }> {
    let data: any;
    try {
        data = JSON.parse(await readAssetText(prefabPath));
    } catch (error) {
        return { failure: fail('prefab_unreadable', `${prefabPath}: ${textOf(error)}`) };
    }
    if (!Array.isArray(data)) {
        return { failure: fail('prefab_unreadable', `${prefabPath} is not a prefab array`) };
    }
    let nodes: PrefabDumpNode[];
    try {
        nodes = dumpPrefabTree(data);
    } catch (error) {
        return { failure: fail('prefab_unreadable', `${prefabPath}: ${textOf(error)}`) };
    }
    const findings: MissingFinding[] = [];
    for (const node of nodes) {
        for (const component of node.components) {
            const verdict = await judge(component.type, exists);
            pushFinding(findings, prefabPath, node.path, verdict, false);
        }
    }
    for (const cid of mountedComponentCids(data)) {
        const verdict = await judge(cid, exists);
        pushFinding(findings, prefabPath, MOUNTED_NODE_PATH, verdict, true);
    }
    return { findings };
}

function summarise(findings: MissingFinding[]) {
    const missing = findings.filter(f => f.verdict === 'missing');
    const refused = findings.filter(f => f.verdict !== 'missing');
    const unloaded = findings.filter(f => f.verdict === 'script_exists');
    return {
        scanned: findings.length,
        missing: missing.length,
        removed: findings.filter(f => f.removed).length,
        refused: refused.length,
        ...(unloaded.length
            ? {
                compileWarning: `${unloaded.length} component(s) reference scripts that ARE still in the `
                    + 'asset database — that is what a compile error looks like. None of them were touched.'
            }
            : {})
    };
}

/**
 * Opening a prefab loads its whole dependency tree, so the project-wide sweep only opens the ones
 * whose file already names a script asset the database does not have. Same funnel as the verdict,
 * same cache — the file is read, never judged on its own.
 */
async function targetPrefabs(
    ctx: ToolContext,
    explicit: string | undefined,
    exists: (uuid: string) => Promise<boolean | null>
): Promise<string[]> {
    if (explicit) return [explicit];
    const assets = await ctx.editor.assetDb.queryAssets({ pattern: 'db://assets/**/*.prefab' });
    const candidates: string[] = [];
    for (const asset of assets) {
        let text: string;
        try {
            text = await readAssetText(asset.url);
        } catch {
            continue;
        }
        for (const cid of scriptCidsInAssetText(text)) {
            const verdict = await judge(cid, exists);
            if (verdict.verdict === 'missing' || verdict.verdict === 'unverifiable') {
                candidates.push(asset.url);
                break;
            }
        }
    }
    return candidates;
}

async function applyRemovals(
    _ctx: ToolContext,
    _args: { nodeUuid?: string; prefabPath?: string; recursive?: boolean },
    _findings: MissingFinding[],
    _exists: (uuid: string) => Promise<boolean | null>
): Promise<ToolResult> {
    return fail('not_implemented', 'apply is not wired yet');
}

export const componentRemoveMissingScripts = defineTool({
    name: 'component_remove_missing_scripts',
    description: 'Remove components whose script was DELETED from the project. A component with an '
        + 'unresolvable type deserializes as cc.MissingScript, which is also what a compile error does '
        + 'to EVERY script at once — so the class id (a user script\'s id is its .ts uuid, packed) is '
        + 'resolved against the asset database, and only a component whose script asset is genuinely '
        + 'absent is removed. Anything unproven is reported and left alone. Address one scene node '
        + '(its subtree unless recursive:false), one .prefab asset, or pass nothing for the open scene '
        + 'plus every prefab in the project. apply defaults to false: the bare call is a report that '
        + 'touches nothing. Applying opens each prefab as a scene, removes through the editor and '
        + 'saves it, then returns to the scene that was open and does the scene last WITHOUT saving — '
        + 'so the prefabs are on disk and the scene edits are yours to save. Ctrl+Z does NOT bring a '
        + 'removed missing script back; git is the net for prefabs.',
    schema: z.object({
        nodeUuid: z.string().optional().describe('Scene node to clean; its subtree is included'),
        recursive: booleanArg.optional().describe('Include the node\'s subtree (default true)'),
        prefabPath: z.string().optional().describe('A .prefab asset to clean, e.g. db://assets/x/Y.prefab'),
        apply: booleanArg.optional().describe('Actually remove (default false — report only)')
    }),
    aliases: { assetPath: 'prefabPath', prefab: 'prefabPath' },
    async handler(args, ctx) {
        if (args.nodeUuid && args.prefabPath) {
            return fail('invalid_args', 'Pass a node or a prefabPath, not both — they are different targets.');
        }
        if (!(await ctx.editor.assetDb.queryReady().catch(() => false))) {
            return fail('asset_db_not_ready',
                'The asset database has not finished starting up. Every script would read as absent right now.');
        }
        const exists = assetExistenceCache(ctx);
        const findings: MissingFinding[] = [];
        const unreadablePrefabs: Array<{ path: string; reason: string }> = [];

        if (!args.prefabPath) {
            const scene = await sceneFindings(ctx, exists, args.nodeUuid, args.recursive);
            if ('failure' in scene) return scene.failure;
            findings.push(...scene.findings);
        }
        if (!args.nodeUuid) {
            for (const path of await targetPrefabs(ctx, args.prefabPath, exists)) {
                const prefab = await prefabFindings(path, exists);
                if ('failure' in prefab) {
                    // A path the SWEEP discovered is skipped and reported; a path the caller NAMED
                    // is the whole ask, so failing it silently would report "clean" on nothing seen.
                    if (args.prefabPath) return prefab.failure;
                    unreadablePrefabs.push({ path, reason: prefab.failure.error.message });
                    continue;
                }
                findings.push(...prefab.findings);
            }
        }

        if (args.apply !== true) {
            const summary = summarise(findings);
            const skipNote = unreadablePrefabs.length
                ? `; ${unreadablePrefabs.length} prefab(s) could not be read and were skipped`
                : '';
            return ok({ applied: false, ...summary, unreadablePrefabs, findings },
                `${summary.missing} removable missing script(s); nothing was changed${skipNote}`);
        }
        return applyRemovals(ctx, args, findings, exists);
    }
});

export const componentTools: RegisteredTool[] = [
    componentAddComponent,
    componentRemoveComponent,
    componentGetComponents,
    componentGetComponentInfo,
    componentSetComponentProperty,
    componentExecuteComponentMethod,
    componentRemoveMissingScripts
];
