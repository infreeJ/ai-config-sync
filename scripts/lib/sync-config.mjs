import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const INSTRUCTION_MODES = ['append', 'off', 'managed'];
const PROVIDER_NAMES = ['claude', 'codex', 'antigravity'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validateSyncConfig(config) {
  if (!isObject(config)) throw new Error('Invalid config. Expected a JSON object.');
  if (config.instructionsMode === 'sidecar') {
    throw new Error('instructionsMode "sidecar" is no longer supported. Change instructionsMode to "append" in config/sync.config.json, then review with npm run sync:dry.');
  }
  if (!INSTRUCTION_MODES.includes(config.instructionsMode)) {
    throw new Error(`Invalid instructionsMode "${config.instructionsMode}". Expected one of: append, off, managed.`);
  }
  for (const field of ['preCommitSync', 'backup']) {
    if (!['on', 'off'].includes(config[field])) {
      throw new Error(`Invalid ${field} "${config[field]}". Expected one of: on, off.`);
    }
  }
  if (!Number.isInteger(config.backupRetentionCount) || config.backupRetentionCount < 1) {
    throw new Error('Invalid backupRetentionCount. Expected an integer greater than or equal to 1.');
  }
  if (!isObject(config.providers)) {
    throw new Error('Invalid providers. Expected an object with supported provider names as boolean values.');
  }
  for (const [provider, enabled] of Object.entries(config.providers)) {
    if (!PROVIDER_NAMES.includes(provider)) {
      throw new Error(`Unsupported provider "${provider}". Expected one of: ${PROVIDER_NAMES.join(', ')}.`);
    }
    if (typeof enabled !== 'boolean') throw new Error(`Invalid provider setting "${provider}". Expected a boolean.`);
  }
  return config;
}

export function loadSyncConfig(root) {
  const file = join(root, 'config', 'sync.config.json');
  const defaultsFile = join(root, 'config', 'sync.config.default.json');
  if (!existsSync(defaultsFile)) {
    throw new Error(`Config default file is missing: ${defaultsFile}. Run: npm run init`);
  }
  const defaults = JSON.parse(readFileSync(defaultsFile, 'utf8'));
  const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const user = original === null ? {} : JSON.parse(original);
  if (!isObject(user)) throw new Error('Invalid config. Expected a JSON object.');
  const config = {
    ...defaults,
    ...user,
    modelPresets: { ...defaults.modelPresets, ...(user.modelPresets || {}) },
    effortPresets: { ...defaults.effortPresets, ...(user.effortPresets || {}) },
    providers: user.providers === undefined ? defaults.providers
      : isObject(user.providers) ? { ...defaults.providers, ...user.providers } : user.providers,
  };
  validateSyncConfig(config);
  return { file, original, config };
}
