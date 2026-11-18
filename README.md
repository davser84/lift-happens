# Lift Happens

A personal gym plan and log for iPhone, built as an offline Progressive Web App.
All workout data stays on the phone (IndexedDB); this repository only holds the app itself.

## Install on iPhone

1. Open the GitHub Pages address of this repository in Safari.
2. Share → Add to Home Screen, then open Lift Happens from the new icon.
3. On first launch tap **Import plans or backup file** and pick your plans JSON file
   (keep that file out of this public repository).

## Back up

Settings → Export backup creates a JSON file (save it to iCloud Drive).
Settings → Import backup restores it on this or another iPhone.

## Update the app

Change the files, bump `VERSION` in `sw.js` (and in `js/app.js`), commit.
The phone picks up the new version the next time the app is opened with a connection
(sometimes it needs to be closed and opened twice).

## Develop

No build step. Serve the folder with any static server, e.g. `python3 -m http.server`.
Logic tests: `node --test tests/logic.test.mjs`.

Uses [Preact](https://preactjs.com) and [htm](https://github.com/developit/htm) (MIT), vendored in `js/vendor/`.

## Beta

`beta/` holds a test version, served at `…/lift-happens/beta/` and installed as a second Home Screen app
("LH Beta", orange icon). It uses its own database (`lift-happens-beta`) and its own cache names, so it never
touches the regular app's data. Move changes from `beta/` to the root only once they are confirmed.
Note for that step: make the root `sw.js` delete only its own caches (`lift-happens-v…`), not the beta's.
