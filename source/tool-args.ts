/**
 * Argument validation for every tool call, applied at the single dispatch chokepoint in
 * `MCPServer.executeToolCall`.
 *
 * Without it a tool call carrying the wrong parameter name is not rejected — the handler
 * simply reads `undefined` and degrades in whatever way its callee happens to. Two such
 * failures, both from real sessions:
 *
 *   - `search_project_logs` called with `keyword` left `pattern` undefined, and
 *     `new RegExp(undefined, 'gi')` compiles to the empty pattern `/(?:)/`, which matches
 *     every line. The tool reported the first 20 lines of the log as confident matches.
 *   - `reimport_asset` called with `assetPath` left `url` undefined and handed it to the
 *     editor, which surfaced as `Cannot read properties of undefined (reading 'startsWith')`.
 *
 * Both are invisible to the caller: one lies, the other blames the callee. So a missing
 * required argument is rejected here, and the rejection names the parameter the tool
 * actually expects — and, when the caller was close, which of its arguments to rename.
 *
 * Aliases exist because the surface is not internally consistent: asset paths are `url`
 * here and `prefabPath`/`assetPath` elsewhere, and log tools spell the same idea both
 * `pattern` and `filterKeyword`. Declaring the alternate spellings makes the obvious guess
 * work rather than fail, while `x-aliases` stays inert for schema consumers.
 */

/** Custom JSON-Schema keyword: alternate accepted spellings for a parameter. */
export const ALIAS_KEY = 'x-aliases';

export interface ArgsOk {
    ok: true;
    args: Record<string, any>;
    /** Alias spellings that were rewritten, for echoing back to the caller. */
    renamed: Array<{ from: string; to: string }>;
}

export interface ArgsError {
    ok: false;
    error: string;
}

export type ArgResult = ArgsOk | ArgsError;

/** Levenshtein distance, used only to suggest a rename in an error message. */
function distance(a: string, b: string): number {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
        const cur = [i];
        for (let j = 1; j <= n; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[n];
}

/** Split camelCase / snake_case into lowercase words: assetUri -> ['asset', 'uri']. */
function tokens(name: string): string[] {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/)
        .filter(Boolean).map(t => t.toLowerCase());
}

/**
 * Closest declared parameter to `name`, if one is near enough to be worth suggesting.
 * Three ways to be near, in order of confidence: one name contains the other
 * (assetPath -> path), a component word nearly matches (assetUri -> url, via uri~url),
 * or the whole names are within a small edit distance.
 */
function closest(name: string, candidates: string[]): string | undefined {
    const lower = name.toLowerCase();
    const nameTokens = tokens(name);
    let best: string | undefined;
    let bestScore = Infinity;
    for (const c of candidates) {
        const cl = c.toLowerCase();
        let score: number;
        if (cl.includes(lower) || lower.includes(cl)) {
            score = 1;
        } else {
            // best single-word match against the candidate as a whole
            const tokenScore = Math.min(...nameTokens.map(t => distance(t, cl)), Infinity);
            score = Math.min(distance(lower, cl), tokenScore + 1);
        }
        if (score < bestScore) { bestScore = score; best = c; }
    }
    // allow roughly a third of the name to differ before the suggestion becomes noise
    return bestScore <= Math.max(2, Math.ceil(name.length / 3)) ? best : undefined;
}

/** "pattern (string, required), maxResults (number), regex (boolean)" */
function describeParams(properties: Record<string, any>, required: string[]): string {
    const names = Object.keys(properties);
    if (!names.length) return '(this tool takes no arguments)';
    return names.map(n => {
        const p = properties[n] || {};
        const type = Array.isArray(p.type) ? p.type.join('|') : p.type;
        const bits = [type, required.includes(n) ? 'required' : null].filter(Boolean);
        const aliases = Array.isArray(p[ALIAS_KEY]) && p[ALIAS_KEY].length
            ? ` [also accepts: ${p[ALIAS_KEY].join(', ')}]`
            : '';
        return `${n}${bits.length ? ` (${bits.join(', ')})` : ''}${aliases}`;
    }).join(', ');
}

/** A required argument is satisfied by anything but null/undefined/blank text. */
function isMissing(value: any): boolean {
    return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Coerce a value to a singular declared scalar type. Clients reaching the REST surface send
 * everything as text, so "6" for a number and "true" for a boolean are honest inputs — but
 * "abc" for a number is a mistake worth reporting rather than turning into NaN.
 * Returns `undefined` when the value cannot satisfy the declared type.
 */
function coerceScalar(value: any, type: string): { value: any } | undefined {
    if (type === 'number' || type === 'integer') {
        if (typeof value === 'number') return Number.isFinite(value) ? { value } : undefined;
        if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
            return { value: Number(value) };
        }
        return undefined;
    }
    if (type === 'boolean') {
        if (typeof value === 'boolean') return { value };
        if (value === 'true' || value === '1') return { value: true };
        if (value === 'false' || value === '0') return { value: false };
        return undefined;
    }
    if (type === 'string') {
        // objects and arrays are never a string the caller meant; numbers/booleans are
        if (typeof value === 'object') return undefined;
        return { value: typeof value === 'string' ? value : String(value) };
    }
    return { value };
}

/**
 * Resolve aliases, check required arguments and coerce declared scalar types.
 *
 * Undeclared extra arguments are deliberately tolerated when every required argument is
 * present: several handlers (`scene_dump`, `scene_checksum`, `set_component_ref`,
 * `validate_scene`) take the whole args object and read fields their schema never
 * enumerates. Extras only become an error when something required is absent — which is
 * exactly the case where a misspelling is the likely cause and a suggestion helps.
 */
export function normalizeToolArgs(toolName: string, schema: any, raw: any): ArgResult {
    const properties: Record<string, any> = (schema && schema.properties) || {};
    const required: string[] = (schema && Array.isArray(schema.required)) ? schema.required : [];
    const declared = Object.keys(properties);

    const args: Record<string, any> = (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? { ...raw }
        : {};

    // alias -> canonical, from the x-aliases keyword on each property
    const aliasMap = new Map<string, string>();
    for (const name of declared) {
        const aliases = properties[name] && properties[name][ALIAS_KEY];
        if (Array.isArray(aliases)) for (const a of aliases) aliasMap.set(a, name);
    }

    const renamed: Array<{ from: string; to: string }> = [];
    for (const [alias, canonical] of aliasMap) {
        if (!(alias in args)) continue;
        // an explicit canonical value always wins; the alias is simply dropped
        if (isMissing(args[canonical])) {
            args[canonical] = args[alias];
            renamed.push({ from: alias, to: canonical });
        }
        delete args[alias];
    }

    const missing = required.filter(name => isMissing(args[name]));
    if (missing.length) {
        // "absent" and "supplied but blank" are different mistakes and deserve different
        // wording — reporting a blank value as simply missing reads as a contradiction
        // against the argument list, which does contain the name.
        const absent = missing.filter(name => args[name] === undefined || args[name] === null);
        const blank = missing.filter(name => !absent.includes(name));
        const quote = (list: string[]) => list.map(m => `'${m}'`).join(', ');

        const parts: string[] = [];
        if (absent.length) parts.push(`missing required argument(s): ${quote(absent)}`);
        if (blank.length) parts.push(`required argument(s) supplied but empty: ${quote(blank)}`);

        const unknown = Object.keys(args).filter(k => !declared.includes(k));
        const hints: string[] = [];
        for (const u of unknown) {
            const suggestion = closest(u, absent);
            if (suggestion) hints.push(`Did you mean '${suggestion}' instead of '${u}'?`);
        }
        const received = unknown.length
            ? ` Unrecognised argument(s): ${quote(unknown)}.`
            : '';
        return {
            ok: false,
            error: `${toolName}: ${parts.join('; ')}.${received}`
                + `${hints.length ? ' ' + hints.join(' ') : ''} `
                + `Expected arguments: ${describeParams(properties, required)}.`
        };
    }

    for (const name of declared) {
        if (isMissing(args[name]) && !(name in args)) continue;
        if (args[name] === undefined || args[name] === null) continue;
        const type = properties[name] && properties[name].type;
        if (typeof type !== 'string') continue;   // absent, or a union such as ANY_VALUE_TYPE
        const coerced = coerceScalar(args[name], type);
        if (!coerced) {
            return {
                ok: false,
                error: `${toolName}: argument '${name}' must be of type ${type}, but received `
                    + `${Array.isArray(args[name]) ? 'array' : typeof args[name]} `
                    + `(${JSON.stringify(args[name])}). `
                    + `Expected arguments: ${describeParams(properties, required)}.`
            };
        }
        args[name] = coerced.value;
    }

    return { ok: true, args, renamed };
}
