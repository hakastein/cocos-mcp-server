import test from 'node:test';
import assert from 'node:assert/strict';

import np from '../dist/node-path.js';

const { buildPathIndex, resolvePathInIndex, normalizePath } = np;

const node = (name, uuid, children = []) => ({ name, uuid, children });

const scene = {
    children: [
        node('InteractivePoints', 'u_points', [
            node('InteractionPad_01', 'u_pad1', [
                node('interactive_frame_progressbar', 'u_bar1'),
                node('interactive_frame', 'u_frame1')
            ]),
            node('InteractionPad_02', 'u_pad2', [
                node('interactive_frame_progressbar', 'u_bar2')
            ])
        ]),
        node('Crowd', 'u_crowd', [
            node('Gangster', 'u_g1', [node('Hat', 'u_h1')]),
            node('Gangster', 'u_g2', [node('Hat', 'u_h2')]),
            node('Gangster', 'u_g3')
        ]),
        node('UICanvas', 'u_canvas', [node('HUD', 'u_hud', [node('Res_cash', 'u_cash')])])
    ]
};

const index = buildPathIndex(scene);

test('an unambiguous path resolves to its uuid', () => {
    const r = resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01');
    assert.equal(r.uuid, 'u_pad1');
    assert.equal(r.matchedPath, 'InteractivePoints/InteractionPad_01');
});

test('a deep path resolves', () => {
    assert.equal(resolvePathInIndex(index, 'UICanvas/HUD/Res_cash').uuid, 'u_cash');
});

test('the same leaf name under different parents stays distinct', () => {
    assert.equal(resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01/interactive_frame_progressbar').uuid, 'u_bar1');
    assert.equal(resolvePathInIndex(index, 'InteractivePoints/InteractionPad_02/interactive_frame_progressbar').uuid, 'u_bar2');
});

test('surrounding slashes and blanks are tolerated', () => {
    assert.equal(normalizePath('  /UICanvas/HUD/  '), 'UICanvas/HUD');
    assert.equal(resolvePathInIndex(index, ' /UICanvas/HUD/ ').uuid, 'u_hud');
});

test('same-named siblings are addressable by their #N suffix, the first one included', () => {
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#1').uuid, 'u_g1');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#2').uuid, 'u_g2');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#3/').uuid, 'u_g3');
    assert.equal(resolvePathInIndex(index, 'Crowd/Gangster#2/Hat').uuid, 'u_h2');
});

test('the bare name of same-named siblings is an ambiguity error listing every spelling', () => {
    const r = resolvePathInIndex(index, 'Crowd/Gangster');
    assert.equal(r.uuid, undefined);
    assert.match(r.error, /matches 3 nodes/);
    assert.match(r.error, /Crowd\/Gangster#1, Crowd\/Gangster#2, Crowd\/Gangster#3/);
});

test('an ambiguous path is never silently resolved to the first match', () => {
    const r = resolvePathInIndex(index, 'Crowd/Gangster/Hat');
    assert.equal(r.uuid, undefined);
    assert.match(r.error, /matches 2 nodes/);
    assert.match(r.error, /Crowd\/Gangster#1\/Hat, Crowd\/Gangster#2\/Hat/);
});

test('a node whose name is unique among its siblings keeps a bare label', () => {
    assert.equal(resolvePathInIndex(index, 'Crowd').uuid, 'u_crowd');
    assert.equal(resolvePathInIndex(index, 'Crowd#1').uuid, undefined);
});

test('an unresolvable leaf names the deepest existing prefix and its children', () => {
    const r = resolvePathInIndex(index, 'InteractivePoints/InteractionPad_01/progressbar');
    assert.match(r.error, /does not resolve/);
    assert.match(r.error, /'InteractivePoints\/InteractionPad_01' exists/);
    assert.match(r.error, /interactive_frame_progressbar/);
    assert.match(r.error, /interactive_frame/);
});

test('an unresolvable first segment names the scene roots', () => {
    const r = resolvePathInIndex(index, 'Nope/Deeper');
    assert.match(r.error, /not even its first segment 'Nope'/);
    assert.match(r.error, /The scene roots are: InteractivePoints, Crowd, UICanvas\./);
});

test('an empty path is an error, not a match on the scene root', () => {
    assert.match(resolvePathInIndex(index, '   ').error, /empty path/);
    assert.match(resolvePathInIndex(index, '/').error, /empty path/);
});

test('a prefix that is itself ambiguous still reports a usable nearer prefix', () => {
    const r = resolvePathInIndex(index, 'Crowd/Gangster/Boots');
    assert.match(r.error, /does not resolve/);
    assert.match(r.error, /'Crowd' exists/);
});
