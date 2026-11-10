const { spawnSync } = require('child_process');

// Run the Prisma CLI through node rather than node_modules/.bin/prisma(.cmd): since the April 2024
// security fix, Node on Windows refuses to spawn a .cmd file without a shell (EINVAL), which failed
// `npm ci` on Windows. The same command works on Vercel's Linux build.
const prismaCli = require.resolve('prisma/build/index.js');

const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    PRISMA_CLIENT_ENGINE_TYPE: 'binary',
    PRISMA_CLI_QUERY_ENGINE_TYPE: 'binary',
  },
});

if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
