# Calm Route

A route planner for anxious drivers. It finds the least stressful way to drive somewhere, scored around each
driver's own worries, then hands the trip to Google Maps, Apple Maps or Waze.

**Live (private test link):** https://dfahart.github.io/calm-route/

The full design, every rule and every decision is in the spec doc ("Calm Route: Product Spec").
The pre-launch checklist is in "Calm Route: What We're Missing".
If you're a developer picking this up, start with [DEVELOPING.md](DEVELOPING.md).

## What's in this folder

| Path | What it is |
| --- | --- |
| `calm-route.html` | The page: layout and the security policy. |
| `css/calm-route.css` | All the styling. |
| `fonts/` | Figtree, the app's typeface (SIL Open Font License, see `Figtree-OFL.txt`), served from here so no font service sees visitors. |
| `js/calm-route.js` | All the app's logic, in labelled sections (a table of contents is at the top). |
| `index.html` | Sends visitors from the site's front door to `calm-route.html`. |
| `signals/US-MI.js` | Michigan traffic lights (35,481), so the app can tell lefts with a light from lefts without one. |
| `signals/US-IN.js`, `US-OH.js`, `US-FL.js` | Indiana, Ohio and Florida traffic lights. Built by the monthly GitHub job (it can also be run for one state from the Actions tab); until a file exists, lefts there are described more cautiously. |
| `tools/fetch_signals.py` | Downloads a state's traffic lights in tiles, so the busy public servers don't time out. |
| `tools/build_signals.py` | Builds a traffic-light file from OpenStreetMap data. |
| `.github/workflows/refresh-signals.yml` | Monthly automatic refresh of the traffic-light files. |
| `test/test_app.py`, `test/test_more.py` | The automated checks (about 520), run in two batches. |

## Using the app

Open the live link. On a phone: Safari, then Share, then Add to Home Screen.

The live site's domain is registered with Stadia Maps, so it needs no key. A copy opened anywhere else
(from a file, or another domain) uses the free OpenStreetMap servers unless you add `?stadiaKey=...` once.
