/**
 * A JSON-Schema parameter that declares only a `description` and no `type` is not
 * self-describing, and MCP clients are free to serialize whatever they were given into a
 * string. An object argument then arrives as the text `{"__id__":184}` and is written
 * verbatim, so a reference silently becomes a string while the call reports success.
 *
 * Two defences, used together:
 *   - ANY_VALUE_TYPE on the schema, so conforming clients keep the JSON type;
 *   - coerceJsonArg on the server, so a client that stringified anyway is recovered.
 */

/** Permissive but explicit schema type for a genuinely any-typed parameter. */
export const ANY_VALUE_TYPE = ['object', 'array', 'string', 'number', 'boolean', 'null'];

export interface CoercedArg {
    value: any;
    /** True when a JSON-looking string was parsed back into an object or array. */
    coerced: boolean;
}

/**
 * Parse a string argument back into the object or array a client stringified.
 * Only `{`/`[`-leading text that parses as JSON is touched; scalars, stringified JSON
 * scalars ("42", "true") and malformed text come back untouched, so a property whose
 * real value is a string keeps it.
 */
export function coerceJsonArg(value: any): CoercedArg {
    if (typeof value !== 'string') return { value, coerced: false };
    const trimmed = value.trim();
    if (trimmed[0] !== '{' && trimmed[0] !== '[') return { value, coerced: false };
    let parsed: any;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { value, coerced: false };
    }
    if (parsed === null || typeof parsed !== 'object') return { value, coerced: false };
    return { value: parsed, coerced: true };
}
