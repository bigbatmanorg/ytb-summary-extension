// Toolbar click toggles a side panel for that tab only; the panel does the work.
import { initPanelDefaults, installPanelHandlers } from './sidepanel.js';

installPanelHandlers();

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // Also resets v0.1.0's global "open on action click" panel after an update.
  await initPanelDefaults();
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => initPanelDefaults());
