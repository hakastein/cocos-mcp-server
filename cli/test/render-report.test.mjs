import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWriteReport, writeVerdict } from '../src/render/report.ts';

const write = (report = {}, over = {}) => ({
    component: 'Sprite',
    property: 'color',
    report: { written: true, verified: true, persisted: true, channel: 'editor', ...report },
    ...over
});

test('a verified write that landed is one line starting with ok', () => {
    const text = renderWriteReport(write({}, { value: '#ffffff' }));
    assert.match(text, /^ok/);
    assert.match(text, /Sprite\.color/);
    assert.match(text, /persisted=true/);
});

test('persisted=null prints as unknown rather than as false', () => {
    const text = renderWriteReport(write({ persisted: null }));
    assert.match(text, /persisted=unknown/);
    assert.doesNotMatch(text, /persisted=false/);
});

test('persisted=false on the editor channel means the value is lost on save', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'editor' }));
    assert.match(text, /persisted=false/);
    assert.match(text, /editor/);
});

// Everyone reads the first word and nobody reads the tail: a write a save will drop has no right
// to start with ok, even when the read-back confirmed it.
test('a verified write a save will drop is called UNPERSISTED', () => {
    const text = renderWriteReport(write({ verified: true, persisted: false, channel: 'editor' }));
    assert.equal(text.split('  ')[0], 'UNPERSISTED');
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: false, channel: 'editor' }),
        'UNPERSISTED');
});

test('on the live channel persisted=false is no failure — nothing there serializes', () => {
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: false, channel: 'live' }), 'ok');
});

test('unchecked persistence is no failure: nobody looked', () => {
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: null, channel: 'editor' }), 'ok');
});

test('an unwritten value is FAILED either way', () => {
    assert.equal(writeVerdict({ written: false, verified: false, persisted: null }), 'FAILED');
});

test('a write the read-back did not confirm is UNVERIFIED, neither ok nor FAILED', () => {
    const report = { written: true, verified: false, persisted: null, channel: 'editor' };
    assert.equal(writeVerdict(report), 'UNVERIFIED');
    assert.equal(renderWriteReport(write(report)).split('  ')[0], 'UNVERIFIED');
});

test('persisted=false on the live channel is the expected state, not a defect', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'live' }));
    assert.match(text, /live/);
    assert.match(text, /expected/i);
});

test('a channel the report did not name prints as unknown', () => {
    const text = renderWriteReport(write({ channel: undefined }));
    assert.match(text, /channel=unknown/);
});

test('an unwritten value is not passed off as ok', () => {
    const text = renderWriteReport(write({ written: false, verified: false, persisted: null }));
    assert.doesNotMatch(text, /^ok/);
});

test('written but unverified is not the same as never written', () => {
    const written = renderWriteReport(write({ written: true, verified: false, persisted: null }));
    const notWritten = renderWriteReport(write({ written: false, verified: false, persisted: null }));
    assert.equal(written.split('  ')[0], 'UNVERIFIED');
    assert.equal(notWritten.split('  ')[0], 'FAILED');
});

test('the report detail reaches the line', () => {
    const text = renderWriteReport(write({ detail: 'the serializer does not emit this property' }));
    assert.match(text, /the serializer does not emit/);
});

test('the undo note reaches the line when the editor did not record the step', () => {
    const text = renderWriteReport(write({}, { undoNote: 'the editor left the bracket open' }));
    assert.match(text, /left the bracket open/);
});
