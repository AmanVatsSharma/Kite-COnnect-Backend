/**
 * Waits for Nest HTTP port (PORT or 3000), then runs `npm run admin:dev`.
 * Used by dev:full so Vite does not proxy before the API is listening.
 */
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import waitOn from 'wait-on';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const port = process.env.PORT || '3000';
const resource = `tcp:127.0.0.1:${port}`;

try {
  await waitOn({
    resources: [resource],
    timeout: 120_000,
    interval: 500,
  });
} catch (e) {
  console.error(`[wait-then-admin-dev] Timed out waiting for ${resource}. Is Nest using PORT=${port}?`);
  process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const child = spawn(npmCmd, ['run', 'admin:dev'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

child.on('exit', (code) => process.exit(code ?? 0));
