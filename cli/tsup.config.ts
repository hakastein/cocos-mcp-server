import { defineConfig } from 'tsup';

export default defineConfig({
    entry: { cocos: 'src/main.ts' },
    outDir: 'bin',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    // Everything is bundled but the parser `ecs census` runs on: 9 MB for one subcommand,
    // and `noExternal` is what tsup consults first.
    noExternal: [/^(?!typescript$).*/],
    external: ['typescript'],
    splitting: false,
    sourcemap: 'inline',
    clean: true,
    banner: { js: '#!/usr/bin/env node' }
});
