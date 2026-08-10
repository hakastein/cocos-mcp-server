import test from 'node:test';
import assert from 'node:assert/strict';
import bp from '../dist/batch-plan.js';

const { resolveArgs, validatePlan, runPlan } = bp;

const prior = [
    { index: 0, label: 'spawn', result: { success: true, data: { nodeUuid: 'abc', count: 3, tags: ['x', 'y'] } } },
    { index: 1, result: { success: true, data: { nodeUuid: 'def' } } }
];

test('a lone token keeps the resolved value type', () => {
    assert.equal(resolveArgs('{{0.data.nodeUuid}}', prior), 'abc');
    assert.equal(resolveArgs('{{0.data.count}}', prior), 3);
    assert.deepEqual(resolveArgs('{{0.data.tags}}', prior), ['x', 'y']);
});

test('labels and indices both address earlier calls', () => {
    assert.equal(resolveArgs('{{spawn.data.nodeUuid}}', prior), 'abc');
    assert.equal(resolveArgs('{{1.data.nodeUuid}}', prior), 'def');
});

test('embedded tokens interpolate into the surrounding string', () => {
    assert.equal(resolveArgs('node-{{0.data.nodeUuid}}-{{1.data.nodeUuid}}', prior), 'node-abc-def');
});

test('templates resolve inside nested objects and arrays', () => {
    const out = resolveArgs({ a: { b: ['{{0.data.nodeUuid}}', 7] }, c: 'plain' }, prior);
    assert.deepEqual(out, { a: { b: ['abc', 7] }, c: 'plain' });
});

test('untouched values pass through unchanged', () => {
    assert.equal(resolveArgs(5, prior), 5);
    assert.equal(resolveArgs(null, prior), null);
    assert.equal(resolveArgs('no tokens here', prior), 'no tokens here');
});

test('an unknown call or missing path fails loudly', () => {
    assert.throws(() => resolveArgs('{{9.data.x}}', prior), /no earlier call '9'/);
    assert.throws(() => resolveArgs('{{nope.data.x}}', prior), /no earlier call 'nope'/);
    assert.throws(() => resolveArgs('{{0.data.missing}}', prior), /not found in the result/);
});

const answering = (answer) => {
    const seen = [];
    return {
        seen,
        dispatch: async (tool, args) => {
            seen.push({ tool, args });
            return answer(tool, args);
        }
    };
};

test('a later call reads what the call before it actually returned', async () => {
    const spawned = { 'a_spawn': { success: true, data: { nodeUuid: 'u-1', count: 2 } } };
    const dispatcher = answering(async (tool) => spawned[tool] || { success: true, data: null });
    const report = await runPlan(
        validatePlan([
            { tool: 'a_spawn', label: 'spawn' },
            { tool: 'b_configure', args: { nodeUuid: '{{spawn.data.nodeUuid}}', times: '{{0.data.count}}' } }
        ]),
        dispatcher.dispatch,
        true
    );

    assert.deepEqual(dispatcher.seen[1], { tool: 'b_configure', args: { nodeUuid: 'u-1', times: 2 } });
    assert.deepEqual(report, {
        total: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
        haltedEarly: false,
        results: [
            { index: 0, label: 'spawn', tool: 'a_spawn', success: true, data: { nodeUuid: 'u-1', count: 2 }, message: undefined, error: undefined },
            { index: 1, label: undefined, tool: 'b_configure', success: true, data: null, message: undefined, error: undefined }
        ]
    });
});

test('a failing call halts the run and the calls after it are reported as skipped', async () => {
    const dispatcher = answering(async (tool) => (tool === 'b_break'
        ? { success: false, error: { code: 'no_scene', message: 'no scene is open' } }
        : { success: true, data: null }));
    const report = await runPlan(
        validatePlan([{ tool: 'a_one' }, { tool: 'b_break' }, { tool: 'c_three' }]),
        dispatcher.dispatch,
        true
    );

    assert.deepEqual(dispatcher.seen.map(call => call.tool), ['a_one', 'b_break']);
    assert.equal(report.haltedEarly, true);
    assert.deepEqual([report.succeeded, report.failed, report.skipped], [1, 1, 1]);
    assert.deepEqual(report.results[2], { index: 2, label: undefined, tool: 'c_three', skipped: true });
});

test('stopOnError false runs the whole plan', async () => {
    const dispatcher = answering(async (tool) => (tool === 'b_break'
        ? { success: false, error: { code: 'no_scene', message: 'no scene is open' } }
        : { success: true, data: null }));
    const report = await runPlan(
        validatePlan([{ tool: 'a_one' }, { tool: 'b_break' }, { tool: 'c_three' }]),
        dispatcher.dispatch,
        false
    );

    assert.deepEqual(dispatcher.seen.map(call => call.tool), ['a_one', 'b_break', 'c_three']);
    assert.deepEqual([report.succeeded, report.failed, report.skipped, report.haltedEarly], [2, 1, 0, false]);
});

test('a call whose template did not resolve is still an earlier call, and a later reference blames it', async () => {
    const dispatcher = answering(async () => ({ success: true, data: { uuid: 'u-1' } }));
    const report = await runPlan(
        validatePlan([
            { tool: 'a_spawn' },
            { tool: 'b_configure', args: { uuid: '{{0.data.absent}}' }, label: 'configure' },
            { tool: 'c_finish', args: { uuid: '{{1.data.uuid}}' } },
            { tool: 'd_finish', args: { uuid: '{{configure.data.uuid}}' } }
        ]),
        dispatcher.dispatch,
        false
    );

    assert.match(report.results[1].error, /argument template: .*not found in the result/);
    assert.match(report.results[2].error, /call '1' failed/);
    assert.match(report.results[3].error, /call 'configure' failed/);
    for (const index of [2, 3]) {
        assert.doesNotMatch(report.results[index].error, /no earlier call/);
    }
    assert.deepEqual(dispatcher.seen.map(call => call.tool), ['a_spawn']);
    assert.equal(report.failed, 3);
});

test('a call whose dispatch threw is an earlier call too', async () => {
    const dispatcher = answering(async (tool) => {
        if (tool === 'a_spawn') throw new Error('the editor said no');
        return { success: true, data: null };
    });
    const report = await runPlan(
        validatePlan([{ tool: 'a_spawn' }, { tool: 'b_configure', args: { uuid: '{{0.data.uuid}}' } }]),
        dispatcher.dispatch,
        false
    );

    assert.equal(report.results[0].error, 'the editor said no');
    assert.match(report.results[1].error, /call '0' failed/);
});

test('validatePlan normalizes calls and rejects bad plans', () => {
    const plan = validatePlan([{ tool: 'a_b' }, { tool: 'c_d', args: { x: 1 }, label: 'two' }]);
    assert.deepEqual(plan[0], { tool: 'a_b', args: {}, label: undefined });
    assert.equal(plan[1].label, 'two');

    assert.throws(() => validatePlan([]), /non-empty array/);
    assert.throws(() => validatePlan([{ args: {} }]), /'tool' must be a tool name/);
    assert.throws(() => validatePlan([{ tool: 'batch_run' }]), /cannot contain another batch/);
    assert.throws(() => validatePlan([{ tool: 'a_b', label: 'x' }, { tool: 'c_d', label: 'x' }]), /duplicate label/);
    assert.throws(() => validatePlan([{ tool: 'a_b', label: '3' }]), /non-numeric string/);
});
