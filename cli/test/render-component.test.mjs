import test from 'node:test';
import assert from 'node:assert/strict';

import {
    classListSummary, renderClassList, renderSockets, socketsSummary
} from '../src/render/component.ts';

const menu = [
    { name: 'cc.Camera', cid: 'cc.Camera', path: 'Rendering/Camera' },
    { name: 'TargetPolicy', cid: 'a1b2c', path: 'Custom/TargetPolicy', assetUuid: 'script-uuid' }
];

test('a menu entry prints its name, its menu path and its class id', () => {
    const text = renderClassList(menu);
    assert.match(text, /cc\.Camera.*Rendering\/Camera/);
    assert.match(text, /TargetPolicy.*Custom\/TargetPolicy/);
    assert.match(text, /a1b2c/);
});

test('a registry entry carrying nothing but a name prints the name alone', () => {
    assert.equal(renderClassList([{ name: 'cc.SpriteComponent' }]), 'cc.SpriteComponent');
});

test('a class id equal to the name is not printed twice', () => {
    assert.equal(renderClassList([{ name: 'cc.Camera', cid: 'cc.Camera' }]), 'cc.Camera');
});

test('an empty answer is said outright rather than printed as nothing', () => {
    assert.equal(renderClassList([]), 'no class matched');
});

test('the summary of the menu names what the count is of', () => {
    assert.equal(classListSummary(menu.length), 'components offered: 2');
});

test('the summary of a registry listing names the base that was asked about', () => {
    assert.match(classListSummary(260, 'cc.Component'), /cc\.Component/);
    assert.match(classListSummary(260, 'cc.Component'), /260/);
});

const sockets = (list, over = {}) => ({
    nodeUuid: 'node-1', useBakedAnimation: true, sockets: list, ...over
});

const socket = (over = {}) => ({
    path: 'mixamorig_Hips/mixamorig_RightHand',
    targetUuid: 'target-1',
    targetName: 'mixamorig_RightHand Socket',
    targetChildren: ['rifle'],
    ...over
});

test('a socket prints the bone it tracks, the node that tracks it and that node uuid', () => {
    const text = renderSockets(sockets([socket()]));
    assert.match(text, /mixamorig_Hips\/mixamorig_RightHand/);
    assert.match(text, /mixamorig_RightHand Socket/);
    assert.match(text, /target-1/);
});

test('what hangs off a socket is named: that is what the socket was made for', () => {
    assert.match(renderSockets(sockets([socket()])), /rifle/);
});

test('a socket whose target node is gone says so instead of printing an empty column', () => {
    const text = renderSockets(sockets([socket({ targetUuid: undefined, targetName: undefined })]));
    assert.match(text, /no target/);
});

test('a node with no sockets is said outright', () => {
    assert.equal(renderSockets(sockets([])), 'no socket on this node');
});

test('the summary carries the socket count and whether the animation is baked', () => {
    assert.match(socketsSummary(sockets([socket()])), /sockets: 1/);
    assert.match(socketsSummary(sockets([socket()])), /useBakedAnimation=true/);
});

test('a listing of bare names carries no trailing padding for grep to pick up', () => {
    const text = renderClassList([{ name: 'cc.Sprite' }, { name: 'cc.SpriteComponent' }]);
    assert.equal(text, 'cc.Sprite\ncc.SpriteComponent');
});
