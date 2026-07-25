export interface BatchCall {
    tool: string;
    args?: any;
    label?: string;
}

export interface PriorResult {
    index: number;
    label?: string;
    result: any;
}

const WHOLE_TOKEN = /^\{\{([^{}]+)\}\}$/;
const EMBEDDED_TOKEN = /\{\{([^{}]+)\}\}/g;

function lookup(prior: PriorResult[], expr: string): any {
    const parts = expr.trim().split('.');
    const head = parts[0];
    const entry = /^\d+$/.test(head)
        ? prior.find((p) => p.index === Number(head))
        : prior.find((p) => p.label === head);
    if (!entry) {
        const known = prior.map((p) => (p.label ? `${p.index}/${p.label}` : String(p.index))).join(', ') || 'none';
        throw new Error(`{{${expr}}}: no earlier call '${head}' (available: ${known})`);
    }
    let value = entry.result;
    for (const key of parts.slice(1)) {
        if (value === null || value === undefined) {
            throw new Error(`{{${expr}}}: '${key}' is unreachable, an earlier segment was null`);
        }
        value = value[key];
    }
    if (value === undefined) {
        throw new Error(`{{${expr}}}: not found in the result of call '${head}'`);
    }
    return value;
}

/** `{{0.data.nodeUuid}}` / `{{spawn.data.nodeUuid}}` — a lone token keeps the value's type. */
export function resolveArgs(args: any, prior: PriorResult[]): any {
    if (typeof args === 'string') {
        const whole = args.match(WHOLE_TOKEN);
        if (whole) return lookup(prior, whole[1]);
        return args.replace(EMBEDDED_TOKEN, (_m, expr) => String(lookup(prior, expr)));
    }
    if (Array.isArray(args)) return args.map((v) => resolveArgs(v, prior));
    if (args && typeof args === 'object') {
        const out: any = {};
        for (const key of Object.keys(args)) out[key] = resolveArgs(args[key], prior);
        return out;
    }
    return args;
}

export function validatePlan(calls: any): BatchCall[] {
    if (!Array.isArray(calls) || !calls.length) {
        throw new Error('calls must be a non-empty array of { tool, args }');
    }
    const labels = new Set<string>();
    return calls.map((call, i) => {
        if (!call || typeof call.tool !== 'string' || !call.tool) {
            throw new Error(`calls[${i}]: 'tool' must be a tool name like "component_add_component"`);
        }
        if (call.tool.startsWith('batch_')) {
            throw new Error(`calls[${i}]: a batch cannot contain another batch`);
        }
        if (call.label !== undefined) {
            if (typeof call.label !== 'string' || /^\d+$/.test(call.label)) {
                throw new Error(`calls[${i}]: 'label' must be a non-numeric string`);
            }
            if (labels.has(call.label)) throw new Error(`calls[${i}]: duplicate label '${call.label}'`);
            labels.add(call.label);
        }
        return { tool: call.tool, args: call.args || {}, label: call.label };
    });
}
