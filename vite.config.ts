import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// Pin the MediaPipe WASM CDN URL to the installed JS package version.
const mpVersion = JSON.parse(
  readFileSync(new URL('./node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8'),
).version as string;

export default defineConfig({
  base: './',
  define: { __MP_VERSION__: JSON.stringify(mpVersion) },
  // the pose worker (src/app/poseWorker.ts) is a module worker
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
