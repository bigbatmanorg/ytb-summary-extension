# Test fixtures

Recorded from live YouTube with `node scripts/record-fixtures.mjs`, then trimmed.
IP addresses and URL signatures are scrubbed.

| File | What |
|---|---|
| `player-dQw4w9WgXcQ.json` | ANDROID_VR `/player` response, audio formats + caption tracks only |
| `json3-dQw4w9WgXcQ-asr.json` | auto-generated (ASR) track, first 60 events; words replaced by `w1 w2 …` (song lyrics), structure and timing real |
| `json3-jNQXAC9IVRw-en.json` | manual English track of "Me at the zoo", fetched in a browser with the page player's PO token |
| `next-iKx3gAODybU.json` | WEB `/next` response trimmed to the player bar and the chapters engagement panel |
| `audio-head-dQw4w9WgXcQ.bin` | first bytes of audio itag 139: `ftyp` + `moov` (init) + `sidx` (index) |
