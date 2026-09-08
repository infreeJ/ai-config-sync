#!/usr/bin/env node
import { cpSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const TEMPLATE_ROOT = join(ROOT, 'scripts', 'templates', 'sources');
const SOURCE_ROOT = join(ROOT, 'sources');
const CONFIG_DEFAULT_FILE = join(ROOT, 'config', 'sync.config.default.json');
const CONFIG_FILE = join(ROOT, 'config', 'sync.config.json');

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} is missing or is not a directory: ${path}`);
  }
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} is missing or is not a file: ${path}`);
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

  requireFile(CONFIG_DEFAULT_FILE, 'Default sync config file');

  if (existsSync(CONFIG_FILE)) {
    requireFile(CONFIG_FILE, 'Existing sync config file');
    console.log('[init] config/sync.config.json already exists; preserved existing file.');
  } else {
    cpSync(CONFIG_DEFAULT_FILE, CONFIG_FILE);
    console.log('[init] Created config/sync.config.json from the bundled default.');
  }
}

main();
