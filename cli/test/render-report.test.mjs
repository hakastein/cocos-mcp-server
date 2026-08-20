import test from 'node:test';
import assert from 'node:assert/strict';

import { renderWriteReport, writeVerdict } from '../lib/render/report.js';

const write = (report = {}, over = {}) => ({
    component: 'Sprite',
    property: 'color',
    report: { written: true, verified: true, persisted: true, channel: 'editor', ...report },
    ...over
});

test('удачная проверенная запись — одна строка с ok', () => {
    const text = renderWriteReport(write({}, { value: '#ffffff' }));
    assert.match(text, /^ok/);
    assert.match(text, /Sprite\.color/);
    assert.match(text, /persisted=true/);
});

test('persisted=null печатается как unknown, а не как false', () => {
    const text = renderWriteReport(write({ persisted: null }));
    assert.match(text, /persisted=unknown/);
    assert.doesNotMatch(text, /persisted=false/);
});

test('persisted=false на канале editor — это потеря значения при сохранении', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'editor' }));
    assert.match(text, /persisted=false/);
    assert.match(text, /editor/);
});

// Первое слово читают все, хвост строки не читает никто: запись, которую сохранение уронит,
// не имеет права начинаться с ok, даже когда read-back её подтвердил.
test('проверенная запись, которую сохранение уронит, называется UNPERSISTED', () => {
    const text = renderWriteReport(write({ verified: true, persisted: false, channel: 'editor' }));
    assert.equal(text.split('  ')[0], 'UNPERSISTED');
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: false, channel: 'editor' }),
        'UNPERSISTED');
});

test('на канале live persisted=false исходом не считается — там нечему сериализоваться', () => {
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: false, channel: 'live' }), 'ok');
});

test('непроверенное сохранение исходом не считается: никто не смотрел', () => {
    assert.equal(
        writeVerdict({ written: true, verified: true, persisted: null, channel: 'editor' }), 'ok');
});

test('незаписанное — FAILED в любом случае', () => {
    assert.equal(writeVerdict({ written: false, verified: false, persisted: null }), 'FAILED');
});

test('запись, которую не подтвердило обратное чтение, — UNVERIFIED, а не ok и не FAILED', () => {
    const report = { written: true, verified: false, persisted: null, channel: 'editor' };
    assert.equal(writeVerdict(report), 'UNVERIFIED');
    assert.equal(renderWriteReport(write(report)).split('  ')[0], 'UNVERIFIED');
});

test('persisted=false на канале live — ожидаемое состояние, а не дефект', () => {
    const text = renderWriteReport(write({ persisted: false, channel: 'live' }));
    assert.match(text, /live/);
    assert.match(text, /ожид|норм/i);
});

test('канал, которого отчёт не назвал, печатается как unknown', () => {
    const text = renderWriteReport(write({ channel: undefined }));
    assert.match(text, /channel=unknown/);
});

test('незаписанное значение не выдаётся за ok', () => {
    const text = renderWriteReport(write({ written: false, verified: false, persisted: null }));
    assert.doesNotMatch(text, /^ok/);
});

test('записанное, но не проверенное — не то же самое, что не записанное', () => {
    const written = renderWriteReport(write({ written: true, verified: false, persisted: null }));
    const notWritten = renderWriteReport(write({ written: false, verified: false, persisted: null }));
    assert.equal(written.split('  ')[0], 'UNVERIFIED');
    assert.equal(notWritten.split('  ')[0], 'FAILED');
});

test('detail из отчёта доезжает до строки', () => {
    const text = renderWriteReport(write({ detail: 'сериализатор не отдаёт это свойство' }));
    assert.match(text, /сериализатор не отдаёт/);
});

test('отметка про undo попадает в строку, когда редактор не записал шаг', () => {
    const text = renderWriteReport(write({}, { undoNote: 'редактор оставил скобку открытой' }));
    assert.match(text, /скобку открытой/);
});
