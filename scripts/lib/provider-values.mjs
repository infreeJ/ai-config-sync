// Offline output contracts. The menu's choices always come from the live CLI catalog.
export const REASONING_EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

export function isModelValue(provider, value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)) return false;
  if (provider === 'claude') return /^(?:default|opus|sonnet|haiku|fable|inherit)$/.test(value) || value.startsWith('claude-');
  return !value.startsWith('claude-') && !['opus', 'sonnet', 'haiku', 'fable', 'inherit'].includes(value);
}

export function isEffortValue(provider, value) {
  return REASONING_EFFORTS[provider]?.includes(value) === true;
}
