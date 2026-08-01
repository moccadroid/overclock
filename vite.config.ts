import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
