import test from 'node:test';
import assert from 'node:assert/strict';

import r from '../lib/render/scene.js';

const {
    renderComponentOwners, componentOwnersSummary, renderSceneDirty, sceneDirtyNote,
    renderMissingScripts
} = r;

const owner = (over = {}) => ({
    nodePath: 'Characters/guard_1', nodeUuid: 'u-1', nodeName: 'guard_1',
    active: true, activeInHierarchy: true, componentUuid: 'c-1',
    className: 'TargetPolicy', enabled: true, ...over
});

const owners = (list) => ({
    className: 'TargetPolicy', sceneName: 'cc_action_1a', nodesScanned: 391,
    ownerCount: list.length, owners: list
});

test('a class nothing carries is said outright rather than printing an empty list', () => {
    assert.equal(renderComponentOwners(owners([])), 'ни один узел сцены не несёт TargetPolicy');
});

test('an owner prints its path and uuid with no marks when it is fully live', () => {
    const text = renderComponentOwners(owners([owner()]));
    assert.match(text, /Characters\/guard_1/);
    assert.match(text, /u-1/);
    assert.equal(/\(off\)/.test(text), false);
});

test('a node switched off itself and one switched off by a parent read differently', () => {
    const own = renderComponentOwners(owners([owner({ active: false, activeInHierarchy: false })]));
    const parent = renderComponentOwners(owners([owner({ active: true, activeInHierarchy: false })]));
    assert.match(own, /\(off\)/);
    assert.match(parent, /\(под выключенным\)/);
});

test('a disabled component is marked apart from a disabled node', () => {
    assert.match(renderComponentOwners(owners([owner({ enabled: false })])), /\(компонент off\)/);
});

test('the summary carries both the hit count and how much was searched', () => {
    const text = componentOwnersSummary(owners([owner()]));
    assert.match(text, /носителей 1/);
    assert.match(text, /просмотрено узлов 391/);
});

test('a scene matching disk says so and names the file', () => {
    assert.equal(
        renderSceneDirty({ differsFromDisk: false, scenePath: 'D:\\p\\a.scene', diffs: [] }),
        'совпадает с диском  D:\\p\\a.scene');
});

test('a differing scene leads with its own word and shows where it differs', () => {
    const text = renderSceneDirty({
        differsFromDisk: true, scenePath: 'D:\\p\\a.scene',
        diffs: [{ path: '.2._lpos.x', live: '5', disk: '0' }]
    });
    assert.equal(text.split('  ')[0], 'РАСХОДИТСЯ С ДИСКОМ');
    assert.match(text, /\.2\._lpos\.x {2}сцена 5 {2}диск 0/);
    assert.match(text, /расхождений: 1/);
});

test('a scene whose path is unknown still renders instead of printing null', () => {
    assert.match(
        renderSceneDirty({ differsFromDisk: false, scenePath: null, diffs: [] }),
        /путь неизвестен/);
});

test('the reason the comparison could not run reaches the note', () => {
    assert.equal(sceneDirtyNote({ differsFromDisk: false, scenePath: null, diffs: [], reason: 'нет файла' }),
        'нет файла');
    assert.equal(sceneDirtyNote({ differsFromDisk: false, scenePath: null, diffs: [] }), '');
});

test('a clean scene reports no dead components rather than an empty string', () => {
    assert.equal(renderMissingScripts({ entries: [] }), 'мёртвых компонентов в сцене нет');
});

test('a dead component names the node and the cid that no longer resolves', () => {
    const text = renderMissingScripts({
        entries: [{ nodePath: 'Characters/guard_1', nodeUuid: 'u-1', componentUuid: 'c-1', cid: '04e75Mu' }]
    });
    assert.match(text, /Characters\/guard_1/);
    assert.match(text, /cid=04e75Mu/);
});

test('a dead component with no cid says so instead of printing null', () => {
    assert.match(
        renderMissingScripts({ entries: [{ nodePath: 'a', nodeUuid: 'u', componentUuid: 'c', cid: null }] }),
        /cid=неизвестен/);
});

