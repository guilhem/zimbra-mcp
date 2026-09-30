import { mkdir, copyFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
await build({ entryPoints: ['src/worker.js'], outfile: 'dist/server/index.js', bundle: true,
  format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'eof' });
await copyFile('THIRD_PARTY_NOTICES.md', 'dist/THIRD_PARTY_NOTICES.md');
await copyFile('LICENSE', 'dist/LICENSE');
await copyFile('NOTICE.md', 'dist/NOTICE.md');
console.log('Built self-contained Worker bundle at dist/server/index.js');
