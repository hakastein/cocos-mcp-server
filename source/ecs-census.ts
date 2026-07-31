/**
 * Per-component-key census of an ECS kit: who reads a key, who writes its fields, who adds it and
 * who removes it — and which keys have readers and no writer at all.
 *
 * A component nothing writes is a feature that silently never runs. Unit tests over systems do not
 * see it (the system runs, the query is simply empty forever), and neither does the type checker
 * (the key is declared, so every read compiles). The only thing that finds it is a whole-kit sweep.
 *
 * Parsing is the TypeScript compiler's own parser over real syntax trees — never a text match. What
 * it does NOT do is bind or type-check: there is no checker, so classification is structural. Every
 * place that costs the census precision is reported in `limits` and in the `unresolved` list rather
 * than being silently dropped.
 */

import * as ts from 'typescript';

export interface CensusSource {
    /** Path as it should appear in the report — the caller decides whether it is absolute or relative. */
    path: string;
    text: string;
}

export type UsageKind =
    /** `entity.key`, `entity.key !== undefined` — the value is consumed. */
    | 'read'
    /** `world.with('key')`, `.without('key')`, `singletonOf(world, 'key')`. */
    | 'query'
    /** `entity.key.field = …` — the component object is mutated in place. */
    | 'fieldWrite'
    /** `entity.key = …` — the slot itself is assigned. */
    | 'set'
    /** `commands.add(e, 'key', …)`, `world.addComponent`, a key in an entity object literal. */
    | 'add'
    /** `commands.remove(e, 'key')`, `world.removeComponent`, `delete entity.key`. */
    | 'remove';

export interface UsageSite {
    file: string;
    line: number;
    kind: UsageKind;
    /** Nearest enclosing named function, method or class — "which system does this". */
    fn: string;
    /** The expression as written, truncated. */
    text: string;
    /** Set when the site was reached through a local wrapper rather than a direct world/command call. */
    viaWrapper?: string;
}

export interface KeyDeclaration {
    key: string;
    file: string;
    line: number;
    /** Text of the declared type, e.g. `FireTimer` or `true`. */
    type: string;
}

export interface KeyReport {
    key: string;
    declaredIn: string;
    declaredType: string;
    counts: { readers: number; writers: number; adders: number; removers: number };
    readers: UsageSite[];
    writers: UsageSite[];
    adders: UsageSite[];
    removers: UsageSite[];
}

export interface UnresolvedSite {
    file: string;
    line: number;
    fn: string;
    text: string;
    reason: string;
}

export interface CensusResult {
    filesAnalysed: number;
    filesSkipped: number;
    truncated: boolean;
    keysDeclared: number;
    /** Declared, and something reads it, but nothing writes, adds or assigns it. */
    readWithoutWriter: KeyReport[];
    /** Declared and not referenced anywhere at all. */
    declaredNeverUsed: KeyDeclaration[];
    /** Declared, written or added, but nothing ever reads it. */
    writtenNeverRead: KeyReport[];
    keys: KeyReport[];
    /** Key arguments the parser could see but not resolve to a name — the census is blind to these. */
    unresolved: UnresolvedSite[];
    /** Object literals in an entity position carrying a property that is not a declared key. */
    suspectEntityLiteralProperties: UnresolvedSite[];
    /** Local functions that forward a `keyof Entity` parameter, and the effect inferred for each. */
    wrappers: { name: string; file: string; parameter: string; effects: UsageKind[] }[];
    parseErrors: { file: string; message: string }[];
    limits: string[];
}

const MAX_TEXT = 120;

/**
 * Method/function names whose string arguments name a component key, and what calling them means.
 * A Map, not an object: a callee named `toString` or `constructor` would otherwise hit
 * Object.prototype and come back as a match.
 */
const CALL_EFFECTS = new Map<string, { keyArgs: number[] | 'all'; kind: UsageKind }>([
    ['add', { keyArgs: [1], kind: 'add' }],
    ['addComponent', { keyArgs: [1], kind: 'add' }],
    ['remove', { keyArgs: [1], kind: 'remove' }],
    ['removeComponent', { keyArgs: [1], kind: 'remove' }],
    ['with', { keyArgs: 'all', kind: 'query' }],
    ['without', { keyArgs: 'all', kind: 'query' }],
    ['singletonOf', { keyArgs: [1], kind: 'query' }],
]);

/** Names whose single object-literal argument is an entity being assembled. */
const ENTITY_LITERAL_CALLS = new Set(['add', 'spawn']);

const LIMITS: string[] = [
    'Structural analysis only: no type checker runs, so a key is recognised by its name, not by proof that the receiver is an Entity.',
    'Accesses on `this` are skipped — `this.node` in a cc.Component is the engine node, not the `node` component. An EC class that stored a component on itself is therefore invisible.',
    'A local holding a component reads as an entity: `bullet.damage` on a Projectile counts as a read of the `damage` component. Nesting is caught (`entity.contact.damage` is not), a bare local is not.',
    'A component key handed around as a value (a variable, a computed key, a spread) is reported under `unresolved` instead of being guessed.',
    'A wrapper is matched by function name across the whole scanned set; two same-named local functions are treated as one.',
    'Despawn removes every component at once and is not counted as a per-key remover.',
    'A method call that mutates a component in place (`entity.key.list.push(x)`) reads as a read, not a write.',
];

function truncate(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Nearest enclosing named function, method or class — what a reader wants to see next to a site. */
function enclosingName(node: ts.Node): string {
    let current: ts.Node | undefined = node;
    while (current) {
        if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
        if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text;
        if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && current.parent) {
            const owner = current.parent;
            if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
            if (ts.isPropertyAssignment(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
        }
        if (ts.isClassDeclaration(current) && current.name) return current.name.text;
        current = current.parent;
    }
    return '<module>';
}

function stripWrappers(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
        current = current.expression;
    }
    return current;
}

/** The property name a receiver expression ends in, so `entity.cameraRig.node` can tell that `node` is a field. */
function receiverTailName(expression: ts.Expression): string | null {
    const target = stripWrappers(expression);
    if (ts.isPropertyAccessExpression(target)) return target.name.text;
    if (ts.isElementAccessExpression(target) && target.argumentExpression && ts.isStringLiteralLike(target.argumentExpression)) {
        return target.argumentExpression.text;
    }
    return null;
}

/** The name a call targets: `commands.add` -> `add`, `singletonOf(...)` -> `singletonOf`. */
function calleeName(call: ts.CallExpression): string | null {
    const callee = stripWrappers(call.expression);
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isIdentifier(callee)) return callee.text;
    return null;
}

type ChainOutcome = { assigned: boolean; deleted: boolean; depth: number };

/**
 * Walk up from an access to find out what is ultimately done to it. `depth` counts the member
 * hops taken on the way, which is what separates `entity.key = v` (depth 0) from
 * `entity.key.field = v` (depth 1).
 */
function chainOutcome(access: ts.Node): ChainOutcome {
    let current: ts.Node = access;
    let depth = 0;
    for (;;) {
        const parent: ts.Node | undefined = current.parent;
        if (!parent) return { assigned: false, deleted: false, depth };
        if (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
            current = parent;
            continue;
        }
        if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === current) {
            current = parent;
            depth += 1;
            continue;
        }
        if (ts.isDeleteExpression(parent)) return { assigned: false, deleted: true, depth };
        if (ts.isBinaryExpression(parent) && parent.left === current && isAssignmentOperator(parent.operatorToken.kind)) {
            return { assigned: true, deleted: false, depth };
        }
        if ((ts.isPostfixUnaryExpression(parent) || ts.isPrefixUnaryExpression(parent)) &&
            (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken)) {
            return { assigned: true, deleted: false, depth };
        }
        return { assigned: false, deleted: false, depth };
    }
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
    return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

interface WrapperInfo {
    name: string;
    file: string;
    parameter: string;
    parameterIndex: number;
    effects: Set<UsageKind>;
}

/** `const STRIPPED_ON_DEATH = ['seeking', 'attacking'] as const` — module-level key lists, by name. */
function collectKeyArrays(sourceFile: ts.SourceFile): Map<string, string[]> {
    const arrays = new Map<string, string[]>();
    for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
            if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
            const initializer = stripWrappers(declaration.initializer);
            if (!ts.isArrayLiteralExpression(initializer)) continue;
            const literals = initializer.elements.filter(ts.isStringLiteralLike).map((element) => element.text);
            if (literals.length === initializer.elements.length && literals.length > 0) {
                arrays.set(declaration.name.text, literals);
            }
        }
    }
    return arrays;
}

/** The declared keys of `interface Entity`, wherever it is declared or augmented. */
export function collectKeys(sources: CensusSource[]): KeyDeclaration[] {
    const declarations: KeyDeclaration[] = [];
    for (const source of sources) {
        const sourceFile = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2017, true, ts.ScriptKind.TS);
        const visit = (node: ts.Node): void => {
            if (ts.isInterfaceDeclaration(node) && node.name.text === 'Entity') {
                for (const member of node.members) {
                    if (!ts.isPropertySignature(member)) continue;
                    const name = ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name) ? member.name.text : null;
                    if (!name) continue;
                    declarations.push({
                        key: name,
                        file: source.path,
                        line: lineOf(sourceFile, member),
                        type: member.type ? truncate(member.type.getText(sourceFile)) : 'unknown',
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
    }
    return declarations;
}

/**
 * Functions that take a component key as a parameter and forward it — `claim(world, entity, key, …)`
 * in the kit's assembly. Without these, the only adder of a key can be a call the census does not
 * recognise, and the key looks read-without-writer when it is not.
 */
function collectWrappers(parsed: { source: CensusSource; sourceFile: ts.SourceFile }[]): Map<string, WrapperInfo> {
    const wrappers = new Map<string, WrapperInfo>();
    const candidates: { info: WrapperInfo; body: ts.Node; sourceFile: ts.SourceFile }[] = [];

    for (const { source, sourceFile } of parsed) {
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
                const name = functionNameOf(node);
                if (name && node.body) {
                    const keyTypeNames = new Set<string>();
                    for (const typeParameter of node.typeParameters ?? []) {
                        if (typeParameter.constraint && /keyof\s+Entity/.test(typeParameter.constraint.getText(sourceFile))) {
                            keyTypeNames.add(typeParameter.name.text);
                        }
                    }
                    node.parameters.forEach((parameter, index) => {
                        if (!parameter.type || !ts.isIdentifier(parameter.name)) return;
                        const typeText = parameter.type.getText(sourceFile);
                        const isKeyParameter = /keyof\s+Entity/.test(typeText) || keyTypeNames.has(typeText);
                        if (!isKeyParameter) return;
                        const info: WrapperInfo = {
                            name,
                            file: source.path,
                            parameter: parameter.name.text,
                            parameterIndex: index,
                            effects: new Set<UsageKind>(),
                        };
                        wrappers.set(name, info);
                        candidates.push({ info, body: node.body!, sourceFile });
                    });
                }
            }
            ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile, visit);
    }

    // A wrapper may forward into another wrapper, so effects settle by iteration rather than one pass.
    for (let round = 0; round < 4; round += 1) {
        let changed = false;
        for (const candidate of candidates) {
            const before = candidate.info.effects.size;
            collectParameterEffects(candidate.body, candidate.sourceFile, candidate.info, wrappers);
            if (candidate.info.effects.size !== before) changed = true;
        }
        if (!changed) break;
    }
    return wrappers;
}

function functionNameOf(node: ts.FunctionLikeDeclaration): string | null {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && ts.isIdentifier(node.name)) return node.name.text;
    const owner = node.parent;
    if (owner && ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) return owner.name.text;
    return null;
}

function collectParameterEffects(body: ts.Node, sourceFile: ts.SourceFile, info: WrapperInfo, wrappers: Map<string, WrapperInfo>): void {
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === info.parameter) {
            const parent = node.parent;
            if (parent && ts.isCallExpression(parent)) {
                const index = parent.arguments.indexOf(node as ts.Expression);
                if (index >= 0) {
                    const name = calleeName(parent);
                    const builtin = name ? CALL_EFFECTS.get(name) : undefined;
                    if (builtin && (builtin.keyArgs === 'all' || builtin.keyArgs.includes(index))) info.effects.add(builtin.kind);
                    const nested = name ? wrappers.get(name) : undefined;
                    if (nested && nested !== info && nested.parameterIndex === index) {
                        for (const effect of nested.effects) info.effects.add(effect);
                    }
                }
            }
            if (parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
                const outcome = chainOutcome(parent);
                if (outcome.deleted) info.effects.add('remove');
                else if (outcome.assigned) info.effects.add(outcome.depth === 0 ? 'set' : 'fieldWrite');
                else info.effects.add('read');
            }
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
}

export interface CensusOptions {
    /** Report one key only; the flag lists still consider it alone. */
    keyFilter?: string;
    /** Files the caller refused to read, so the payload can say the census is partial. */
    filesSkipped?: number;
    truncated?: boolean;
}

export function runCensus(sources: CensusSource[], options: CensusOptions = {}): CensusResult {
    const parsed: { source: CensusSource; sourceFile: ts.SourceFile }[] = [];
    const parseErrors: { file: string; message: string }[] = [];

    for (const source of sources) {
        try {
            parsed.push({
                source,
                sourceFile: ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ES2017, true, ts.ScriptKind.TS),
            });
        } catch (err: any) {
            parseErrors.push({ file: source.path, message: err?.message || String(err) });
        }
    }

    const declarations = collectKeys(sources);
    const universe = new Set(declarations.map((declaration) => declaration.key));
    const wrappers = collectWrappers(parsed);

    const sites = new Map<string, UsageSite[]>();
    for (const key of universe) sites.set(key, []);
    const unresolved: UnresolvedSite[] = [];
    const suspect: UnresolvedSite[] = [];

    // One source position is one site: `singletonOf` is both a known call and a local wrapper, and
    // without this it would report the same line twice.
    const seen = new Set<string>();
    const record = (key: string, site: UsageSite): void => {
        const list = sites.get(key);
        if (!list) return;
        const identity = `${key}|${site.file}|${site.line}|${site.kind}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        list.push(site);
    };

    for (const { source, sourceFile } of parsed) {
        const keyArrays = collectKeyArrays(sourceFile);

        /** A key argument as written: a literal, or a named list of literals, or nothing we can name. */
        const resolveKeyArgument = (argument: ts.Expression): { keys: string[]; unresolvedReason: string | null } => {
            const target = stripWrappers(argument);
            if (ts.isStringLiteralLike(target)) return { keys: [target.text], unresolvedReason: null };
            if (ts.isIdentifier(target) && keyArrays.has(target.text)) {
                return { keys: keyArrays.get(target.text)!, unresolvedReason: null };
            }
            if (ts.isElementAccessExpression(target)) {
                const base = stripWrappers(target.expression);
                if (ts.isIdentifier(base) && keyArrays.has(base.text)) {
                    return { keys: keyArrays.get(base.text)!, unresolvedReason: null };
                }
            }
            return { keys: [], unresolvedReason: 'key argument is not a literal or a local list of literals' };
        };

        const visit = (node: ts.Node): void => {
            if (ts.isPropertyAccessExpression(node) && universe.has(node.name.text)) {
                const receiver = stripWrappers(node.expression);
                const isThis = receiver.kind === ts.SyntaxKind.ThisKeyword || receiver.kind === ts.SyntaxKind.SuperKeyword;
                const tail = receiverTailName(node.expression);
                const receiverIsComponent = tail !== null && universe.has(tail);
                if (!isThis && !receiverIsComponent) {
                    const outcome = chainOutcome(node);
                    let kind: UsageKind;
                    if (outcome.deleted && outcome.depth === 0) kind = 'remove';
                    else if (outcome.assigned) kind = outcome.depth === 0 ? 'set' : 'fieldWrite';
                    else if (outcome.deleted) kind = 'fieldWrite';
                    else kind = 'read';
                    record(node.name.text, {
                        file: source.path,
                        line: lineOf(sourceFile, node),
                        kind,
                        fn: enclosingName(node),
                        text: truncate(node.getText(sourceFile)),
                    });
                }
            }

            if (ts.isCallExpression(node)) {
                const name = calleeName(node);
                const builtin = name ? CALL_EFFECTS.get(name) : undefined;
                const wrapper = name ? wrappers.get(name) : undefined;

                const consider = (index: number, kinds: UsageKind[], viaWrapper?: string): void => {
                    const argument = node.arguments[index];
                    if (!argument) return;
                    const resolved = resolveKeyArgument(argument);
                    if (resolved.unresolvedReason) {
                        if (ts.isStringLiteralLike(argument) || ts.isIdentifier(stripWrappers(argument)) || ts.isElementAccessExpression(stripWrappers(argument))) {
                            unresolved.push({
                                file: source.path,
                                line: lineOf(sourceFile, node),
                                fn: enclosingName(node),
                                text: truncate(node.getText(sourceFile)),
                                reason: resolved.unresolvedReason,
                            });
                        }
                        return;
                    }
                    for (const key of resolved.keys) {
                        if (!universe.has(key)) continue;
                        for (const kind of kinds) {
                            record(key, {
                                file: source.path,
                                line: lineOf(sourceFile, node),
                                kind,
                                fn: enclosingName(node),
                                text: truncate(node.getText(sourceFile)),
                                ...(viaWrapper ? { viaWrapper } : {}),
                            });
                        }
                    }
                };

                if (builtin) {
                    if (builtin.keyArgs === 'all') node.arguments.forEach((_, index) => consider(index, [builtin.kind]));
                    else for (const index of builtin.keyArgs) consider(index, [builtin.kind]);
                }
                if (!builtin && wrapper && wrapper.effects.size > 0) {
                    consider(wrapper.parameterIndex, [...wrapper.effects], `${wrapper.name}()`);
                }
                if (name && ENTITY_LITERAL_CALLS.has(name) && node.arguments.length === 1) {
                    const argument = stripWrappers(node.arguments[0]);
                    if (ts.isObjectLiteralExpression(argument)) recordEntityLiteral(argument);
                }
            }

            if (ts.isObjectLiteralExpression(node) && isEntityTypedPosition(node, sourceFile)) recordEntityLiteral(node);

            if (ts.isObjectBindingPattern(node) && isEntityTypedBinding(node, sourceFile)) {
                for (const element of node.elements) {
                    const name = element.propertyName ?? element.name;
                    if (!ts.isIdentifier(name) || !universe.has(name.text)) continue;
                    record(name.text, {
                        file: source.path,
                        line: lineOf(sourceFile, element),
                        kind: 'read',
                        fn: enclosingName(node),
                        text: truncate(node.getText(sourceFile)),
                    });
                }
            }

            ts.forEachChild(node, visit);
        };

        const recordEntityLiteral = (literal: ts.ObjectLiteralExpression): void => {
            for (const property of literal.properties) {
                if (ts.isSpreadAssignment(property)) {
                    unresolved.push({
                        file: source.path,
                        line: lineOf(sourceFile, property),
                        fn: enclosingName(property),
                        text: truncate(property.getText(sourceFile)),
                        reason: 'spread into an entity literal — its keys are not visible here',
                    });
                    continue;
                }
                const name = property.name;
                if (!name || !(ts.isIdentifier(name) || ts.isStringLiteralLike(name))) continue;
                if (!universe.has(name.text)) {
                    suspect.push({
                        file: source.path,
                        line: lineOf(sourceFile, property),
                        fn: enclosingName(property),
                        text: truncate(property.getText(sourceFile)),
                        reason: `"${name.text}" is not a declared Entity key`,
                    });
                    continue;
                }
                record(name.text, {
                    file: source.path,
                    line: lineOf(sourceFile, property),
                    kind: 'add',
                    fn: enclosingName(property),
                    text: truncate(property.getText(sourceFile)),
                });
            }
        };

        ts.forEachChild(sourceFile, visit);
    }

    const declarationOf = new Map<string, KeyDeclaration>();
    for (const declaration of declarations) if (!declarationOf.has(declaration.key)) declarationOf.set(declaration.key, declaration);

    const reports: KeyReport[] = [];
    for (const declaration of declarations) {
        if (declarationOf.get(declaration.key) !== declaration) continue;
        if (options.keyFilter && declaration.key !== options.keyFilter) continue;
        const all = sites.get(declaration.key) ?? [];
        const readers = all.filter((site) => site.kind === 'read' || site.kind === 'query');
        const writers = all.filter((site) => site.kind === 'set' || site.kind === 'fieldWrite');
        const adders = all.filter((site) => site.kind === 'add');
        const removers = all.filter((site) => site.kind === 'remove');
        reports.push({
            key: declaration.key,
            declaredIn: `${declaration.file}:${declaration.line}`,
            declaredType: declaration.type,
            counts: { readers: readers.length, writers: writers.length, adders: adders.length, removers: removers.length },
            readers,
            writers,
            adders,
            removers,
        });
    }
    reports.sort((a, b) => a.key.localeCompare(b.key));

    const readWithoutWriter = reports.filter((report) => report.counts.readers > 0 && report.counts.writers === 0 && report.counts.adders === 0);
    const writtenNeverRead = reports.filter((report) => report.counts.readers === 0 && (report.counts.writers > 0 || report.counts.adders > 0));
    const declaredNeverUsed = reports
        .filter((report) => report.counts.readers === 0 && report.counts.writers === 0 && report.counts.adders === 0 && report.counts.removers === 0)
        .map((report) => declarationOf.get(report.key)!);

    return {
        filesAnalysed: parsed.length,
        filesSkipped: options.filesSkipped ?? 0,
        truncated: options.truncated === true,
        keysDeclared: universe.size,
        readWithoutWriter,
        declaredNeverUsed,
        writtenNeverRead,
        keys: reports,
        unresolved,
        suspectEntityLiteralProperties: suspect,
        wrappers: [...wrappers.values()].map((wrapper) => ({
            name: wrapper.name,
            file: wrapper.file,
            parameter: wrapper.parameter,
            effects: [...wrapper.effects],
        })),
        parseErrors,
        limits: LIMITS,
    };
}

/** `const entity: Entity = { … }`, `x as Entity`, or a literal returned from a function typed Entity. */
function isEntityTypedPosition(literal: ts.ObjectLiteralExpression, sourceFile: ts.SourceFile): boolean {
    let current: ts.Node = literal;
    let parent = current.parent;
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isNonNullExpression(parent))) {
        current = parent;
        parent = parent.parent;
    }
    if (!parent) return false;
    if ((ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === current) {
        return /\bEntity\b/.test(parent.type.getText(sourceFile));
    }
    if (ts.isVariableDeclaration(parent) && parent.initializer === current && parent.type) {
        return /\bEntity\b/.test(parent.type.getText(sourceFile));
    }
    if (ts.isReturnStatement(parent)) {
        const owner = enclosingFunction(parent);
        return !!owner && !!owner.type && /\bEntity\b/.test(owner.type.getText(sourceFile));
    }
    return false;
}

function isEntityTypedBinding(pattern: ts.ObjectBindingPattern, sourceFile: ts.SourceFile): boolean {
    const parent = pattern.parent;
    if (!parent) return false;
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) {
        return !!parent.type && /\bEntity\b/.test(parent.type.getText(sourceFile));
    }
    return false;
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
    let current: ts.Node | undefined = node.parent;
    while (current) {
        if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            return current;
        }
        current = current.parent;
    }
    return null;
}
