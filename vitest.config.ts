import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    // Seed scripts hit the network; they are exercised by `pnpm seed`, not by unit tests.
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  plugins: [
    // NestJS decorators need emitDecoratorMetadata, which esbuild does not support.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
