import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const outdir = resolve('.tmp-tests');
const outfile = resolve(outdir, 'lib.test.mjs');

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: ['tests/lib.test.ts'],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline'
});

const child = spawn(process.execPath, [outfile], { stdio: 'inherit' });
child.on('exit', async (code) => {
  await rm(outdir, { recursive: true, force: true });
  process.exit(code ?? 1);
});
