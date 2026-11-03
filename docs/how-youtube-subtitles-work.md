# How YouTube subtitles (and audio) get out of YouTube

Notes from reading yt-dlp's YouTube extractor (yt-dlp **2026.10.21**,
`yt_dlp/extractor/youtube/_base.py`, `_video.py`, `pot/`, `jsc/`) and from
probing YouTube live from Node and from a real browser on 2026-11-03.
They explain the design of this extension. YouTube changes this regularly;
dates matter.

## TL;DR

| Need | What works in a browser extension (Nov 2026) |
|---|---|
| Caption track list | Any player response: `captions.playerCaptionsTracklistRenderer.captionTracks` |
| Caption text | `GET /api/timedtext?…&fmt=json3`. URLs from the **web** player carry `exp=xpe` and return an **empty 200** without a PO token. URLs from **JS-less InnerTube clients** (`ANDROID_VR`, `VISIONOS`) need no token. When those clients are bot-checked, **reuse the PO token the page's own player puts on its timedtext request**. |
| Chapters | `/youtubei/v1/next` (or `ytInitialData`) → player bar markers or the "macro markers" engagement panel; else timestamps in the description |
| Audio for STT | Only from JS-less clients: plain `url`s with no `n`/signature. Web player streams are SABR-only (no URL at all). Fetch in ≤10 MiB `Range` pieces and split fMP4 at fragment boundaries using the `sidx` index. |

## 1. Getting a player response

yt-dlp downloads the watch page, takes `ytInitialPlayerResponse` and `ytcfg`
from it (`_YT_INITIAL_PLAYER_RESPONSE_RE = r'ytInitialPlayerResponse\s*='`),
then calls the InnerTube player API once per *client*
(`_extract_player_response`):

```
POST https://www.youtube.com/youtubei/v1/player?prettyPrint=false
X-YouTube-Client-Name: <INNERTUBE_CONTEXT_CLIENT_NAME>
X-YouTube-Client-Version: <clientVersion>
X-Goog-Visitor-Id: <visitorData from ytcfg>   (when known)
{
  "context": { "client": { "clientName": "...", "clientVersion": "...", "hl": "en", ... } },
  "videoId": "...",
  "playbackContext": { "contentPlaybackContext": {
      "html5Preference": "HTML5_PREF_WANTS",
      "signatureTimestamp": <sts from the player JS> } },   // only for clients that need JS
  "contentCheckOk": true, "racyCheckOk": true
}
```

The clients live in `INNERTUBE_CLIENTS` in `_base.py`. What matters for us:

| client | id | needs player JS (sig/n) | GVS PO token for streams | notes in yt-dlp |
|---|---|---|---|---|
| `web` | 1 | yes | required | SABR-only for most sessions |
| `web_embedded` | 56 | yes | – | age-gate workaround |
| `mweb` | 2 | yes | required | |
| `tv`, `tv_samsung` | 7 | yes | – | default client |
| `android_vr` | 28 | **no** | required\*, but not with player token | "1.65.10 is 403'd since 2026.08.17" |
| `visionos` | 101 | **no** | – | default **JS-less** client |
| `ios`, `android` | 5, 3 | no | required | |

Defaults: `_DEFAULT_CLIENTS = ('tv_samsung', 'visionos', 'web')`, and
`_DEFAULT_JSLESS_CLIENTS = ('visionos',)` when no JS runtime is available.

**Measured (2026-11-03):** anonymous `ANDROID_VR` (version 1.60.19) and `VISIONOS`
return playable responses with caption tracks and plain audio URLs. `TV` and
`MWEB` without the page's config answer "The page needs to be reloaded."
`WEB_EMBEDDED` without a matching config answers "This video is unavailable".
After a few dozen requests from one IP, `ANDROID_VR`/`VISIONOS` started returning
`LOGIN_REQUIRED: Sign in to confirm you're not a bot` for nearly every video
(very popular videos excepted). Sending the page's `visitorData` did not change
that, and neither did making the request from inside youtube.com. This is the
main practical limit of the JS-less route.

## 2. Where `captionTracks` come from and what is in them

`captions.playerCaptionsTracklistRenderer` of a player response:

```jsonc
{
  "captionTracks": [
    { "baseUrl": "https://www.youtube.com/api/timedtext?v=…&ei=…&caps=asr&opi=…&exp=xpe&xoaf=5&…&signature=…&key=yt8&lang=en",
      "name": { "simpleText": "English (auto-generated)" },
      "vssId": "a.en", "languageCode": "en", "kind": "asr", "isTranslatable": true }
  ],
  "audioTracks": [{ "captionTrackIndices": [0, 1], "defaultCaptionTrackIndex": 0, … }],
  "translationLanguages": [{ "languageCode": "af", "languageName": { "simpleText": "Afrikaans" } }, …]
}
```

* `kind: "asr"` = automatic speech recognition track ("auto-generated"); manual
  tracks have no `kind`. yt-dlp keys them as `a.en` vs `.en` (`vssId`).
* `isTranslatable` + `translationLanguages` = YouTube machine translation: append
  `&tlang=<code>`. yt-dlp skips `tlang` when it equals the track language
  ("returns damaged subtitles"). Only web/mweb responses carry
  `translationLanguages`. In our tests translated requests got **HTTP 429**
  quickly, so the extension translates via the LLM (the output-language setting)
  instead.
* Formats (`_SUBTITLE_FORMATS`): `json3`, `srv1`, `srv2`, `srv3`, `ttml`, `srt`, `vtt`
  via `&fmt=`. yt-dlp also removes `xosf` (it adds positioning noise).
  We use **json3**: `events[]` with `tStartMs`, `dDurationMs` and `segs[].utf8`.
  ASR json3 has one "window" event (`id`, `wpWinPosId`, no `segs`), word-level
  `segs` with `tOffsetMs`, and `aAppend: 1` events whose only seg is `"\n"`.
  Events overlap (a line stays until the next-but-one starts), so the parser
  clamps each segment's end to the next start (`src/lib/captions.js`).

## 3. PO tokens ("pot") and timedtext

YouTube attests clients with BotGuard and hands out *Proof of Origin* tokens.
yt-dlp models three token contexts (`_PoTokenContext`): `player` (sent in the
player request as `serviceIntegrityDimensions.poToken`), `gvs` (added to stream
URLs as `&pot=`), and `subs`, for `/api/timedtext`.

For subtitles (`_video.py`, `process_subtitles` loop):

```python
requires_pot = (
    any(e in traverse_obj(qs, ('exp', ...)) for e in ('xpe', 'xpv'))   # "We can detect the experiment for now"
    or (pot_policy.required and not (pot_policy.not_required_for_premium and is_premium_subscriber)))
...
pot_params.update({'pot': subs_po_token, 'potc': '1', 'c': innertube_client_name})
```

and when the token is missing it *drops* those tracks ("not downloadable as-is").
The subs token is **content-bound to the video id** (`pot/utils.py`
`get_webpo_content_binding`: `PLAYER`/`SUBS` → `VIDEO_ID`; `GVS` → visitor data
or data-sync id). yt-dlp itself does not mint tokens. That needs a provider
plugin (e.g. bgutil) that runs BotGuard in a JS environment, or a token you
pass with `--extractor-args youtube:po_token=web.subs+…`.

**Measured:**

* Web watch-page tracks: `exp=xpo,xwmhp,xpe` → `fmt=json3` returns **200 with an
  empty body**. This is the silent failure that broke most summary extensions
  that read `ytInitialPlayerResponse` and fetch `baseUrl`.
* `ANDROID_VR`/`VISIONOS` tracks: no `xpe` → full json3 with no token.
  (`IOS`/`ANDROID` tracks carry `exp=xpo` only and also worked.)
* **In a real browser**, the page player adds `pot`, `potc=1`, `c=WEB`, `cver`…
  to its own timedtext request when captions are on. One token taken from
  that request worked for **every** track of the same video (`.en`, `a.en`,
  `.ru`) when added to the track `baseUrl` with `fmt=json3`, even with
  `credentials: 'omit'`. During a pre-roll ad the player requests the **ad's**
  captions, with the ad's video id, so we wait for the ad to finish.
* In headless, automation-controlled Chromium (Playwright) the player's own
  timedtext requests also come back empty: the token is minted, but YouTube
  rejects it. We did not try to hide automation. So this path can be checked
  in a real browser only, not in CI.

## 4. Signatures, `n`, SABR and why yt-dlp needs a JavaScript runtime

Stream URLs from JS-requiring clients come either as `signatureCipher`
(`s=<scrambled>&sp=sig&url=…`) or with an `n=` throttling parameter. Both have
to be transformed by functions inside the current player script
(`/s/player/<hash>/player_ias.vflset/…/base.js`):

* `sig`: unscramble `s` and append it as `&sig=` (or the `sp` name).
* `n`: transform the `n` value, otherwise downloads are throttled to a crawl
  or answer 403.

These functions are deliberately obfuscated and change with every player
release. yt-dlp used to extract them with regexes and its own tiny JS
interpreter (`jsinterp`). It now ships **EJS** challenge solvers
(`jsc/_builtin/ejs.py`, `vendor/yt.solver.core.js`) and runs them in a real JS
runtime (`deno`, `node`, `bun` or `quickjs`, see `jsc/_builtin/*.py`). The player
also needs `signatureTimestamp` (`sts`) in the player request so YouTube returns
URLs matching that player version. Without a JS runtime yt-dlp falls back to
the JS-less `visionos` client.

On top of that, the **web** client now usually returns **SABR** streams only:
`streamingData.serverAbrStreamingUrl`, with **no `url` and no
`signatureCipher` on any adaptive format** (seen for every video we probed).
SABR is a POST-based protobuf/UMP protocol that only the web player speaks.

## 5. What changes inside a youtube.com page

* **Same origin**: a content script can `fetch('/youtubei/v1/player')` and
  `/api/timedtext` without CORS. We send InnerTube requests with
  `credentials: 'omit'`: with the user's cookies YouTube expects a
  `SAPISIDHASH` `Authorization` header (yt-dlp generates one from cookies), and
  JS-less clients don't support cookies anyway.
* **The page already has a player response.** `#movie_player.getPlayerResponse()`
  (MAIN world) is the current one, even after SPA navigation.
  `window.ytInitialPlayerResponse` is the response for the first page load only,
  and goes stale after in-app navigation. Its tracks carry `xpe`, so they need
  a token (§3).
* **The page player already solved everything**: BotGuard, the PO token, `sig`,
  `n`. But the solutions don't help directly: its streams are SABR, so there is
  no audio URL to reuse. What we *can* reuse is its subtitle PO token, by
  observing its own timedtext request (MAIN-world `XMLHttpRequest.open`/`fetch`
  hook at `document_start`, plus `performance.getEntriesByType('resource')` as a
  backup; YouTube clears the resource-timing buffer often).
* `ytcfg.get('VISITOR_DATA')` and `INNERTUBE_CLIENT_VERSION` are available, so
  we send the visitor id like yt-dlp does. It did not help against the bot
  check (§1).
* Extension pages (the side panel) have host permissions, so they can download
  `*.googlevideo.com` audio without CORS.

## 6. How other extensions do it

* **Classic approach (2020–2024):** fetch the watch page, pull `captionTracks`
  out of `ytInitialPlayerResponse` with a regex, fetch `baseUrl` (XML/srv3).
  Most open-source summary extensions did this. It silently yields **empty
  transcripts** since timedtext started enforcing PO tokens (`exp=xpe`) in 2025.
* **"Show transcript" panel:** `ytInitialData` has a `getTranscriptEndpoint` with
  `params`, and `POST /youtubei/v1/get_transcript` used to return the segments.
  Measured today from a real page, logged out: **400 "Precondition check
  failed"** with or without cookies. Some extensions instead click "Show
  transcript" and scrape `ytd-transcript-segment-renderer` from the DOM. That
  works when the UI offers the button, but it's slow and breaks with layout
  changes.
* **Intercept the player** (language-learning extensions do this): hook
  XHR/fetch in the page and keep what the player downloads when CC is on. That
  is our PO-token fallback, except we only borrow the token and then fetch
  json3 ourselves, for whichever track we want.
* **Hosted backends:** send the video id to the vendor's server, which runs
  yt-dlp or a paid API. Out of scope here by design.

## 7. The approach this extension takes

`src/lib/youtube.js#loadVideo`, cheapest and least intrusive first:

1. **Page tracks without `xpe`** (not seen in practice today, but free): fetch json3.
2. **InnerTube `ANDROID_VR`, then `VISIONOS`** from the youtube.com tab
   (anonymous, page `visitorData`): their tracks need no token. This also
   provides plain audio URLs for STT and the description for chapter
   timestamps.
3. **Page tracks + borrowed PO token**: ask the MAIN-world script for the pot
   the player used for this video. If there is none, toggle CC
   (`movie_player.toggleSubtitles()`), wait for the request, then restore the
   CC state. Waits out pre-roll ads (up to 45 s).
4. **No captions at all** (no tracks) → **STT**: pick the smallest audio-only
   format with a plain URL (itag 139 AAC 48 kbit/s ≈ 21 MB/h, then 140, then
   Opus 249/250/251). Download in 10 MiB `Range` requests (yt-dlp's
   `http_chunk_size`; one-shot whole-file downloads are throttled to about
   real-time: 3.4 MB took 107 s). For fMP4, read the `sidx` box at
   `indexRange` and cut the file into pieces of ≤ 20 MB, each **init segment
   (`ftyp`+`moov`) + a run of whole `moof`/`mdat` fragments**. Each piece
   decodes on its own (checked with ffmpeg and whisper), so no re-encoding
   happens in the browser. Post each piece to `{base}/audio/transcriptions`
   and offset its timestamps by the piece's start time from `sidx`.
   LiteLLM's `verbose_json` returns one synthetic segment per file, so we fall
   back to `response_format=vtt` (which LiteLLM wraps in `{"text": "WEBVTT…"}`).

Chapters: `/next` (WEB client, page `clientVersion`) →
`playerOverlays…playerBar.multiMarkersPlayerBarRenderer.markersMap[DESCRIPTION_CHAPTERS]`
(yt-dlp still looks at the older `chapteredPlayerBarRenderer.chapters`; we
handle both) → `engagementPanels[].macroMarkersListRenderer` → description
lines (`^\s*(m:ss)\b\W*\s(title)$` or reversed, as in yt-dlp's
`_extract_chapters_from_description`). If there are none, the LLM proposes
chapters from the timestamped transcript.

### Known limits

* **IP-level bot check.** When YouTube flags the network, JS-less clients get
  `LOGIN_REQUIRED` for most videos. Captions still work via step 3 in a real
  browser, but **STT then has no audio URL**. We report that and do not try to
  get around it. A future option is to record the playing tab's audio
  (`chrome.tabCapture` / `video.captureStream()`) in real time.
* **PO tokens can't be verified in automation**: in Playwright, YouTube
  rejects the player's token, so CI can only test steps 2 and 4.
* **Live streams, premieres, members-only and age-restricted videos** are not
  handled specially.
* **No translation via `tlang`** (429s); summaries are translated by the LLM instead.
* Client versions (`ANDROID_VR 1.60.19`, `VISIONOS 1.02`) will age. When things
  break, compare `src/lib/innertube.js` with `INNERTUBE_CLIENTS` in the current
  yt-dlp.
