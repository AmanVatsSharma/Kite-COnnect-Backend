/**
 * Ensures Vite admin SPA exists under src/public/dashboard or dist/public/dashboard.
 * Invoked from npm prestart hooks before Nest starts.
 */
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const indexCandidates = [
  join(repoRoot, 'src', 'public', 'dashboard', 'index.html'),
  join(repoRoot, 'dist', 'public', 'dashboard', 'index.html'),
];

function hasDashboardIndex() {
  return indexCandidates.some((p) => existsSync(p));
}

if (!hasDashboardIndex()) {
  // eslint-disable-next-line no-console
  console.log('[ensure-admin-dashboard] Missing SPA index; running npm run admin:build ...');
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npmCmd, ['run', 'admin:build'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    process.exit(r.status ?? 1);
  }
}

if (!hasDashboardIndex()) {
  console.error(
    '[ensure-admin-dashboard] Still missing index.html. Expected one of:\n',
    indexCandidates.join('\n'),
  );
  process.exit(1);
}
