import test from 'node:test';
import assert from 'node:assert/strict';

import { present } from '../lib/render/present.js';
import { verdictFailed } from '../lib/render/verdict.js';

// Ради этой таблицы и заводится закрытый набор: код выхода решается один раз здесь, а не
// пересобирается в каждом теле команды.
test('нулём выходят ровно ok и UNVERIFIED', () => {
    assert.equal(verdictFailed('ok'), false);
    assert.equal(verdictFailed('UNVERIFIED'), false);
    assert.equal(verdictFailed('UNPERSISTED'), true);
    assert.equal(verdictFailed('FAILED'), true);
    assert.equal(verdictFailed('TIMEOUT'), true);
});

test('исход начинается со своего вердикта, а хвост остаётся свободным текстом', () => {
    const output = present({ kind: 'action', verdict: 'FAILED', summary: 'Guard не перенесён' });
    assert.equal(output.stdout, 'FAILED  Guard не перенесён');
    assert.equal(output.failed, true);
});

test('пустая заметка не превращается в пустую строку на stderr', () => {
    assert.equal(present({ kind: 'action', verdict: 'ok', summary: 'сцена сохранена' }).stderr, undefined);
});

const writeReport = (over = {}) => ({
    kind: 'propertyWrite',
    component: 'cc.Sprite',
    property: 'color',
    value: '#ffffff',
    report: { written: true, verified: true, persisted: true, channel: 'editor', ...over }
});

// Вердикт вычисляется из данных отчёта: команда его не передаёт и, значит, не может разойтись
// с тем, что напечатано.
test('запись, которую сохранение уронит, получает UNPERSISTED и единицу', () => {
    const output = present(writeReport({ persisted: false }));
    assert.equal(output.stdout.split('  ')[0], 'UNPERSISTED');
    assert.equal(output.failed, true);
});

test('на канале live persisted=false остаётся ok', () => {
    const output = present(writeReport({ persisted: false, channel: 'live' }));
    assert.equal(output.stdout.split('  ')[0], 'ok');
    assert.equal(output.failed, false);
});

const settle = (over = {}) => ({
    kind: 'assetSettle',
    settle: {
        action: 'обновлено', target: 'db://assets/f', elapsedMs: 60000, settled: true,
        assets: { added: [], removed: [], changed: [] }, classes: { added: [], removed: [] }, ...over
    },
    timeoutMs: 60000
});

test('база, не улёгшаяся за таймаут, — TIMEOUT с единицей', () => {
    const output = present(settle({ settled: false }));
    assert.equal(output.stdout.split('  ')[0], 'TIMEOUT');
    assert.equal(output.failed, true);
    assert.match(output.stderr, /60с/);
});

test('заметка команды приезжает к заметке об ожидании, а не вместо неё', () => {
    const output = present({ ...settle({ classes: null }), note: 'db://-пути внутри .meta не переезжают' });
    assert.match(output.stderr, /дельта неизвестна/);
    assert.match(output.stderr, /\.meta не переезжают/);
});

const ASSET = { name: 'rifle', type: 'cc.Prefab', uuid: 'u-1', url: 'db://assets/rifle.prefab' };

test('--json печатает структурную форму вместо текста', () => {
    const output = present({ kind: 'assetInfo', asset: ASSET }, { json: true });
    assert.deepEqual(JSON.parse(output.stdout), ASSET);
});

// `--field` существует ради подстановки в переменную оболочки, и обёртка в JSON её ломает.
test('--field перебивает --json и отдаёт голое значение', () => {
    const output = present({ kind: 'assetInfo', asset: ASSET, field: 'uuid' }, { json: true });
    assert.equal(output.stdout, 'u-1');
});

test('--json на отчёте без структурной формы отдаёт тот же текст, а не пустоту', () => {
    const output = present({ kind: 'action', verdict: 'ok', summary: 'удалён Canvas/Bg' }, { json: true });
    assert.equal(output.stdout, 'ok  удалён Canvas/Bg');
});

const missing = (entries) => ({ kind: 'sceneMissing', missing: { entries } });

test('мёртвый компонент в сцене — исход, а не спокойный отчёт', () => {
    const found = present(missing([{ nodePath: 'a', nodeUuid: 'u', componentUuid: 'c', cid: null }]));
    assert.equal(found.failed, true);
    assert.match(found.stderr, /^FAILED/);
    assert.equal(present(missing([])).failed, false);
});

const reading = (over = {}) => ({
    name: 'target', type: 'cc.Node', kind: 'nodeRef', value: 'u-hero', label: null,
    differsFromDefault: false, hiddenInInspector: false, ...over
});

const address = {
    nodePath: 'Canvas/Bg', nodeUuid: 'u-bg',
    choice: { index: 0, className: 'Npc', cid: null, enabled: true, sameClassCount: 1 }
};

test('ссылка печатается именем узла, а не голым uuid, когда индекс его знает', () => {
    const output = present({
        kind: 'componentProperty',
        address,
        reading: reading(),
        references: new Map([['u-hero', { kind: 'node', path: 'Characters/hero' }]])
    });
    assert.match(output.stdout, /Characters\/hero {2}u-hero/);
    assert.match(output.stderr, /Npc\.target {2}cc\.Node/);
});

test('свойство, разошедшееся с умолчанием, названо в пояснении', () => {
    const output = present({
        kind: 'componentProperty',
        address,
        reading: reading({ differsFromDefault: true }),
        references: new Map()
    });
    assert.match(output.stderr, /отличается от умолчания/);
});

test('скрытые свойства и число прочитанных доезжают до пояснения', () => {
    const output = present({
        kind: 'componentProperties',
        address,
        readings: [reading(), reading({ name: 'speed', type: 'Number', kind: 'scalar', value: 3 })],
        hidden: ['_id'],
        references: new Map()
    });
    assert.match(output.stderr, /свойств: 2/);
    assert.match(output.stderr, /скрыто: 1/);
});
