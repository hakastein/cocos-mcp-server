import test from 'node:test';
import assert from 'node:assert/strict';

import * as r from '../src/render/node.ts';

const { renderNodeWrite, nodeWriteVerdict, nodeWriteNote } = r;

const report = (over = {}) => ({
    target: 'Environment/Guard', applied: [], warnings: [], nodeType: '3d', ...over
});

test('a write that landed leads with ok and names what it wrote', () => {
    const text = renderNodeWrite(report({
        applied: [{ property: 'name', value: 'Sentry' }, { property: 'position', value: { x: 1, y: 2, z: 3 } }]
    }));
    assert.equal(text.split('  ')[0], 'ok');
    assert.match(text, /name="Sentry"/);
    assert.match(text, /position=\{"x":1,"y":2,"z":3\}/);
    assert.match(text, /undo=1/);
});

test('a write the node did not take leads with its own word, not ok with a caveat', () => {
    const text = renderNodeWrite(report({
        unapplied: { property: 'active', expected: false, observed: true }
    }));
    assert.equal(text.split('  ')[0], 'FAILED');
    assert.match(text, /still answers true/);
});

test('a failed write names what did land before it, so the node is not left a mystery', () => {
    const text = renderNodeWrite(report({
        applied: [{ property: 'name', value: 'Sentry' }],
        unapplied: { property: 'active', expected: false, observed: true }
    }));
    assert.match(text, /already landed: name/);
});

test('nothing asked for is said out loud rather than passing for a write that landed', () => {
    assert.equal(renderNodeWrite(report()), 'ok  Environment/Guard  nothing to write');
});

test('an undo note replaces the assumed single step instead of sitting beside it', () => {
    const text = renderNodeWrite(report({
        applied: [{ property: 'name', value: 'x' }], undoNote: 'the editor did not record the step'
    }));
    assert.match(text, /the editor did not record the step/);
    assert.equal(/undo=1/.test(text), false);
});

test('the verdict follows the unapplied write and nothing else', () => {
    assert.equal(nodeWriteVerdict(report({ applied: [{ property: 'name', value: 'x' }] })), 'ok');
    assert.equal(nodeWriteVerdict(report({ warnings: ['2D node: z zeroed'] })), 'ok');
    assert.equal(
        nodeWriteVerdict(report({ unapplied: { property: 'name', expected: 1, observed: 2 } })),
        'FAILED');
});

test('a zeroed axis reaches the note, where a silently ruined transform would otherwise read as ok', () => {
    assert.equal(nodeWriteNote(report({ warnings: ['2D node: position z was 4 and this write zeroes it'] })),
        '2D node: position z was 4 and this write zeroes it');
    assert.equal(nodeWriteNote(report()), '');
});
