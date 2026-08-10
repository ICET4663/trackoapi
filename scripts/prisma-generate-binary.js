const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const prismaBin = isWindows
  ? 'node_modules\\.bin\\prisma.cmd'
  : 'node_modules/.bin/prisma';

const result = spawnSync(prismaBin, ['generate'], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    PRISMA_CLIENT_ENGINE_TYPE: 'binary',
    PRISMA_CLI_QUERY_ENGINE_TYPE: 'binary',
  },
});

process.exit(result.status ?? 1);
