#!/usr/bin/env node
// Thin launcher so `querynot` works without a build step. Node strips the
// TypeScript at load; nothing is emitted to disk.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'src', 'cli.ts');

const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--no-warnings', entry, ...process.argv.slice(2)],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
