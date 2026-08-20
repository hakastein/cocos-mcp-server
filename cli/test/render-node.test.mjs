import test from 'node:test';
import assert from 'node:assert/strict';

import r from '../lib/render/node.js';

const { renderNodeWrite, nodeWriteFailed, nodeWriteNote } = r;

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
    assert.equal(text.split('  ')[0], 'НЕ ЗАПИСАНО');
    assert.match(text, /по-прежнему отвечает true/);
});

test('a failed write names what did land before it, so the node is not left a mystery', () => {
    const text = renderNodeWrite(report({
        applied: [{ property: 'name', value: 'Sentry' }],
        unapplied: { property: 'active', expected: false, observed: true }
    }));
    assert.match(text, /успело лечь: name/);
});

test('nothing asked for is said out loud rather than passing as a successful write', () => {
    assert.match(renderNodeWrite(report()), /^нечего писать/);
});

test('an undo note replaces the assumed single step instead of sitting beside it', () => {
    const text = renderNodeWrite(report({
        applied: [{ property: 'name', value: 'x' }], undoNote: 'редактор запись не принял'
    }));
    assert.match(text, /редактор запись не принял/);
    assert.equal(/undo=1/.test(text), false);
});

test('nodeWriteFailed follows the unapplied write and nothing else', () => {
    assert.equal(nodeWriteFailed(report({ applied: [{ property: 'name', value: 'x' }] })), false);
    assert.equal(nodeWriteFailed(report({ warnings: ['2D-узел: z обнулён'] })), false);
    assert.equal(nodeWriteFailed(report({ unapplied: { property: 'name', expected: 1, observed: 2 } })), true);
});

test('a zeroed axis reaches the note, where a silently ruined transform would otherwise read as ok', () => {
    assert.equal(nodeWriteNote(report({ warnings: ['2D-узел: z позиции был 4 и обнуляется'] })),
        '2D-узел: z позиции был 4 и обнуляется');
    assert.equal(nodeWriteNote(report()), '');
});
