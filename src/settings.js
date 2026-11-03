// Settings live in chrome.storage.local (never synced, never sent anywhere but your endpoint).
export const DEFAULTS = {
  baseUrl: '',
  apiKey: '',
  chatModel: '',
  fastModel: '', // optional small model for the quick "worth watching?" tier and transcript notes
  sttModel: 'whisper-1',
  language: 'auto',
  autoSummarize: true, // run the quick tier when the panel opens
  autoShort: true, // ...and the short summary
};

export async function loadSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

export async function saveSettings(s) {
  await chrome.storage.local.set(s);
}

export function originPattern(baseUrl) {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}
