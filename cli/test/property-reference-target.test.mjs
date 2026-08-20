import test from 'node:test';
import assert from 'node:assert/strict';

import { referenceRequest, spellingOf } from '../lib/property/reference-target.js';

test('db://-путь читается как адрес в базе ассетов', () => {
    assert.deepEqual(spellingOf('db://assets/ui/icon.png/spriteFrame'),
        { kind: 'assetUrl', url: 'db://assets/ui/icon.png/spriteFrame' });
});

test('сжатый uuid узла отличается от имени узла', () => {
    assert.deepEqual(spellingOf('255rIRyPxOX5xNSUYxZLLP'), { kind: 'uuid', uuid: '255rIRyPxOX5xNSUYxZLLP' });
});

test('полный uuid ассета читается как uuid, а не как путь', () => {
    assert.deepEqual(spellingOf('0ba73f57-eedc-484a-89e4-20aeef0b73fc'),
        { kind: 'uuid', uuid: '0ba73f57-eedc-484a-89e4-20aeef0b73fc' });
});

test('под-ассет за собакой остаётся uuid', () => {
    assert.equal(spellingOf('0ba73f57-eedc-484a-89e4-20aeef0b73fc@f9941').kind, 'uuid');
});

// Алфавит сжатого uuid включает `/`, поэтому одной длины мало: путь такой же длины — путь.
test('путь длиной ровно в сжатый uuid остаётся путём из-за косой черты', () => {
    assert.deepEqual(spellingOf('Characters/cc_hero1234'),
        { kind: 'nodePath', path: 'Characters/cc_hero1234' });
});

test('обычное имя узла — путь', () => {
    assert.deepEqual(spellingOf('char_hero'), { kind: 'nodePath', path: 'char_hero' });
});

test('null очищает поле: целей нет и массива не заявлено', () => {
    assert.deepEqual(referenceRequest(null), { targets: [], array: false });
});

test('пустая строка очищает поле так же, как null', () => {
    assert.deepEqual(referenceRequest(''), { targets: [], array: false });
});

test('массив передаётся массивом, каждый элемент разобран по отдельности', () => {
    assert.deepEqual(referenceRequest(['char_hero', '255rIRyPxOX5xNSUYxZLLP']), {
        array: true,
        targets: [
            { kind: 'nodePath', path: 'char_hero' },
            { kind: 'uuid', uuid: '255rIRyPxOX5xNSUYxZLLP' }
        ]
    });
});

test('пустой массив очищает массивное поле, оставаясь массивом', () => {
    assert.deepEqual(referenceRequest([]), { targets: [], array: true });
});

test('объект с uuid — форма, в которой ссылку отдаёт --json', () => {
    assert.deepEqual(referenceRequest({ uuid: 'u1' }), {
        targets: [{ kind: 'uuid', uuid: 'u1' }],
        array: false
    });
});

test('число ссылкой быть не может — отказ, а не догадка', () => {
    const answer = referenceRequest(42);
    assert.ok('error' in answer);
    assert.match(answer.error, /42/);
});

test('негодный элемент роняет весь массив, а не пишется частично', () => {
    const answer = referenceRequest(['char_hero', true]);
    assert.ok('error' in answer);
});
