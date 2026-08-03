import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dev-only: a drop box for recordings.
 *
 * `POST /__run` writes the body to `runs/<name>.json`. It exists because the
 * whole point of the recorder (§ run analysis) is that somebody who was not
 * sitting at the keyboard can read what happened — and until now getting a run
 * out of the browser meant a download dialog and a hunt through a Downloads
 * folder. `pnpm inspect runs/<file>` reads it directly.
 *
 * Dev server only. It never ships, and it writes nowhere but ./runs.
 */
function runDropBox(): Plugin {
  return {
    name: 'overclock-run-dropbox',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__run', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const name = String(req.headers['x-run-name'] ?? 'run').replace(/[^a-z0-9._-]/gi, '_');
          const dir = resolve(process.cwd(), 'runs');
          mkdirSync(dir, { recursive: true });
          const file = resolve(dir, `${name}.json`);
          writeFileSync(file, Buffer.concat(chunks));
          server.config.logger.info(`[overclock] recording written: runs/${name}.json`);
          res.statusCode = 200;
          res.end(file);
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [runDropBox()],
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
