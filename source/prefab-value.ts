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
}

export type PrefabValuePlan =
    /** Write this exact serialized value. */
    | { kind: 'value'; value: any; coercedFrom?: string }
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
    if (typeof raw !== 'string') return { kind: 'value', value: raw };

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
            if (ASSET_UUID.test(text)) return { kind: 'value', value: { __uuid__: text }, coercedFrom: 'string' };
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
