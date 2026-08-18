import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/main.ts', 'src/scene/index.ts', 'src/panels/default/index.ts'],
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    noExternal: [/.*/],
    external: ['electron'],
    splitting: false,
    sourcemap: 'inline',
    clean: true
});
