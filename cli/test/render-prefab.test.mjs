import test from 'node:test';
import assert from 'node:assert/strict';

import {
    prefabDumpSummary, prefabOverridesSummary, renderPrefabDump, renderPrefabOverrides
} from '../lib/render/prefab.js';

const component = (over = {}) => ({
    className: 'CharacterAnimator', cid: null, fileId: 'f1', enabled: true, missing: false, ...over
});

const dump = (over = {}) => ({
    prefabUuid: 'p1',
    rootName: 'char_hero',
    nodeCount: 1,
    componentCount: 1,
    missingCount: 0,
    nodes: [{ path: 'char_hero', name: 'char_hero', active: true, fileId: 'n1', components: [component()] }],
    ...over
});

test('узел печатается путём и списком компонентов', () => {
    assert.equal(renderPrefabDump(dump()), 'char_hero  [CharacterAnimator]');
});

test('выключенный узел помечен так же, как в дереве сцены', () => {
    const off = dump();
    off.nodes[0].active = false;
    assert.match(renderPrefabDump(off), /\(off\)/);
});

test('выключенный компонент назван вместе со своим состоянием', () => {
    const off = dump();
    off.nodes[0].components = [component({ enabled: false })];
    assert.match(renderPrefabDump(off), /CharacterAnimator\(off\)/);
});

// Мёртвый слот — то, ради чего дамп и читают: он роняет превью на загрузке сцены.
test('мёртвый компонент назван отдельным словом и своим cid', () => {
    const dead = dump();
    dead.nodes[0].components = [component({ missing: true, className: 'cc.MissingScript', cid: '04e75MuPw1E2Y0Yv' })];
    const text = renderPrefabDump(dead);
    assert.match(text, /МЁРТВЫЙ/);
    assert.match(text, /04e75MuPw1E2Y0Yv/);
});

test('узел без компонентов печатается одним путём, без пустых скобок', () => {
    const bare = dump();
    bare.nodes[0].components = [];
    assert.equal(renderPrefabDump(bare), 'char_hero');
});

test('сводка молчит о мёртвых, когда их нет', () => {
    assert.doesNotMatch(prefabDumpSummary(dump()), /МЁРТВ/);
});

test('сводка называет число мёртвых слотов, когда они есть', () => {
    assert.match(prefabDumpSummary(dump({ missingCount: 2 })), /МЁРТВЫХ КОМПОНЕНТОВ: 2/);
});

const override = (over = {}) => ({
    index: 0,
    propertyPath: '_lpos',
    propertyPathParts: ['_lpos'],
    localID: ['abc'],
    target: { kind: 'node', name: 'Hips', path: 'char_hero/Hips', type: 'cc.Node' },
    valueKind: 'valueType',
    valueType: 'Vec3',
    value: { x: 1, y: 0, z: 0 },
    ...over
});

const report = (overrides) => ({
    nodeUuid: 'n1', nodeName: 'char_hero', prefabAsset: 'p1',
    overrideCount: overrides.length, removedComponents: 0, mountedChildren: 0, overrides
});

test('инстанс без оверрайдов говорит об этом словами, а не пустой строкой', () => {
    assert.equal(renderPrefabOverrides(report([])), 'оверрайдов нет');
});

test('оверрайд печатается индексом, путём свойства, целью и значением', () => {
    const text = renderPrefabOverrides(report([override()]));
    assert.match(text, /^0\s+_lpos\s+char_hero\/Hips\s+Vec3\s+\{"x":1/);
});

test('цель-компонент названа классом и узлом', () => {
    const text = renderPrefabOverrides(report([override({
        target: { kind: 'component', name: 'char_hero', path: 'char_hero', type: 'CharacterAnimator' }
    })]));
    assert.match(text, /CharacterAnimator на char_hero/);
});

// Оверрайд переживает значение, для которого записан, поэтому цель без имени должна остаться
// адресуемой — по localID, а не превратиться в прочерк.
test('цель, которую не удалось назвать, печатается своим localID', () => {
    const text = renderPrefabOverrides(report([override({ target: null, localID: ['a', 'b'] })]));
    assert.match(text, /localID a\/b/);
});

test('ссылка на ассет печатается именем и uuid', () => {
    const text = renderPrefabOverrides(report([override({
        valueKind: 'asset', valueType: 'SkeletalAnimationClip', assetName: 'idle', assetUuid: 'a1'
    })]));
    assert.match(text, /idle\s+a1/);
});

test('снятые компоненты и добавленные дети попадают в сводку', () => {
    const summary = prefabOverridesSummary({ ...report([]), removedComponents: 1, mountedChildren: 2 });
    assert.match(summary, /снятых компонентов: 1/);
    assert.match(summary, /добавленных детей: 2/);
});
