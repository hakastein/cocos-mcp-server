import { z } from 'zod';
import { booleanArg, defineTool } from '../tool';
import { ok, fail } from '../result';
import { textOf } from './shared';
import { runPlan, validatePlan } from '../batch-plan';
import type { BatchDispatch } from '../batch-plan';
import type { RegisteredTool } from '../tool';

const call = z.object({
    tool: z.string().describe('Full tool name, e.g. "node_set_node_property"'),
    args: z.record(z.unknown()).optional()
        .describe('Arguments, may contain {{index_or_label.path}} tokens'),
    label: z.string().optional().describe('Name this call so later ones can reference it')
});

export const batchRun = (dispatch: BatchDispatch): RegisteredTool => defineTool({
    name: 'batch_run',
    description: 'Execute a list of tool calls in one request, in order. Each entry is '
        + '{tool, args, label?} where tool is a full name like "component_add_component". '
        + 'Any string in args may reference an EARLIER call\'s result with a {{...}} token: '
        + '{{0.data.nodeUuid}} by index or {{spawn.data.nodeUuid}} by label — a lone token keeps '
        + 'the value\'s type, so you can chain create-then-configure without a round trip in '
        + 'between. Each call\'s arguments are resolved when its turn comes, so a node created by '
        + 'an earlier call is addressable by its scene path in a later one. Stops at the first '
        + 'failure unless stopOnError is false; remaining calls are reported as skipped. Batches '
        + 'cannot nest.',
    schema: z.object({
        calls: z.array(call).describe('Tool calls to run in order'),
        stopOnError: booleanArg.optional().describe('Halt at the first failing call (default true)')
    }),
    async handler(args) {
        let plan;
        try {
            plan = validatePlan(args.calls);
        } catch (error) {
            return fail('invalid_plan', textOf(error));
        }

        const report = await runPlan(plan, dispatch, args.stopOnError !== false);
        if (!report.failed) {
            return ok(report, `${report.succeeded} of ${report.total} calls succeeded`);
        }
        return fail(
            'batch_failed',
            `${report.failed} of ${report.total} call(s) failed`
                + (report.skipped ? `, ${report.skipped} skipped after the halt` : ''),
            'Every call\'s own outcome is in data.results, in plan order.',
            report
        );
    }
});

export const batchTools = (dispatch: BatchDispatch): RegisteredTool[] => [batchRun(dispatch)];
