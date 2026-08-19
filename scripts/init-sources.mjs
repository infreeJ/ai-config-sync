#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEMPLATE_ROOT = join(ROOT, 'scripts', 'templates', 'sources');
const SOURCE_ROOT = join(ROOT, 'sources');

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is missing or is not a directory: ${path}`);
  }
}

function ensureGitRepository() {
  try {
    const result = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (result !== 'true') throw new Error('not inside a Git work tree');
  } catch {
    throw new Error('npm run init must be run inside a Git work tree.');
  }
}

function main() {
  requireDirectory(TEMPLATE_ROOT, 'Source template directory');

  if (existsSync(SOURCE_ROOT)) {
    requireDirectory(SOURCE_ROOT, 'Existing sources directory');
    console.log('[init] sources/ already exists; preserved existing files.');
  } else {
    cpSync(TEMPLATE_ROOT, SOURCE_ROOT, { recursive: true });
    console.log('[init] Created sources/ from the bundled template.');
  }

  ensureGitRepository();
  execFileSync('git', ['add', '-f', '--', 'sources'], { cwd: ROOT, stdio: 'inherit' });
  console.log('[init] Staged sources/ for Git tracking.');
}

main();
