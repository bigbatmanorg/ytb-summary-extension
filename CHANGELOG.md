# Changelog

## 0.2.0 (2026-11-03)

### Added

- **Three summary tiers**, the same mechanism as the Worth Reading? page extension:
  - **Worth watching?**: a WATCH / SKIM / SKIP verdict plus two sentences, from an optional **fast model**;
  - **Short summary**: about 2 minutes to read, with chapters when the video has none;
  - **Detailed summary**: on demand.
- New settings: **Fast model**, and "also generate the short summary right away".
- **Streaming**: answers appear as they are written. Reasoning models show "Thinking…" with a timer.
- Long transcripts are condensed once (by the fast model) and shared by the short and detailed tiers. The verdict reads only the first part.
- Each tier has its own button and Copy. Results are cached per video for the browser session; a summary cached by 0.1.x shows up as the short tier.

### Changed

- Prompts forbid adding facts from the model's own knowledge.
- Transcript lines sent to the model span 5–30 s depending on video length, so short videos get precise timestamps.

### Fixed

- Card headers no longer stick over the panel header when scrolling.

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
