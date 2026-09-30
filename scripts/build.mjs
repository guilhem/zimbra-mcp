import { mkdir, copyFile, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist/server', { recursive: true });
for (const file of ['worker.js', 'zimbra.js', 'tools.js']) {
  await copyFile(`src/${file}`, `dist/server/${file === 'worker.js' ? 'index.js' : file}`);
}
console.log('Built dependency-free Worker module at dist/server/index.js');
