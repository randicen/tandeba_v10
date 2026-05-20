import * as esbuild from 'esbuild';

esbuild.build({
  entryPoints: ['server.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/server.js',
  external: ['express', 'vite', 'fsevents', 'openai', 'axios', 'cheerio', 'uuid'],
}).catch(() => process.exit(1));
