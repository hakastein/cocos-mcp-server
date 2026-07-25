import { ToolDefinition, ToolResponse, ToolExecutor } from '../types';
import { resolveArgs, validatePlan, PriorResult } from '../batch-plan';

export type BatchDispatch = (toolName: string, args: any) => Promise<any>;

/**
 * Runs many tool calls in one MCP round trip. Repetitive scene/prefab surgery (add the same
 * component to twelve nodes, then wire each one) otherwise costs one round trip per call.
 */
export class BatchTools implements ToolExecutor {
    private dispatch?: BatchDispatch;

    constructor(dispatch?: BatchDispatch) {
        this.dispatch = dispatch;
    }

    getTools(): ToolDefinition[] {
        return [
            {
                name: 'run',
                description: 'Execute a list of tool calls in one request, in order. Each entry is ' +
                    '{tool, args, label?} where tool is a full name like "component_add_component". ' +
                    'Any string in args may reference an EARLIER call\'s result with a {{...}} token: ' +
                    '{{0.data.nodeUuid}} by index or {{spawn.data.nodeUuid}} by label — a lone token keeps ' +
                    'the value\'s type, so you can chain create-then-configure without a round trip in ' +
                    'between. Stops at the first failure unless stopOnError is false; remaining calls are ' +
                    'reported as skipped. Batches cannot nest.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        calls: {
                            type: 'array',
                            description: 'Tool calls to run in order',
                            items: {
                                type: 'object',
                                properties: {
                                    tool: { type: 'string', description: 'Full tool name, e.g. "node_set_node_property"' },
                                    args: { type: 'object', description: 'Arguments, may contain {{index_or_label.path}} tokens' },
                                    label: { type: 'string', description: 'Name this call so later ones can reference it' }
                                },
                                required: ['tool']
                            }
                        },
                        stopOnError: { type: 'boolean', description: 'Halt at the first failing call (default true)' }
                    },
                    required: ['calls']
                }
            }
        ];
    }

    async execute(toolName: string, args: any): Promise<ToolResponse> {
        if (toolName !== 'run') throw new Error(`Unknown tool: ${toolName}`);
        if (!this.dispatch) {
            return { success: false, error: 'Batch dispatcher is unavailable in this context' };
        }

        let plan;
        try {
            plan = validatePlan(args && args.calls);
        } catch (err: any) {
            return { success: false, error: err.message };
        }

        const stopOnError = args.stopOnError !== false;
        const prior: PriorResult[] = [];
        const results: any[] = [];
        let succeeded = 0;
        let failed = 0;
        let halted = false;

        for (let i = 0; i < plan.length; i++) {
            const call = plan[i];
            if (halted) {
                results.push({ index: i, label: call.label, tool: call.tool, skipped: true });
                continue;
            }

            let callArgs: any;
            try {
                callArgs = resolveArgs(call.args, prior);
            } catch (err: any) {
                failed++;
                results.push({ index: i, label: call.label, tool: call.tool, success: false, error: `argument template: ${err.message}` });
                if (stopOnError) halted = true;
                continue;
            }

            try {
                const res = await this.dispatch(call.tool, callArgs);
                const ok = !(res && res.success === false);
                if (ok) succeeded++; else failed++;
                results.push({
                    index: i,
                    label: call.label,
                    tool: call.tool,
                    success: ok,
                    data: res && res.data,
                    message: res && res.message,
                    error: res && res.error
                });
                prior.push({ index: i, label: call.label, result: res });
                if (!ok && stopOnError) halted = true;
            } catch (err: any) {
                failed++;
                results.push({ index: i, label: call.label, tool: call.tool, success: false, error: err.message || String(err) });
                if (stopOnError) halted = true;
            }
        }

        const skipped = results.filter((r) => r.skipped).length;
        return {
            success: failed === 0,
            data: { total: plan.length, succeeded, failed, skipped, haltedEarly: halted, results }
        };
    }
}
