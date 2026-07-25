import test from 'node:test';
import assert from 'node:assert/strict';
import bp from '../dist/batch-plan.js';

const { resolveArgs, validatePlan } = bp;

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
