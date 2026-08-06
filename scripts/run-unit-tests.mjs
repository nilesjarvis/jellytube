import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const outdir = resolve('.tmp-tests');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: ['tests/lib.test.ts', 'tests/music.test.ts'],
  outdir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline',
  outExtension: { '.js': '.mjs' }
});

const { readdir } = await import('node:fs/promises');
const files = (await readdir(outdir)).filter((file) => file.endsWith('.mjs'));
for (const file of files) {
  await new Promise((runResolve) => {
    const child = spawn(process.execPath, [resolve(outdir, file)], { stdio: 'inherit' });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) process.exitCode = 1;
      runResolve();
    });
  });
}
await rm(outdir, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
