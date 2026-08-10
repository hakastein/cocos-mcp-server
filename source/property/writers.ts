import { settle } from '../settle';
import {
    PropertyDescriptor, PropertyKind, isArrayDescriptor, isDumpDescriptor, resolveKind
} from './kind';
import { projectDescriptor, projectValue } from './readers';
import type { ToolContext } from '../context';
import type { WriteReport } from '../scene-contract';

export interface ReferenceOptions {
    targetComponentType?: string;
    /** Index among the node's components OF THE SAME CLASS — not the `__comps__` index. */
    sameClassIndex?: number;
}

export interface WriteTarget {
    nodeUuid: string;
    componentType: string;
    componentIndex: number;
    propertyPath: string;
    descriptor: PropertyDescriptor;
    prefabInstanceRoot?: string;
    refOptions?: ReferenceOptions;
}

export interface PropertyWriter {
    readonly name: string;
    readonly kind: PropertyKind;
    claims(target: WriteTarget, value: unknown): boolean;
    write(target: WriteTarget, value: unknown, ctx: ToolContext): Promise<WriteReport>;
}

export interface ReferenceStep {
    path: string;
    type: string;
    uuid: string;
}

export interface ClassElement {
    dump: { type?: string; value: Record<string, unknown> };
    refs: ReferenceStep[];
    expected: Record<string, unknown>;
}

export interface ClassPatch extends ClassElement {
    unknown: string[];
}

interface ChannelStep {
    path: string;
    dump: unknown;
}

interface ReadCheck {
    property: string;
    expected: unknown;
}

interface ChannelPlan {
    steps: ChannelStep[];
    expected: unknown;
    /** Properties to read back, when they are not the one the caller named. */
    reads?: ReadCheck[];
}

const REFERENCE_KINDS: PropertyKind[] = ['assetRef', 'nodeRef', 'componentRef'];
const UI_TRANSFORM_PAIR = /^_?(contentSize|anchorPoint)$/;
const LIVE_CHANNEL = 'assigned on the live object: the editor recorded no change of its own, so nothing '
    + 'outside this write knows the scene needs saving';

export function kindOf(target: WriteTarget): PropertyKind {
    return resolveKind(target.descriptor);
}

export function componentPath(target: WriteTarget, property?: string): string {
    return `__comps__.${target.componentIndex}.${property === undefined ? target.propertyPath : property}`;
}

export function writerFor(target: WriteTarget, value: unknown): PropertyWriter | undefined {
    return WRITERS.find(writer => writer.claims(target, value));
}

// ----- Read-back comparison ----------------------------------------------------------------

export function readBackMatches(expected: unknown, actual: unknown): boolean {
    return readBackMismatches(expected, actual).length === 0;
}

export function readBackMismatches(expected: unknown, actual: unknown, path = 'value'): string[] {
    const mismatches: string[] = [];
    if (expected === undefined) return mismatches;

    if (Array.isArray(expected)) {
        if (!Array.isArray(actual)) {
            mismatches.push(`${path}: expected an array of ${expected.length}, read ${show(actual)}`);
            return mismatches;
        }
        if (actual.length !== expected.length) {
            mismatches.push(`${path}: expected ${expected.length} element(s), read ${actual.length}`);
        }
        for (let index = 0; index < Math.min(expected.length, actual.length); index++) {
            mismatches.push(...readBackMismatches(expected[index], actual[index], `${path}.${index}`));
        }
        return mismatches;
    }

    if (expected && typeof expected === 'object') {
        if (!actual || typeof actual !== 'object') {
            mismatches.push(`${path}: expected ${show(expected)}, read ${show(actual)}`);
            return mismatches;
        }
        for (const [key, member] of Object.entries(expected as Record<string, unknown>)) {
            mismatches.push(...readBackMismatches(member, (actual as Record<string, unknown>)[key], `${path}.${key}`));
        }
        return mismatches;
    }

    if (!scalarEquals(expected, actual)) {
        mismatches.push(`${path}: expected ${show(expected)}, read ${show(actual)}`);
    }
    return mismatches;
}

function scalarEquals(expected: unknown, actual: unknown): boolean {
    if (expected === actual) return true;
    if (expected === null || expected === undefined) return actual === null || actual === undefined;
    if (actual === null || actual === undefined) return false;
    if (typeof expected === 'boolean' || typeof actual === 'boolean') return false;
    if (expected !== '' && actual !== '') {
        const expectedNumber = Number(expected);
        const actualNumber = Number(actual);
        if (Number.isFinite(expectedNumber) && Number.isFinite(actualNumber)) {
            return Math.abs(expectedNumber - actualNumber) < 1e-5;
        }
    }
    return String(expected) === String(actual);
}

function show(value: unknown): string {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

// ----- Read-back through the editor dump ---------------------------------------------------

export async function readBack(target: WriteTarget, ctx: ToolContext, property?: string): Promise<unknown> {
    const node = await ctx.editor.scene.queryNode(target.nodeUuid) as any;
    const component = node && node.__comps__ && node.__comps__[target.componentIndex];
    const segments = (property === undefined ? target.propertyPath : property).split('.');
    let current: any = component && component.value && component.value[segments[0]];
    for (let index = 1; index < segments.length && current !== undefined && current !== null; index++) {
        current = current.value ? current.value[segments[index]] : undefined;
    }
    if (current === undefined || current === null) return undefined;
    return isDumpDescriptor(current) ? projectDescriptor(current) : projectValue(kindOf(target), current);
}

export async function componentCid(target: WriteTarget, ctx: ToolContext): Promise<string | undefined> {
    const node = await ctx.editor.scene.queryNode(target.nodeUuid) as any;
    const component = node && node.__comps__ && node.__comps__[target.componentIndex];
    if (!component) return undefined;
    return component.__type__ || component.cid || component.type || undefined;
}

// ----- The channels ------------------------------------------------------------------------

async function throughEditor(target: WriteTarget, plan: ChannelPlan, ctx: ToolContext): Promise<WriteReport> {
    const refused: string[] = [];
    let landed = 0;
    for (const step of plan.steps) {
        try {
            await ctx.editor.scene.setProperty({ uuid: target.nodeUuid, path: step.path, dump: step.dump as any });
            landed++;
        } catch (error) {
            refused.push(`${step.path}: ${messageOf(error)}`);
        }
    }
    if (landed === 0) {
        return { written: false, verified: false, persisted: false, detail: `set-property refused ${refused.join('; ')}` };
    }

    const reads: ReadCheck[] = plan.reads || [{ property: target.propertyPath, expected: plan.expected }];
    const verified = await settle(() => readsMatch(target, reads, ctx));
    const report: WriteReport = {
        written: true, verified, persisted: true, channel: 'editor', ...prefabOverrideOf(target)
    };
    const notes = refused.length ? [`set-property refused ${refused.join('; ')}`] : [];
    if (!verified) notes.push(await readBackComplaint(target, reads, ctx));
    if (notes.length) report.detail = notes.join('; ');
    return report;
}

async function readsMatch(target: WriteTarget, reads: ReadCheck[], ctx: ToolContext): Promise<boolean> {
    for (const read of reads) {
        if (!readBackMatches(read.expected, await readBack(target, ctx, read.property))) return false;
    }
    return true;
}

async function readBackComplaint(target: WriteTarget, reads: ReadCheck[], ctx: ToolContext): Promise<string> {
    const mismatches: string[] = [];
    for (const read of reads) {
        let actual: unknown;
        try {
            actual = await readBack(target, ctx, read.property);
        } catch (error) {
            return `the write did not error and could not be read back: ${messageOf(error)}`;
        }
        mismatches.push(...readBackMismatches(read.expected, actual, read.property));
    }
    return mismatches.length
        ? `read-back disagrees — ${mismatches.join('; ')}`
        : `the dump does not expose '${reads.map(read => read.property).join(', ')}', so the write is unproven`;
}

function prefabOverrideOf(target: WriteTarget): { prefabOverride?: { targetPath: string } } {
    return target.prefabInstanceRoot ? { prefabOverride: { targetPath: componentPath(target) } } : {};
}

function unwritten(detail: string): WriteReport {
    return { written: false, verified: false, persisted: false, detail };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sceneError(result: any): string {
    return (result && result.error) || 'the scene script did not answer';
}

// ----- Value shaping -----------------------------------------------------------------------

function uuidOf(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        const holder = value as { uuid?: unknown; __uuid__?: unknown };
        if (typeof holder.uuid === 'string') return holder.uuid;
        if (typeof holder.__uuid__ === 'string') return holder.__uuid__;
    }
    return null;
}

function plainValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => plainValue(item));
    if (isDumpDescriptor(value)) return plainValue((value as PropertyDescriptor).value);
    if (value && typeof value === 'object') {
        const plain: Record<string, unknown> = {};
        for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
            plain[key] = plainValue(member);
        }
        return plain;
    }
    return value;
}

function isReference(descriptor?: PropertyDescriptor | null): boolean {
    return !isArrayDescriptor(descriptor) && REFERENCE_KINDS.indexOf(resolveKind(descriptor)) !== -1;
}

function isReferenceArray(descriptor?: PropertyDescriptor | null): boolean {
    return isArrayDescriptor(descriptor) && REFERENCE_KINDS.indexOf(resolveKind(descriptor)) !== -1;
}

function parseColorString(text: string): Record<string, number> {
    const hex = text.replace('#', '');
    const channel = (at: number) => parseInt(hex.substr(at, 2), 16) || 0;
    return { r: channel(0), g: channel(2), b: channel(4), a: hex.length >= 8 ? channel(6) : 255 };
}

function colorValue(value: unknown): Record<string, number> {
    if (typeof value === 'string') return parseColorString(value);
    const channels = (value || {}) as Record<string, unknown>;
    const clamp = (channel: unknown) => Math.min(255, Math.max(0, Number(channel) || 0));
    return {
        r: clamp(channels.r), g: clamp(channels.g), b: clamp(channels.b),
        a: channels.a === undefined ? 255 : clamp(channels.a)
    };
}

const VEC_AXES: Record<string, string[]> = {
    'cc.Vec2': ['x', 'y'],
    'cc.Vec3': ['x', 'y', 'z'],
    'cc.Vec4': ['x', 'y', 'z', 'w'],
    'cc.Quat': ['x', 'y', 'z', 'w'],
    'cc.Size': ['width', 'height']
};

function vecValue(descriptor: PropertyDescriptor | undefined, value: unknown): Record<string, number> {
    const declared = descriptor && typeof descriptor.type === 'string' ? VEC_AXES[descriptor.type] : undefined;
    const current = descriptor && descriptor.value && typeof descriptor.value === 'object' && !Array.isArray(descriptor.value)
        ? Object.keys(descriptor.value as Record<string, unknown>)
        : undefined;
    const axes = declared || current || Object.keys((value || {}) as Record<string, unknown>);
    const given = (value || {}) as Record<string, unknown>;
    const built: Record<string, number> = {};
    for (const axis of axes) built[axis] = Number(given[axis]) || 0;
    return built;
}

function plainScalar(descriptor: PropertyDescriptor | undefined, value: unknown): unknown {
    const type = descriptor && typeof descriptor.type === 'string' ? descriptor.type : '';
    if (type === 'Boolean') {
        if (typeof value === 'string') return value !== '' && value !== 'false' && value !== '0';
        return Boolean(value);
    }
    if (type === 'Number') return Number(value);
    if (type === 'String') return String(value);
    return value;
}

function scalarValue(kind: PropertyKind, descriptor: PropertyDescriptor | undefined, value: unknown): unknown {
    switch (kind) {
        case 'color': return colorValue(value);
        case 'vec': return vecValue(descriptor, value);
        case 'enum':
        case 'bitmask': return Number(value);
        default: return plainScalar(descriptor, value);
    }
}

export function typedDump(descriptor: PropertyDescriptor, kind: PropertyKind, value: unknown): ChannelStep['dump'] {
    const hinted = (type: string | undefined) =>
        !!type && (kind === 'color' || kind === 'vec' || type.indexOf('cc.') === 0);
    const typed = (type: string | undefined, built: unknown) =>
        hinted(type) ? { type, value: built } : { value: built };

    if (isArrayDescriptor(descriptor)) {
        const element = descriptor.elementTypeData || { ...descriptor, isArray: false, value: undefined };
        const items = Array.isArray(value) ? value : [value];
        return typed(element.type, items.map(item => scalarValue(kind, element, item)));
    }
    return typed(descriptor.type, scalarValue(kind, descriptor, value));
}

// ----- Serializable @ccclass ---------------------------------------------------------------

/**
 * The editor decodes a reference nested in an array element by ASSIGNING the dump onto the live
 * object instead of resolving the uuid, which empties the slot or throws on one that already
 * holds an asset. So references leave the inline dump and go out as their own set-property calls.
 */
export function buildClassElement(
    template: PropertyDescriptor | undefined, supplied: unknown, pathPrefix: string
): ClassElement {
    const fields = (template && template.value && typeof template.value === 'object' && !Array.isArray(template.value)
        ? template.value : {}) as Record<string, PropertyDescriptor>;
    const given = (supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        ? supplied : {}) as Record<string, unknown>;
    const dumpValue: Record<string, unknown> = {};
    const refs: ReferenceStep[] = [];
    const expected: Record<string, unknown> = {};

    for (const [field, fieldTemplate] of Object.entries(fields)) {
        const fieldPath = `${pathPrefix}.${field}`;
        const hasValue = Object.prototype.hasOwnProperty.call(given, field);
        const fieldKind = resolveKind(fieldTemplate);

        if (isReference(fieldTemplate)) {
            const uuid = hasValue ? (uuidOf(given[field]) || '') : '';
            refs.push({ path: fieldPath, type: fieldTemplate.type || '', uuid });
            expected[field] = uuid || null;
            continue;
        }
        if (isReferenceArray(fieldTemplate)) {
            const items = hasValue && Array.isArray(given[field]) ? given[field] as unknown[] : [];
            const uuids = items.map(item => uuidOf(item) || '');
            const elementType = (fieldTemplate.elementTypeData && fieldTemplate.elementTypeData.type) || fieldTemplate.type || '';
            dumpValue[field] = { type: elementType, value: uuids.map(uuid => ({ uuid })) };
            uuids.forEach((uuid, index) => refs.push({ path: `${fieldPath}.${index}`, type: elementType, uuid }));
            expected[field] = uuids.map(uuid => uuid || null);
            continue;
        }
        if (fieldKind === 'classArray') {
            const items = hasValue && Array.isArray(given[field]) ? given[field] as unknown[] : [];
            const inner = items.map((item, index) =>
                buildClassElement(fieldTemplate.elementTypeData, item, `${fieldPath}.${index}`));
            dumpValue[field] = {
                type: fieldTemplate.elementTypeData && fieldTemplate.elementTypeData.type,
                value: inner.map(entry => entry.dump)
            };
            inner.forEach(entry => refs.push(...entry.refs));
            expected[field] = inner.map(entry => entry.expected);
            continue;
        }
        if (fieldKind === 'nestedClass' || fieldKind === 'gradient' || fieldKind === 'curve') {
            const inner = buildClassElement(fieldTemplate, hasValue ? given[field] : {}, fieldPath);
            dumpValue[field] = inner.dump;
            refs.push(...inner.refs);
            expected[field] = inner.expected;
            continue;
        }

        const fallback = fieldTemplate.value !== undefined ? fieldTemplate.value : fieldTemplate.default;
        const leaf = hasValue ? scalarValue(fieldKind, fieldTemplate, given[field]) : fallback;
        dumpValue[field] = { type: fieldTemplate.type, value: leaf };
        expected[field] = projectValue(fieldKind, leaf);
    }

    return { dump: { type: template && template.type, value: dumpValue }, refs, expected };
}

export function buildClassPatch(
    descriptor: PropertyDescriptor, supplied: unknown, basePath: string
): ClassPatch {
    const dump = JSON.parse(JSON.stringify(descriptor)) as { type?: string; value: Record<string, unknown> };
    const fields = (dump.value || {}) as Record<string, PropertyDescriptor>;
    const template = (descriptor.value || {}) as Record<string, PropertyDescriptor>;
    const given = (supplied && typeof supplied === 'object' && !Array.isArray(supplied)
        ? supplied : {}) as Record<string, unknown>;
    const refs: ReferenceStep[] = [];
    const expected: Record<string, unknown> = {};
    const unknown: string[] = [];

    for (const field of Object.keys(fields)) {
        if (isReference(fields[field])) delete fields[field];
    }

    for (const [field, value] of Object.entries(given)) {
        const fieldTemplate = template[field];
        if (!fieldTemplate) { unknown.push(field); continue; }
        const fieldPath = `${basePath}.${field}`;
        const fieldKind = resolveKind(fieldTemplate);

        if (isReference(fieldTemplate)) {
            const uuid = uuidOf(value) || '';
            refs.push({ path: fieldPath, type: fieldTemplate.type || '', uuid });
            expected[field] = uuid || null;
            continue;
        }
        if (isReferenceArray(fieldTemplate)) {
            const uuids = (Array.isArray(value) ? value : []).map(item => uuidOf(item) || '');
            const elementType = (fieldTemplate.elementTypeData && fieldTemplate.elementTypeData.type) || fieldTemplate.type || '';
            fields[field] = { type: elementType, value: uuids.map(uuid => ({ uuid })) } as PropertyDescriptor;
            uuids.forEach((uuid, index) => refs.push({ path: `${fieldPath}.${index}`, type: elementType, uuid }));
            expected[field] = uuids.map(uuid => uuid || null);
            continue;
        }
        if (fieldKind === 'classArray') {
            const items = Array.isArray(value) ? value : [];
            const inner = items.map((item, index) =>
                buildClassElement(fieldTemplate.elementTypeData, item, `${fieldPath}.${index}`));
            fields[field] = {
                type: fieldTemplate.elementTypeData && fieldTemplate.elementTypeData.type,
                value: inner.map(entry => entry.dump)
            } as PropertyDescriptor;
            inner.forEach(entry => refs.push(...entry.refs));
            expected[field] = inner.map(entry => entry.expected);
            continue;
        }
        if (fieldKind === 'nestedClass' || fieldKind === 'gradient' || fieldKind === 'curve') {
            const inner = buildClassPatch(fieldTemplate, value, fieldPath);
            fields[field] = inner.dump as PropertyDescriptor;
            refs.push(...inner.refs);
            expected[field] = inner.expected;
            unknown.push(...inner.unknown.map(name => `${field}.${name}`));
            continue;
        }

        const leaf = scalarValue(fieldKind, fieldTemplate, value);
        fields[field] = { ...fieldTemplate, value: leaf };
        expected[field] = projectValue(fieldKind, leaf);
    }

    return { dump, refs, expected, unknown };
}

function referenceSteps(refs: ReferenceStep[]): ChannelStep[] {
    return refs.map(reference => ({
        path: reference.path,
        dump: { type: reference.type, value: { uuid: reference.uuid } }
    }));
}

// ----- Writers -----------------------------------------------------------------------------

function claimsKind(kind: PropertyKind): (target: WriteTarget) => boolean {
    return target => kindOf(target) === kind && !isUITransformPair(target);
}

function isUITransformPair(target: WriteTarget): boolean {
    return target.componentType === 'cc.UITransform' && UI_TRANSFORM_PAIR.test(target.propertyPath);
}

// The engine route replaces the whole GradientRange/CurveRange, so it may only claim a value
// carrying the key arrays its body reads — a spelling it does not consume erases the authored
// curve and flips the mode on its way through.
function carriesGradientKeys(value: unknown): boolean {
    const spec = value as Record<string, unknown> | null;
    return !!spec && typeof spec === 'object'
        && (Array.isArray(spec.colorKeys) || Array.isArray(spec.alphaKeys));
}

function carriesCurveKeys(value: unknown): boolean {
    if (Array.isArray(value)) return true;
    const spec = value as Record<string, unknown> | null;
    return !!spec && typeof spec === 'object' && Array.isArray(spec.keyframes);
}

function enablesModule(target: WriteTarget, spec: Record<string, unknown>): boolean {
    return spec.enable === true || /module/i.test(target.propertyPath);
}

const gradientWriter: PropertyWriter = {
    name: 'gradient',
    kind: 'gradient',
    claims: (target, value) => kindOf(target) === 'gradient' && carriesGradientKeys(value),
    write: async (target, value, ctx) => {
        const spec = (value || {}) as Record<string, any>;
        const result = await ctx.sceneScript.call(
            'setParticleGradient', target.nodeUuid, target.componentType, target.propertyPath,
            Array.isArray(spec.colorKeys) ? spec.colorKeys : [],
            Array.isArray(spec.alphaKeys) ? spec.alphaKeys : [],
            spec.mode, enablesModule(target, spec)
        );
        if (!result || result.success !== true) return unwritten(sceneError(result));
        const applied = Number(result.data.colorKeys) > 0;
        return {
            written: true, verified: applied, persisted: false, channel: 'live',
            detail: `${result.data.colorKeys} colour / ${result.data.alphaKeys} alpha key(s); ${LIVE_CHANNEL}`
        };
    }
};

const curveWriter: PropertyWriter = {
    name: 'curve',
    kind: 'curve',
    claims: (target, value) => kindOf(target) === 'curve' && carriesCurveKeys(value),
    write: async (target, value, ctx) => {
        const spec = (value || {}) as Record<string, any>;
        const keyframes = Array.isArray(spec.keyframes) ? spec.keyframes : (Array.isArray(value) ? value : []);
        const result = await ctx.sceneScript.call(
            'setParticleCurve', target.nodeUuid, target.componentType, target.propertyPath,
            keyframes, spec.mode, spec.multiplier, enablesModule(target, spec)
        );
        if (!result || result.success !== true) return unwritten(sceneError(result));
        const applied = Number(result.data.keyCount) > 0;
        return {
            written: true, verified: applied, persisted: false, channel: 'live',
            detail: `${result.data.keyCount} key(s), eval 0→1: ${result.data.eval0}→${result.data.eval1}; ${LIVE_CHANNEL}`
        };
    }
};

/** cc.UITransform stores contentSize and anchorPoint as two scalar fields each. */
const uiTransformWriter: PropertyWriter = {
    name: 'ui-transform-pair',
    kind: 'vec',
    claims: isUITransformPair,
    write: (target, value, ctx) => {
        const isSize = /contentSize/i.test(target.propertyPath);
        const given = (value || {}) as Record<string, unknown>;
        const fallback = isSize ? 100 : 0.5;
        // Number.isFinite, not `|| fallback`, so a legitimate 0 is not clobbered by the default.
        const pick = (raw: unknown) => Number.isFinite(Number(raw)) ? Number(raw) : fallback;
        const fields: Array<[string, string, number]> = isSize
            ? [['width', 'width', pick(given.width)], ['height', 'height', pick(given.height)]]
            : [['anchorX', 'x', pick(given.x)], ['anchorY', 'y', pick(given.y)]];
        const expected: Record<string, number> = {};
        for (const [, axis, magnitude] of fields) expected[axis] = magnitude;
        return throughEditor(target, {
            steps: fields.map(([field, , magnitude]) => ({
                path: componentPath(target, field), dump: { value: magnitude }
            })),
            expected,
            reads: fields.map(([field, , magnitude]) => ({ property: field, expected: magnitude }))
        }, ctx);
    }
};

const classArrayWriter: PropertyWriter = {
    name: 'class-array',
    kind: 'classArray',
    claims: claimsKind('classArray'),
    write: (target, value, ctx) => {
        const template = target.descriptor.elementTypeData;
        if (!template) {
            return Promise.resolve(unwritten(`'${target.propertyPath}' is an array the dump gives no element type for`));
        }
        const plain = plainValue(value);
        const elements = Array.isArray(plain) ? plain : (plain && typeof plain === 'object' ? [plain] : null);
        if (!elements) {
            return Promise.resolve(unwritten(
                `'${target.propertyPath}' takes an array of ${template.type} entries; got ${show(value)}`));
        }
        const basePath = componentPath(target);
        const built = elements.map((element, index) => buildClassElement(template, element, `${basePath}.${index}`));
        const refs: ReferenceStep[] = [];
        for (const entry of built) refs.push(...entry.refs);
        const steps: ChannelStep[] = [
            { path: basePath, dump: { type: template.type, value: built.map(entry => entry.dump) } }
        ];
        return throughEditor(target, {
            steps: steps.concat(referenceSteps(refs)),
            expected: built.map(entry => entry.expected)
        }, ctx);
    }
};

const nestedClassWriter: PropertyWriter = {
    name: 'nested-class',
    kind: 'nestedClass',
    claims: (target, value) => {
        const kind = kindOf(target);
        if (kind === 'gradient') return !carriesGradientKeys(value);
        if (kind === 'curve') return !carriesCurveKeys(value);
        return kind === 'nestedClass';
    },
    write: (target, value, ctx) => {
        const plain = plainValue(value);
        if (!plain || typeof plain !== 'object' || Array.isArray(plain)) {
            return Promise.resolve(unwritten(
                `${target.propertyPath} (${target.descriptor.type}) takes an object of its members; got ${show(value)}`));
        }
        const basePath = componentPath(target);
        const patch = buildClassPatch(target.descriptor, plain, basePath);
        if (patch.unknown.length) {
            return Promise.resolve(unwritten(
                `${target.propertyPath} (${target.descriptor.type}) has no member(s) ${patch.unknown.join(', ')}. `
                + `Members: ${Object.keys(target.descriptor.value || {}).join(', ')}`));
        }
        const steps: ChannelStep[] = [{ path: basePath, dump: patch.dump }];
        return throughEditor(target, {
            steps: steps.concat(referenceSteps(patch.refs)),
            expected: patch.expected
        }, ctx);
    }
};

const assetWriter: PropertyWriter = {
    name: 'asset-ref',
    kind: 'assetRef',
    claims: claimsKind('assetRef'),
    write: (target, value, ctx) => {
        const array = isArrayDescriptor(target.descriptor);
        const elementType = (array
            ? (target.descriptor.elementTypeData && target.descriptor.elementTypeData.type)
            : target.descriptor.type) || 'cc.Asset';
        const given = value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]);
        const uuids: string[] = [];
        for (const item of given) {
            const uuid = uuidOf(item);
            if (uuid === null) {
                return Promise.resolve(unwritten(
                    `'${target.propertyPath}' takes asset uuid string(s); got ${show(value)}`));
            }
            uuids.push(uuid);
        }
        const basePath = componentPath(target);
        if (!array) {
            return throughEditor(target, {
                steps: [{ path: basePath, dump: { type: elementType, value: { uuid: uuids[0] || '' } } }],
                expected: uuids[0] || null
            }, ctx);
        }
        if (uuids.length === 0) {
            return Promise.resolve(unwritten(
                `'${target.propertyPath}' is an array of assets and takes uuid string(s); got ${show(value)}`));
        }
        // A dump for the array as a whole throws and NULLs the slot (scene/component-ops.ts), so
        // each slot is assigned on its own and the array's length is not writable here.
        const steps: ChannelStep[] = uuids.map((uuid, slot) => ({
            path: `${basePath}.${slot}`, dump: { type: elementType, value: { uuid } }
        }));
        return throughEditor(target, { steps, expected: uuids.map(uuid => uuid || null) }, ctx);
    }
};

/**
 * A reference into a prefab instance never reaches the scene file: the serializer emits null and
 * the editor records a cc.TargetOverrideInfo replayed after the load. A live assignment records
 * none, so the field reads back perfectly and is empty the next time the scene is opened.
 */
async function writeReference(target: WriteTarget, value: unknown, ctx: ToolContext): Promise<WriteReport> {
    const options = target.refOptions || {};
    const args: Record<string, unknown> = {
        nodeUuid: target.nodeUuid, componentType: target.componentType, property: target.propertyPath
    };
    if (options.targetComponentType !== undefined) args.targetComponentType = options.targetComponentType;
    if (options.sameClassIndex !== undefined) args.componentIndex = options.sameClassIndex;
    if (value === null || value === undefined) {
        args.clear = true;
    } else if (Array.isArray(value)) {
        args.targetUuids = value.map(item => uuidOf(item));
    } else {
        args.targetUuid = uuidOf(value);
    }

    const plan = await ctx.sceneScript.call('resolveComponentReference', args);
    if (!plan || plan.success !== true) return unwritten(sceneError(plan));
    const { componentIndex, property, isArray, dumpType, uuids, expected } = plan.data;
    const path = `__comps__.${componentIndex}.${property}`;
    const element = (uuid: string) => ({ type: dumpType, value: { uuid } });
    const dump = isArray
        ? { type: dumpType, isArray: true, value: uuids.map(element) }
        : element(uuids[0] || '');

    let live = false;
    try {
        await ctx.editor.scene.setProperty({ uuid: target.nodeUuid, path, dump } as any);
    } catch (error) {
        const refusal = messageOf(error);
        const direct = await ctx.sceneScript.call('applyComponentReference', args);
        if (!direct || direct.success !== true) {
            return unwritten(`set-property refused '${path}' (${refusal}), and assigning on the live `
                + `component failed too: ${sceneError(direct)}`);
        }
        live = true;
    }

    // Read before this pruning and the leftover overrides answer with what the field held before
    // the write, so the verdict comes out inverted.
    await ctx.sceneScript.call('pruneComponentReferenceOverrides', target.nodeUuid, componentIndex, property);
    const outcome = await ctx.sceneScript.call('componentReferenceOutcome', target.nodeUuid, componentIndex, property);
    if (!outcome || outcome.success !== true) {
        return {
            written: true, verified: false, persisted: false, channel: live ? 'live' : 'editor',
            detail: `written, but the scene could not be re-read to check it (${sceneError(outcome)}); `
                + 'treat the write as unproven'
        };
    }

    const sameSlots = (slots: Array<string | null>) =>
        slots.length === expected.length && slots.every((uuid, index) => uuid === expected[index]);
    const overridden = outcome.data.overrides.length > 0;
    const report: WriteReport = {
        written: true,
        verified: sameSlots(outcome.data.live),
        persisted: !live && outcome.data.projectionChecked && sameSlots(outcome.data.projected),
        channel: live ? 'live' : 'editor',
        ...(overridden ? { prefabOverride: { targetPath: path } } : prefabOverrideOf(target))
    };
    const notes: string[] = plan.data.warning ? [plan.data.warning] : [];
    if (live) {
        notes.push(LIVE_CHANNEL);
    } else if (!outcome.data.projectionChecked) {
        notes.push('whether it survives a save was NOT established: the component sits inside a prefab '
            + 'instance whose asset could not be read');
    } else if (!report.persisted) {
        notes.push(`the next load builds [${outcome.data.projected.join(', ')}] for '${property}', `
            + `not [${expected.join(', ')}]`);
    }
    if (notes.length) report.detail = notes.join('; ');
    return report;
}

const nodeRefWriter: PropertyWriter = {
    name: 'node-ref',
    kind: 'nodeRef',
    claims: claimsKind('nodeRef'),
    write: writeReference
};

const componentRefWriter: PropertyWriter = {
    name: 'component-ref',
    kind: 'componentRef',
    claims: claimsKind('componentRef'),
    write: writeReference
};

function typedWriter(kind: PropertyKind): PropertyWriter {
    return {
        name: `typed:${kind}`,
        kind,
        claims: claimsKind(kind),
        write: (target, value, ctx) => {
            const dump = typedDump(target.descriptor, kind, value) as { value: unknown };
            return throughEditor(target, {
                steps: [{ path: componentPath(target), dump }],
                expected: projectValue(kind, dump.value)
            }, ctx);
        }
    };
}

/** The cascade order, declared here and nowhere else; no two claims may overlap. */
export const WRITERS: readonly PropertyWriter[] = [
    gradientWriter,
    curveWriter,
    uiTransformWriter,
    classArrayWriter,
    nestedClassWriter,
    assetWriter,
    nodeRefWriter,
    componentRefWriter,
    typedWriter('color'),
    typedWriter('vec'),
    typedWriter('enum'),
    typedWriter('bitmask'),
    typedWriter('plain')
];
