// split2 ships no types and pulling in @types/split2 for one call site is not worth the dependency;
// this shims just the shape pipe-server.ts uses. Ambient module declarations for an untyped package
// must live in a non-module (no import/export) file, hence the separate .d.ts.
declare module 'split2' {
    import type { Transform } from 'stream';
    function split2(): Transform;
    export default split2;
}
