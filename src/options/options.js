import { DEFAULTS, loadSettings, saveSettings, originPattern } from '../settings.js';
import { listModels, normalizeBaseUrl } from '../lib/openai.js';

const $ = (id) => document.getElementById(id);
const fields = Object.keys(DEFAULTS);

function msg(text, isError = false) {
  $('msg').textContent = text;
  $('msg').classList.toggle('error', isError);
}

function read() {
  const s = {};
  for (const k of fields) s[k] = $(k).type === 'checkbox' ? $(k).checked : $(k).value.trim();
  s.baseUrl = normalizeBaseUrl(s.baseUrl);
  s.language ||= 'auto';
  return s;
}

// The endpoint can be any host, so access is requested for that origin only.
// Called first thing in click handlers: it needs the user gesture.
function grant(baseUrl) {
  return chrome.permissions.request({ origins: [originPattern(baseUrl)] });
}

$('test').addEventListener('click', async () => {
  const s = read();
  if (!s.baseUrl) return msg('Enter the base URL first.', true);
  try {
    if (!(await grant(s.baseUrl))) return msg('Permission to reach that host was not granted.', true);
    msg('Connecting…');
    const models = await listModels(s);
    $('models').replaceChildren(...models.map((m) => new Option(m)));
    msg(`OK: ${models.length} models (${models.slice(0, 8).join(', ')}${models.length > 8 ? ', …' : ''}).`);
  } catch (e) {
    msg(e.message, true);
  }
});

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = read();
  try {
    new URL(s.baseUrl);
  } catch {
    return msg('Base URL is not a valid URL.', true);
  }
  if (!(await grant(s.baseUrl))) return msg('Saved nothing: permission to reach that host was not granted.', true);
  await saveSettings(s);
  msg('Saved.');
});

const s = await loadSettings();
for (const k of fields) {
  if ($(k).type === 'checkbox') $(k).checked = !!s[k];
  else $(k).value = s[k] ?? '';
}
