import test from 'node:test';
import assert from 'node:assert/strict';

import r from '../lib/render/asset.js';

const {
    assetField, renderAssetInfo, renderAssetList, assetListSummary, renderSettleReport, settleNote,
    settleVerdict
} = r;

const asset = (over = {}) => ({
    name: 'rifle', type: 'cc.Prefab', uuid: 'u-1', url: 'db://assets/rifle.prefab',
    importer: 'prefab', imported: true, file: 'D:\\p\\rifle.prefab', ...over
});

const report = (over = {}) => ({
    action: 'обновлено', target: 'db://assets/framework', elapsedMs: 8400, settled: true,
    assets: { added: [], removed: [], changed: [] }, classes: { added: [], removed: [] }, ...over
});

test('assetField hands back one bare value, the form that goes into a shell variable', () => {
    assert.equal(assetField(asset(), 'uuid'), 'u-1');
    assert.equal(assetField(asset(), 'url'), 'db://assets/rifle.prefab');
});

test('a missing importer reads as empty rather than as the string undefined', () => {
    assert.equal(assetField(asset({ importer: undefined }), 'importer'), '');
});

test('assetField counts sub-assets instead of printing them', () => {
    assert.equal(assetField(asset({ subAssets: { a: {}, b: {} } }), 'subAssets'), '2');
    assert.equal(assetField(asset(), 'subAssets'), '0');
});

test('an unknown field names the ones that exist', () => {
    assert.throws(() => assetField(asset(), 'nope'), /importer/);
});

test('renderAssetInfo prints the uuid and drops the fields the asset does not carry', () => {
    const text = renderAssetInfo(asset({ importer: undefined, file: undefined }));
    assert.match(text, /^uuid\s+u-1$/m);
    assert.equal(/importer/.test(text), false);
    assert.equal(/file/.test(text), false);
});

test('renderAssetInfo names an invalid import, which type alone would hide', () => {
    assert.match(renderAssetInfo(asset({ invalid: true })), /^invalid\s+true$/m);
});

test('renderAssetList marks a folder with a trailing slash', () => {
    const text = renderAssetList([asset({ url: 'db://assets/weapon', isDirectory: true, type: 'database' })]);
    assert.match(text, /db:\/\/assets\/weapon\//);
});

test('renderAssetList says so rather than printing an empty string', () => {
    assert.equal(renderAssetList([]), 'ни одного ассета не подошло');
});

test('the summary distinguishes the whole set from a cut one', () => {
    assert.equal(assetListSummary(3, 3), 'ассетов: 3');
    assert.match(assetListSummary(15, 254), /254/);
    assert.match(assetListSummary(15, 254), /--max/);
});

test('an untouched database is reported as such and not as a bare ok', () => {
    assert.equal(
        renderSettleReport(report()),
        'ok  db://assets/framework  обновлено за 8.4с  без изменений');
});

test('the newly registered class is named — that is what a refresh is run for', () => {
    const text = renderSettleReport(report({
        assets: { added: ['db://assets/f/TargetPolicy.ts'], removed: [], changed: [] },
        classes: { added: ['TargetPolicy'], removed: ['Npc'] }
    }));
    assert.match(text, /классы компонентов: \+TargetPolicy {2}-Npc/);
    assert.match(text, /^ассеты: \+1 {2}-0 {2}~0$/m);
    assert.match(text, /^ {2}\+ db:\/\/assets\/f\/TargetPolicy\.ts$/m);
});

test('a database that never went quiet does not get the ok head word', () => {
    const text = renderSettleReport(report({ settled: false }));
    assert.equal(text.split('  ')[0], 'TIMEOUT');
});

test('an operation that did not happen outranks the settle verdict in the head word', () => {
    const text = renderSettleReport(report({ settled: true, failure: 'ассет остался на месте' }));
    assert.equal(text.split('  ')[0], 'FAILED');
    assert.match(text, /ассет остался на месте/);
});

// База отвечает до конца импорта, поэтому «команда отработала» и «база доимпортировала» —
// разные новости, и вторая обязана иметь своё слово.
test('a database still working when the timeout ran out is a TIMEOUT, not a FAILED', () => {
    assert.equal(settleVerdict(report({ settled: false })), 'TIMEOUT');
    assert.equal(settleVerdict(report({ settled: false, failure: 'ассет остался на месте' })), 'FAILED');
    assert.equal(settleVerdict(report()), 'ok');
});

test('a long list is capped and says how many it did not print', () => {
    const urls = Array.from({ length: 5 }, (_unused, index) => `db://assets/${index}.ts`);
    const text = renderSettleReport(
        report({ assets: { added: urls, removed: [], changed: [] } }), 2);
    assert.match(text, /\+ … и ещё 3/);
    assert.equal(/db:\/\/assets\/4\.ts/.test(text), false);
});

test('an unanswered class list is called out, so silence is not read as no change', () => {
    assert.match(settleNote(report({ classes: null }), 60000), /дельта неизвестна/);
    assert.equal(settleNote(report(), 60000), '');
});

test('a timeout note names the timeout instead of the class question', () => {
    assert.match(settleNote(report({ settled: false }), 60000), /60с/);
});

test('a failed operation reports its own failure rather than a settle note', () => {
    assert.equal(settleNote(report({ settled: false, failure: 'не перенесён', classes: null }), 60000),
        'сцена не ответила о зарегистрированных классах — их дельта неизвестна');
});
