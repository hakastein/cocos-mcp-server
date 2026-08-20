import test from 'node:test';
import assert from 'node:assert/strict';

import {
    componentCid, componentClassNames, descriptorOf, findProperty, propertyNames,
    readComponentProperties, selectComponent
} from '../lib/property/component-dump.js';

const number = (name, value, declared) => ({
    name, value, type: 'Number', visible: true, extends: [], ...(declared === undefined ? {} : { default: declared })
});

const camera = () => ({
    type: 'cc.Camera',
    cid: 'cc.Camera',
    value: {
        uuid: { value: 'dabrkqxkxNGIE3ZFR2iTFu', type: 'String', visible: false },
        enabled: { name: 'enabled', value: true, type: 'Boolean', visible: false },
        node: { name: 'node', value: { uuid: 'd2s/upPEVGCpi7iGBngsl3' }, type: 'cc.Node', visible: false, extends: ['cc.Object'] },
        _fov: { name: '_fov', value: 45, type: 'Number', visible: false, extends: [] },
        _near: { name: '_near', value: 1, type: 'Number', visible: false, extends: [] },
        _color: { name: '_color', value: { r: 255, g: 255, b: 255, a: 255 }, type: 'cc.Color', visible: false, extends: ['cc.ValueType'] },
        fov: { name: 'fov', value: 45, type: 'Number', visible: true, extends: [] },
        near: { name: 'near', value: 2, type: 'Number', visible: true, extends: [] },
        orthoHeight: { name: 'orthoHeight', value: 10, type: 'Number', visible: false, extends: [] },
        projection: {
            name: 'projection', value: 1, type: 'Enum', visible: true, extends: [],
            enumList: [{ name: 'ORTHO', value: 0 }, { name: 'PERSPECTIVE', value: 1 }]
        },
        clearFlags: {
            name: 'clearFlags', value: 6, type: 'BitMask', visible: true, extends: [],
            bitmaskList: [{ name: 'NONE', value: 0 }, { name: 'DEPTH', value: 2 }, { name: 'STENCIL', value: 4 }]
        }
    }
});

const bootstrap = () => ({
    type: 'GameBootstrap',
    cid: '646dcEg/PRLbZWLiQkjf9IA',
    value: {
        enabled: { name: 'enabled', value: false, type: 'Boolean', visible: false },
        prewarm: number('prewarm', 8, 8),
        waypointRadius: number('waypointRadius', 1.4, 0.7),
        hero: {
            name: 'hero', value: { uuid: '255rIRyPxOX5xNSUYxZLLP' }, default: null,
            type: 'cc.Node', visible: true, extends: ['cc.Object']
        }
    }
});

test('движковый компонент отвечает на голое написание, а зовётся зарегистрированным именем', () => {
    const choice = selectComponent([camera()], 'Camera');
    assert.equal(choice.className, 'cc.Camera');
    assert.equal(choice.index, 0);
    assert.equal(choice.enabled, true);
});

test('точное написание выигрывает у приставочного: cc.Sprite и свой Sprite различимы', () => {
    const comps = [{ type: 'cc.Sprite', value: {} }, { type: 'Sprite', value: {} }];
    assert.equal(selectComponent(comps, 'Sprite').index, 1);
    assert.equal(selectComponent(comps, 'cc.Sprite').index, 0);
});

test('несколько компонентов одного класса: читается первый, счётчик называет остальных', () => {
    const choice = selectComponent([bootstrap(), camera(), bootstrap()], 'GameBootstrap');
    assert.equal(choice.index, 0);
    assert.equal(choice.sameClassCount, 2);
});

test('класс, названный дампом только через __type__, отвечает на оба написания', () => {
    const comps = [{ __type__: 'cc.Sprite', value: {} }];
    assert.equal(selectComponent(comps, 'Sprite').className, 'cc.Sprite');
    assert.equal(selectComponent(comps, 'cc.Sprite').className, 'cc.Sprite');
});

test('cid для сериализатора берётся в своём порядке, а печатается имя класса', () => {
    const component = { type: 'GameBootstrap', cid: '646dcEg/PRLbZWLiQkjf9IA', value: {} };
    assert.equal(componentCid(component), '646dcEg/PRLbZWLiQkjf9IA');
    assert.equal(componentCid({ __type__: 'cc.Sprite', cid: 'иной', value: {} }), 'cc.Sprite');
    assert.equal(componentCid({ value: {} }), null);
    assert.equal(selectComponent([component], 'GameBootstrap').className, 'GameBootstrap');
});

test('запись ищет дескриптор ровно по названному имени: пишется тот же путь', () => {
    assert.equal(descriptorOf(camera(), '_fov').value, 45);
    assert.equal(descriptorOf(camera(), 'color'), null);
    assert.equal(findProperty(camera(), 'color').name, '_color');
});

test('класса на узле нет — выбора нет, а список имён для отказа собран', () => {
    const comps = [camera(), bootstrap()];
    assert.equal(selectComponent(comps, 'cc.MeshRenderer'), null);
    assert.deepEqual(componentClassNames(comps), ['cc.Camera', 'GameBootstrap']);
});

test('служебные поля редактора в список не идут, но названы среди скрытых', () => {
    const { readings, hidden } = readComponentProperties(bootstrap());
    assert.deepEqual(readings.map(reading => reading.name), ['prewarm', 'waypointRadius', 'hero']);
    assert.deepEqual(hidden, ['enabled']);
});

test('поле-хранилище схлопывается в аксессор только при равном значении', () => {
    const { readings, hidden } = readComponentProperties(camera());
    const names = readings.map(reading => reading.name);
    assert.ok(!names.includes('_fov'), 'равная пара _fov/fov должна схлопнуться');
    assert.ok(hidden.includes('_fov'));
    assert.ok(names.includes('_near'), 'разошедшуюся пару _near/near схлопывать нельзя');
    assert.ok(names.includes('near'));
});

test('поле-хранилище без аксессора остаётся: _color читается как цвет', () => {
    const { readings } = readComponentProperties(camera());
    const color = readings.find(reading => reading.name === '_color');
    assert.deepEqual(color.value, { r: 255, g: 255, b: 255, a: 255 });
    assert.equal(color.kind, 'color');
});

test('свойство, которого инспектор не рисует, из чтения не выпадает', () => {
    const { readings } = readComponentProperties(camera());
    const ortho = readings.find(reading => reading.name === 'orthoHeight');
    assert.equal(ortho.value, 10);
    assert.equal(ortho.hiddenInInspector, true);
});

test('enum назван по члену, битовая маска — по выставленным флагам', () => {
    const { readings } = readComponentProperties(camera());
    assert.equal(readings.find(reading => reading.name === 'projection').label, 'PERSPECTIVE');
    assert.equal(readings.find(reading => reading.name === 'clearFlags').label, 'DEPTH|STENCIL');
});

test('значение, разошедшееся с умолчанием, отмечено, совпавшее — нет', () => {
    const { readings } = readComponentProperties(bootstrap());
    assert.equal(readings.find(reading => reading.name === 'waypointRadius').differsFromDefault, true);
    assert.equal(readings.find(reading => reading.name === 'prewarm').differsFromDefault, false);
});

test('ссылка при пустом умолчании: выставленная разошлась, невыставленная — нет', () => {
    const empty = bootstrap();
    empty.value.hero.value = { uuid: '' };
    assert.equal(readComponentProperties(bootstrap())
        .readings.find(reading => reading.name === 'hero').differsFromDefault, true);
    assert.equal(readComponentProperties(empty)
        .readings.find(reading => reading.name === 'hero').differsFromDefault, false);
});

test('умолчание, пришедшее деревом дескрипторов, вердикта не даёт', () => {
    const component = camera();
    component.value.fov.default = { type: 'cc.Color', value: { r: { value: 51 } } };
    const { readings } = readComponentProperties(component);
    assert.equal(readings.find(reading => reading.name === 'fov').differsFromDefault, null);
});

test('умолчания в дампе нет — вердикта тоже нет', () => {
    const { readings } = readComponentProperties(camera());
    assert.equal(readings.find(reading => reading.name === 'projection').differsFromDefault, null);
});

test('по имени достаётся и служебное поле, и поле-хранилище', () => {
    assert.equal(findProperty(camera(), '_fov').value, 45);
    assert.equal(findProperty(bootstrap(), 'enabled').value, false);
});

test('имя аксессора отвечает из поля-хранилища, когда самого аксессора нет', () => {
    const reading = findProperty(camera(), 'color');
    assert.equal(reading.name, '_color');
    assert.deepEqual(reading.value, { r: 255, g: 255, b: 255, a: 255 });
});

test('имени нет ни в одном написании — null, а список имён для отказа полон', () => {
    assert.equal(findProperty(bootstrap(), 'nope'), null);
    assert.deepEqual(propertyNames(bootstrap()), ['enabled', 'prewarm', 'waypointRadius', 'hero']);
});
