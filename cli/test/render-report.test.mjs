import test from 'node:test';
import assert from 'node:assert/strict';

import {
    renderWriteReport, renderWrites, undoDetail, writeVerdict, writesVerdict
} from '../src/render/report.ts';
import { worstVerdict } from '../src/render/verdict.ts';

const write = (report = {}, over = {}) => ({
    target: 'Sprite',
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

test('a bracket that held is one undo step, and one that did not says what happened instead', () => {
    assert.equal(undoDetail(null), 'undo=1');
    assert.equal(undoDetail('the editor left the bracket open'), 'the editor left the bracket open');
});

test('the undo note replaces the assumed single step rather than sitting beside it', () => {
    const text = renderWrites({
        target: 'Environment/Guard', writes: [write()], undoNote: 'the editor recorded no step'
    });
    assert.match(text, /the editor recorded no step/);
    assert.doesNotMatch(text, /undo=1/);
});

const batch = (writes, undoNote = null) => renderWrites({ target: 'Environment/Guard', writes, undoNote });

test('one write is one line, with no head line repeating it', () => {
    const text = batch([write({}, { value: '#ffffff' })]);
    assert.equal(text.split('\n').length, 1);
    assert.match(text, /^ok {2}Sprite\.color = "#ffffff"/);
    assert.match(text, /undo=1$/);
});

// The whole point of the head line: `node set --name X --pos 1,2,3` where only the position is
// dropped on save used to read `ok` and exit zero.
test('several writes lead with the worst of them, not with the first', () => {
    const text = batch([
        write({}, { target: 'Environment/Guard', property: 'name', value: 'Sentry' }),
        write({ persisted: false }, { target: 'Environment/Guard', property: 'position' })
    ]);
    const lines = text.split('\n');
    assert.equal(lines[0].split('  ')[0], 'UNPERSISTED');
    assert.match(lines[0], /Environment\/Guard {2}2 writes {2}undo=1/);
    assert.match(lines[1], /^ {2}ok {2}name = "Sentry"/);
    assert.match(lines[2], /^ {2}UNPERSISTED {2}position/);
});

test('a per-write line under a head line drops the target, which the head already named', () => {
    const text = batch([
        write({}, { target: 'Environment/Guard', property: 'name' }),
        write({}, { target: 'Environment/Guard', property: 'active' })
    ]);
    assert.equal(text.split('\n').filter(line => line.includes('Environment/Guard')).length, 1);
});

test('nothing asked for is said out loud rather than passing for a write that landed', () => {
    assert.equal(batch([]), 'ok  Environment/Guard  nothing to write  undo=1');
});

test('the batch verdict is the worst write and nothing else', () => {
    assert.equal(writesVerdict([write(), write()]), 'ok');
    assert.equal(writesVerdict([write(), write({ verified: false, persisted: null })]), 'UNVERIFIED');
    assert.equal(writesVerdict([write({ persisted: false }), write({ written: false })]), 'FAILED');
    assert.equal(writesVerdict([]), 'ok');
});

test('severity puts FAILED above UNPERSISTED above UNVERIFIED above ok', () => {
    assert.equal(worstVerdict(['ok', 'UNVERIFIED']), 'UNVERIFIED');
    assert.equal(worstVerdict(['UNVERIFIED', 'UNPERSISTED']), 'UNPERSISTED');
    assert.equal(worstVerdict(['UNPERSISTED', 'TIMEOUT']), 'TIMEOUT');
    assert.equal(worstVerdict(['TIMEOUT', 'FAILED']), 'FAILED');
    assert.equal(worstVerdict([]), 'ok');
});
