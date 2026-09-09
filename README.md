# Super Productivity companion watchface

A **separate Pebble app** (own UUID `7ec735d1-…`) from the main watchapp -
Pebble projects are one-app-each and can't share storage on the watch, so this
face runs its own trimmed SuperSync client.

## What it shows

- **Time + date**, framed by a **ring** that fills with today's completed /
  planned tasks.
- **Steps** (top-left) and a **battery** gauge (top-right); a "no phone" mark
  when Bluetooth drops.
- A **week sparkline** - minutes worked each of the last 7 days.
- **Heart rate** (bottom-left, on watches with the sensor) and **tasks left
  today** (bottom-right). On rectangular screens these sit in the bottom
  corners, clear of the ring.
- A **bottom line** that a wrist-tap cycles through:
  - the next timed task (`→ 3:15  Standup`)
  - `N / M done`
  - `Xh Ym worked`
  - `Xh Ym left` (estimate remaining)
  - `N / M habits` (+ the longest live streak)
  - When a timer is running anywhere it takes over: `▶ 0:42:15  <task>`,
    ticking every second.
- A `~` prefix + grey text when the last sync is over an hour old.
- **Quiet Time**: the line goes grey, the ring and sparkline dim.

### Colour & motion

- The ring animates to a new fraction, sweeps up from zero on launch, deepens
  from grey-green toward bright green as you finish tasks, turns gold at 100%
  with a one-shot white expanding flash.
- While a timer runs, a bright dot hops around the ring once a minute.
- On launch the pieces stagger in: the ring sweeps and the sparkline grows,
  then the minute rolls in, then the bottom line slides up.
- The minute rolls vertically on each change.
- The heart icon gives a small thump each time a new reading lands.
- The bottom line cross-slides on a change and marquees a long task name -
  scrolling only within the ring, not the full screen width.
- Battery gauge is green / amber / red by level, cyan while charging; below
  10% the outline turns red and an alert pip appears beside it.
- `Xh left` turns red when the estimate overshoots the end of the day.
- The tracked-task line turns red with a `!` once the timer passes that
  task's own estimate.
- Today's sparkline bar is green; the rest are blue. The date is grey.
- The tracked-task line is green.

All motion rides one 33 ms timer that stops itself when nothing's moving.

Re-syncs on launch, on a tap, and every 10-60 min (configurable). The live
timer needs the opt-in "Show the live-tracked task" toggle - it holds a
WebSocket open and costs battery.

## Sync

`src/pkjs/index.js` reuses the shared crypto + replay modules
(`lib/argon2id`, `aes-gcm`, `blake2b`, `sha256`, `base64`, `supersync-client`,
`task-store`) **copied** from `../src/pkjs/lib/`. Keep them in sync by hand when
the originals change (they rarely do - the SuperSync wire format is stable).

It's **read-only** - it never uploads. Storage keys are `spf_*` (own namespace).

First sync of an E2EE account runs one Argon2id derivation (~seconds) then
replays the op log; the derived key is cached (`spf_kdf_keys`) so later syncs
are quick.

## Pairing

Its own settings page (4 fields: server URL, email, encryption password,
access token). Paste the same values you used for the watchapp - the face
can't read them from the app.

Shared libs copied in: `argon2id`, `aes-gcm`, `blake2b`, `sha256`, `base64`,
`supersync-client`, `task-store`, `presence-client`. Keep in sync by hand.

## Not yet

- Config "import from the watchapp" (per-app storage blocks it).
- Theme-aware colours.
- The live-timer's elapsed can jump if the presence session re-emits with a
  shifted start time; the face re-anchors only on a task change to keep it
  smooth in between.
