/**
 * Deciding what a `prefab_set_component_property` call actually means to write.
 *
 * The `value` parameter is any-typed, and an MCP client is free to serialize what it was given
 * into text: `true` arrives as `"true"`, `null` as `"null"`, a node reference as its path. Writing
 * those verbatim produced a prefab whose boolean was the string `"true"` and whose Node field held
 * a path — and the tool reported success, because a raw JSON write cannot fail. `typeof stack.slot
 * === 'string'` was found at runtime, one `slot.addChild` away from a crash.
 *
 * So the text is read against the property's DECLARED type, taken from the CCClass in the scene
 * process. Where no declaration is available the currently serialized value stands in. Where
 * neither can say what the property is, a string that spells a JSON scalar is refused rather than
 * stored: `"true"` is either a boolean or a string and nothing here can tell which.
 */

/** What a property can hold, as far as the write is concerned. */
export type PropertyShape =
    | 'boolean'
    | 'number'
    | 'string'
    | 'node'
    | 'component'
    | 'asset'
    | 'array'
    | 'unknown';

/** A property's declared type as the scene process reports it. */
export interface DeclaredProperty {
    found: boolean;
    ctorName: string | null;
    isNode: boolean;
    isComponent: boolean;
    isAsset: boolean;
    isArray: boolean;
    /** typeof the CCClass default when the property is a plain scalar. */
    scalar: 'boolean' | 'number' | 'string' | null;
    /** For an array property CCClass reports the ELEMENT's ctor, so these are the element's members. */
    members?: Record<string, DeclaredProperty>;
}

/** What `planPrefabValue` reshaped on its way in, for the caller to report. */
export interface Normalization {
    /** Class names stamped as `__type__`, so the engine builds instances instead of plain objects. */
    typed: string[];
    /** Paths turned into `{__uuid__}` from a bare uuid. */
    references: string[];
}

export type PrefabValuePlan =
    /** Write this exact serialized value. */
    | { kind: 'value'; value: any; coercedFrom?: string; normalized?: Normalization }
    /** Resolve this path inside the prefab and write the entry it names. */
    | { kind: 'reference'; nodePath: string; expects: 'node' | 'component'; componentType: string | null }
    | { kind: 'error'; error: string };

/** A dashed asset uuid, with the optional `@sub` suffix a sub-asset carries. */
const ASSET_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(@[0-9a-zA-Z_-]+)?$/;

/** Text that spells a JSON scalar, which is exactly the text a stringifying client produces. */
const JSON_SCALAR = /^(true|false|null|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/;

export function shapeOfDeclared(declared: DeclaredProperty | null): PropertyShape {
    if (!declared || !declared.found) return 'unknown';
    if (declared.isArray) return 'array';
    if (declared.isNode) return 'node';
    if (declared.isComponent) return 'component';
    if (declared.isAsset) return 'asset';
    return declared.scalar || 'unknown';
}

/** The shape the value already in the prefab implies, used when no declaration is available. */
export function shapeOfSerialized(previous: any): PropertyShape {
    if (Array.isArray(previous)) return 'array';
    if (typeof previous === 'boolean') return 'boolean';
    if (typeof previous === 'number') return 'number';
    if (typeof previous === 'string') return 'string';
    if (previous && typeof previous === 'object') {
        if (typeof previous.__uuid__ === 'string') return 'asset';
        if (typeof previous.__id__ === 'number') return 'node';
    }
    return 'unknown';
}

/**
 * What to write for `raw`. Non-string values pass through: a client that kept the JSON type has
 * already said what it means, and second-guessing it would be the same mistake in the other
 * direction.
 */
export function planPrefabValue(
    raw: any,
    declared: DeclaredProperty | null,
    previous: any,
    property: string
): PrefabValuePlan {
    if (typeof raw !== 'string') return planStructured(raw, declared, property);

    const text = raw.trim();
    const fromDeclaration = shapeOfDeclared(declared);
    const shape = fromDeclaration === 'unknown' ? shapeOfSerialized(previous) : fromDeclaration;
    const declaredAs = declared && declared.found && declared.ctorName
        ? ` ('${property}' declares ${declared.ctorName})`
        : '';
    const refuse = (why: string): PrefabValuePlan => ({ kind: 'error', error: `${why} Nothing was written.` });

    switch (shape) {
        case 'string':
            return { kind: 'value', value: raw };

        case 'boolean':
            if (/^true$/i.test(text)) return { kind: 'value', value: true, coercedFrom: 'string' };
            if (/^false$/i.test(text)) return { kind: 'value', value: false, coercedFrom: 'string' };
            return refuse(`'${property}' is a boolean and '${raw}' does not spell one.`);

        case 'number':
            if (text !== '' && Number.isFinite(Number(text))) {
                return { kind: 'value', value: Number(text), coercedFrom: 'string' };
            }
            return refuse(`'${property}' is a number and '${raw}' does not spell one.`);

        case 'asset':
            if (isNullText(text)) return { kind: 'value', value: null, coercedFrom: 'string' };
            if (ASSET_UUID.test(text)) {
                return {
                    kind: 'value',
                    value: assetReference(text, declared && declared.ctorName),
                    coercedFrom: 'string',
                    normalized: { typed: [], references: [property] }
                };
            }
            return refuse(
                `'${property}' is an asset reference${declaredAs} and '${raw}' is neither an asset uuid nor null. `
                + 'Pass {"__uuid__":"<uuid>"}, or the bare uuid.'
            );

        case 'node':
        case 'component':
            if (isNullText(text)) return { kind: 'value', value: null, coercedFrom: 'string' };
            return {
                kind: 'reference',
                nodePath: text,
                expects: shape,
                componentType: shape === 'component' && declared ? declared.ctorName : null
            };

        case 'array':
            return refuse(
                `'${property}' holds an array${declaredAs} and '${raw}' is a single string. `
                + 'Pass the whole array — it is replaced as a unit.'
            );

        default:
            if (JSON_SCALAR.test(text)) {
                return refuse(
                    `'${raw}' would be stored as the string "${raw}", and nothing here can say whether that is `
                    + `what '${property}' means: the property declares no type this bridge could read and holds `
                    + `${previous === undefined ? 'no previous value' : JSON.stringify(previous)}. `
                    + 'Pass the value with its JSON type (true, 12, null), not as text.'
                );
            }
            return { kind: 'value', value: raw };
    }
}

function isNullText(text: string): boolean {
    return text === '' || /^null$/i.test(text);
}

function planStructured(raw: any, declared: DeclaredProperty | null, property: string): PrefabValuePlan {
    if (!declared || !declared.found || !typeAware(declared)) return { kind: 'value', value: raw };
    const normalized: Normalization = { typed: [], references: [] };
    try {
        const value = normalizeSlot(raw, declared, property, normalized);
        return normalized.typed.length || normalized.references.length
            ? { kind: 'value', value, normalized }
            : { kind: 'value', value };
    } catch (error) {
        return { kind: 'error', error: `${error instanceof Error ? error.message : String(error)} Nothing was written.` };
    }
}

function typeAware(declared: DeclaredProperty): boolean {
    return !!declared.members || !!declared.isAsset || !!declared.isNode || !!declared.isComponent;
}

function normalizeSlot(
    value: any, declared: DeclaredProperty, path: string, normalized: Normalization
): any {
    if (!declared.isArray) return normalizeElement(value, declared, path, normalized);
    if (value === null || value === undefined) return value;
    if (!Array.isArray(value)) {
        throw new Error(`'${path}' holds an array${ofType(declared)} and ${show(value)} is not one.`);
    }
    return value.map((item, index) => normalizeElement(item, declared, `${path}.${index}`, normalized));
}

function normalizeElement(
    value: any, declared: DeclaredProperty, path: string, normalized: Normalization
): any {
    if (declared.isAsset) return normalizeAsset(value, declared, path, normalized);
    if (declared.isNode || declared.isComponent) return normalizeEntity(value, declared, path);
    if (declared.members) return normalizeBlock(value, declared, path, normalized);
    return normalizeLeaf(value, declared, path);
}

function normalizeAsset(
    value: any, declared: DeclaredProperty, path: string, normalized: Normalization
): any {
    if (value === null || value === undefined || value === '') return null;
    const uuid = typeof value === 'string'
        ? value.trim()
        : (value && typeof value === 'object' ? (value.__uuid__ ?? value.uuid) : undefined);
    if (typeof uuid !== 'string' || !ASSET_UUID.test(uuid)) {
        throw new Error(
            `'${path}' is a ${declared.ctorName || 'cc.Asset'} reference and ${show(value)} is neither an `
            + 'asset uuid nor null.'
        );
    }
    normalized.references.push(path);
    return assetReference(uuid, declared.ctorName);
}

/**
 * A node or component reference cannot leave the prefab, so the file stores it as the index of
 * the entry it names. A path is resolved for a top-level property only, where the prefab's own
 * node table is at hand.
 */
function normalizeEntity(value: any, declared: DeclaredProperty, path: string): any {
    if (value === null || value === undefined || value === '') return null;
    if (value && typeof value === 'object' && typeof value.__id__ === 'number') return { __id__: value.__id__ };
    throw new Error(
        `'${path}' points at a ${declared.isNode ? 'node' : 'component'} inside this prefab, which is stored `
        + `as {"__id__":<entry index>}; got ${show(value)}. A node PATH is resolved only when it is the whole `
        + 'value of a top-level property, not inside a nested one.'
    );
}

function normalizeBlock(
    value: any, declared: DeclaredProperty, path: string, normalized: Normalization
): any {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`'${path}' is a ${declared.ctorName} and takes an object of its members; got ${show(value)}.`);
    }
    const members = declared.members!;
    const unknown = Object.keys(value).filter(name => name !== '__type__' && !(name in members));
    if (unknown.length) {
        throw new Error(
            `'${path}' (${declared.ctorName}) has no member(s) ${unknown.join(', ')}. `
            + `Members: ${Object.keys(members).join(', ')}.`
        );
    }
    // `__type__` is what makes the engine build a class instance; without it the element loads as
    // a plain object that duck-types at runtime and is invisible to every editor tool.
    const block: Record<string, any> = { __type__: declared.ctorName };
    if (declared.ctorName) normalized.typed.push(declared.ctorName);
    for (const [name, member] of Object.entries(members)) {
        if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
        block[name] = normalizeSlot(value[name], member, `${path}.${name}`, normalized);
    }
    return block;
}

function normalizeLeaf(value: any, declared: DeclaredProperty, path: string): any {
    if (declared.scalar === 'number') {
        const magnitude = Number(value);
        if (value === '' || value === null || value === undefined || !Number.isFinite(magnitude)) {
            throw new Error(`'${path}' is a number and ${show(value)} does not spell one.`);
        }
        return magnitude;
    }
    if (declared.scalar === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (/^true$/i.test(String(value))) return true;
        if (/^false$/i.test(String(value))) return false;
        throw new Error(`'${path}' is a boolean and ${show(value)} does not spell one.`);
    }
    if (declared.scalar === 'string') return typeof value === 'string' ? value : String(value);
    if (typeof value === 'string' && ASSET_UUID.test(value.trim())) {
        throw new Error(
            `'${path}' would be stored as the string ${show(value)}, which spells an asset uuid, and nothing `
            + 'declares a type for that member — so a reference cannot be told from text here. Pass '
            + '{"__uuid__":"<uuid>"} if it is a reference.'
        );
    }
    return value;
}

function assetReference(uuid: string, ctorName: string | null | undefined): Record<string, string> {
    return ctorName ? { __uuid__: uuid, __expectedType__: ctorName } : { __uuid__: uuid };
}

function ofType(declared: DeclaredProperty): string {
    return declared.ctorName ? ` of ${declared.ctorName}` : '';
}

function show(value: unknown): string {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}
