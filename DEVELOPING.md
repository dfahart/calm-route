# Developing Calm Route

A guide for whoever works on this next. The product rules (what counts as stressful, how routes are scored,
why each decision was made) live in the spec doc, "Calm Route: Product Spec". This file is about the code.

## How it's built

- **No build step and no framework.** Three files make the app: `calm-route.html` (layout and security
  policy), `css/calm-route.css` and `js/calm-route.js`. Edit them and reload.
- **The look:** the map fills the window and the planner floats over it on a frosted panel (a card on the left on a
  computer, a sheet that slides up on a phone). Map moves go through `fitPad()` / `centerOn()` so nothing lands
  under the panel. Our own identity, not Apple's: Figtree type (never Apple's SF fonts, which are licensed for
  Apple-platform mockups only), teal for the calm route, apricot pebbles, our own icons and words.
- **One plain script.** `js/calm-route.js` runs top to bottom with shared globals, most importantly one
  `state` object (current trip, routes, selected route, stop). Sections are marked
  `// ================= name =================`, and the table of contents at the top lists them.
- **Map:** Leaflet 1.9.4 from cdnjs, checked by its fingerprint (`integrity=`).
- **Services:**
  - Stadia Maps: routing (Valhalla), search (Pelias) and map tiles. The live domain is registered, so no key is needed there.
  - National Weather Service: forecasts.
  - fueleconomy.gov: fuel cost, only if the driver turns it on.
  - Without Stadia (a local copy with no key), the app falls back to the free OpenStreetMap servers (Valhalla FOSSGIS and Photon).
- **No server of our own and no accounts.** Everything the driver saves is in that browser's `localStorage`, under keys starting `calmRoute`.
- **Traffic lights:** `signals/US-XX.js` files, built from OpenStreetMap by `tools/build_signals.py` and
  refreshed monthly by `.github/workflows/refresh-signals.yml`. They load as scripts only when a trip needs that state.

## Security policy

`calm-route.html` carries a Content Security Policy. It allows only our own script and stylesheet, Leaflet
from cdnjs, and the services above. **Never put code inside the HTML** (no inline `<script>`, no `onclick=`):
the policy blocks it. A new outside service must be added to `connect-src` (or `img-src` for images), or its
requests will fail.

## Tests

The tests drive a real browser (Chrome, through Playwright) against stand-in versions of every outside
service. So they're repeatable, they never cost anything, and they can fake rain, slow networks or a
station that means doubling back.

```
cd test
npm install            # test-only copies of Leaflet and the axe accessibility checker
pip install playwright && playwright install chromium
python3 run_fast.py           # everything (about 610 checks), 4 sections at a time: about 2.5 minutes
python3 run_fast.py pebble    # only sections whose heading mentions a word: seconds
python3 test_app.py           # the same checks the slow way, one file at a time (about 10 minutes each)
python3 test_more.py
```

While working, run just the sections you touched (`run_fast.py <word>`); run everything once before going live.
`run_fast.py` splits each file at its section headings (a section that reuses the page before it stays joined to
it). A section that fails while sharing the machine is retried once on its own; if it then passes, it is reported
as timing-sensitive rather than failing the run.

Each prints `PASS` or `FAIL` per check and a total. Both must be all-pass before anything goes live.

Conventions:
- **Every change in behaviour gets a check**, named in plain words ("a station a block off the route is not picked automatically").
- The stand-in services are the `fake_*` functions and `install_routes` in `test_app.py`. Small switches at the top
  of that file (`STOP_AT`, `DETOUR`, `HILLS`, `NIGHT`...) set up special situations.
- Accessibility is checked with axe-core (WCAG 2.1 AA), and phone layouts with touch emulation. Every
  tappable thing must be at least 44 pixels.

## How changes go live

The repository is `github.com/dfahart/calm-route`, and the site is GitHub Pages from the `main` branch.
Pushing to `main` updates https://dfahart.github.io/calm-route/ in about a minute. Workflow:

1. Make the change, with its tests.
2. Run both test batches; everything must pass.
3. Commit with a message that says what changed for the driver, then push.
4. Check the live site.

The site isn't listed (`robots.txt` and `noindex`), but it is public to anyone with the link.

## Ground rules that came out of real testing

- **Stops go to Google and Apple as exact points, never as written addresses.** Map-data addresses can be a mile off.
- **One stop at a time.** Need gas and Need food are either/or. A stop must be right on the road (about 150 yards),
  must not mean doubling back, and with a stop set, a route that doubles back to reach it is never the calm pick.
- **Automatic stops use brand names only.** A plain "Gas" match, and government or fleet pumps, are never picked.
- **Searches to outside services run a few at a time** (see `limiter`). Bursts get throttled, and a failed
  search must say "couldn't look", never "nothing there".
- **The Stadia key never goes into the code.**
