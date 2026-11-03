# Changelog

## 0.1.1 (2026-11-03)

### Fixed

- The side panel is now **tab-scoped**. Clicking the toolbar icon opens it for the current tab only; other tabs and windows no longer show it.
- Clicking the icon again on that tab closes it. Before, the only way to close it was right-click → Hide side panel.
- The panel closes when its tab navigates away from YouTube videos. On another video it reloads for that video.

How: the panel is disabled globally. The icon click enables it with `chrome.sidePanel.setOptions({ tabId, … })` and opens it with `sidePanel.open`. Closing disables it for that tab, which works back to Chrome 116. The manifest no longer declares a global `side_panel`.

### Tests

- `test/sidepanel.test.mjs`: unit tests for the toggle logic against a fake `chrome` API.
- `scripts/e2e-panel.mjs`: headless Chromium clicks the real toolbar icon (`Extensions.triggerAction`). It checks two tabs in one window, a second window, toggling, navigation and tab close: 15 checks. The same script fails 13 of 15 against v0.1.0.

## 0.1.0 (2026-11-03)

First proof of concept: transcript, summary and chapter timeline in a side panel, using your own OpenAI-compatible endpoint.
