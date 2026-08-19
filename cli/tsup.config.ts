import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { cocos: 'src/main.ts' },
    outDir: 'bin',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    splitting: false,
    sourcemap: 'inline',
    clean: true,
    banner: { js: '#!/usr/bin/env node' }
});
