// Tab-scoped side panel.
//
// The panel is disabled globally and enabled only for the tab where the toolbar
// icon was clicked, so it never shows on other tabs or windows. Clicking the icon
// again on that tab closes it, and so does navigating the tab off a video.
// Closing = disabling the panel for that tab (setOptions, Chrome 114+), which
// works on every version we support; sidePanel.close() only exists from 141.

export const PANEL_PAGE = 'src/panel/panel.html';

/** Tabs whose panel page is alive. Panels register over a runtime port (see panel.js). */
export const openTabs = new Set();

export const panelPath = (tabId) => `${PANEL_PAGE}?tabId=${tabId}`;

export function isWatchUrl(url) {
  try {
    const u = new URL(url);
    return /(^|\.)youtube\.com$/.test(u.hostname)
      && ((u.pathname === '/watch' && u.searchParams.has('v')) || /^\/(shorts|live)\/[\w-]{11}/.test(u.pathname));
  } catch {
    return false;
  }
}

const quiet = (p) => Promise.resolve(p).catch(() => {});

/** Global default: no panel anywhere, and the icon click is ours to handle. */
export function initPanelDefaults() {
  return Promise.all([
    quiet(chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })),
    quiet(chrome.sidePanel.setOptions({ enabled: false })),
  ]);
}

/**
 * Toolbar click. Must stay synchronous up to sidePanel.open(): open() is only
 * allowed while the click's user gesture is active, and any awaited call before
 * it (even storage) loses the gesture.
 */
export function togglePanel(tabId, isOpen = openTabs.has(tabId)) {
  if (isOpen) return closePanel(tabId);
  quiet(chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true }));
  return chrome.sidePanel.open({ tabId });
}

export function closePanel(tabId) {
  openTabs.delete(tabId);
  return quiet(chrome.sidePanel.setOptions({ tabId, enabled: false }));
}

/** Close the panel when its tab leaves the video (another video keeps it: the panel reloads itself). */
export async function onTabUrlChanged(tabId, url) {
  if (isWatchUrl(url)) return;
  if (openTabs.has(tabId)) return closePanel(tabId);
  // Panel enabled but not (yet) registered, e.g. right after a service-worker restart.
  const opts = await quiet(chrome.sidePanel.getOptions({ tabId }));
  if (opts?.enabled && opts.path?.startsWith(PANEL_PAGE)) await closePanel(tabId);
}

/** A panel page connects a port named "panel:<tabId>" for as long as it is open. */
export function registerPanelPort(port) {
  const m = /^panel:(\d+)$/.exec(port.name);
  if (!m) return false;
  const tabId = Number(m[1]);
  openTabs.add(tabId);
  port.onDisconnect.addListener(() => openTabs.delete(tabId));
  port.onMessage.addListener(() => {}); // keepalive pings
  return true;
}

export function installPanelHandlers() {
  chrome.action.onClicked.addListener((tab) => {
    togglePanel(tab.id).catch((e) => console.warn('[ytsum] side panel:', e?.message || e));
  });
  chrome.runtime.onConnect.addListener(registerPanelPort);
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.url) onTabUrlChanged(tabId, info.url);
  });
  chrome.tabs.onRemoved.addListener((tabId) => openTabs.delete(tabId));
}
