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

Uses [Preact](https://preactjs.com) (MIT) and [htm](https://github.com/developit/htm) (Apache 2.0), vendored in `js/vendor/`
together with their license files.

## Beta

`beta/` holds a fallback copy, served at `…/lift-happens/beta/` and installed as a second Home Screen app
("LH Beta", orange icon), with its own database (`lift-happens-beta`) and cache names.
Changes go straight to the regular app. The beta is only used if a release breaks the regular app:
then the root is reverted to the previous version and the work continues in `beta/` until it is fixed.
The root `sw.js` deletes only its own caches (`lift-happens-v…`); the beta's `sw.js` only `lift-happens-beta-…`.

## License

Lift Happens © 2026 [davser84](https://github.com/davser84) — licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0-only).

You may use, copy, modify and share it. Any modified version you distribute or offer to others,
including over a network, must stay under the same license and come with its full source code.
The bundled libraries keep their own licenses (see `js/vendor/`).
