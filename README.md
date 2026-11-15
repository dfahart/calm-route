# Calm Route

A route planner for anxious drivers: it finds the least stressful way to drive somewhere, scored around each
driver's own worries, then hands the trip to Google Maps, Apple Maps or Waze.

The full design, every rule and every decision is in the spec doc ("Calm Route: Product Spec").
The pre-launch checklist is in "Calm Route: What We're Missing".

## What's in this folder

| Path | What it is |
| --- | --- |
| `calm-route.html` | The whole app, in one file. Open it in Chrome or Safari. |
| `signals/US-MI.js` | Michigan traffic lights (35,481), so the app can tell lefts with a light from lefts without one. |
| `signals/US-IN.js`, `signals/US-OH.js` | Indiana and Ohio traffic lights. Not built yet: the monthly GitHub job creates them on its first run (or start it by hand from the Actions tab). Until then the app describes lefts there more cautiously. |
| `tools/csp.py` | **Run after every edit to calm-route.html.** Re-stamps the security policy with the script's fingerprint; without it the app won't run. |
| `tools/build_signals.py` | Builds a traffic-light file from OpenStreetMap data. |
| `.github/workflows/refresh-signals.yml` | Monthly automatic refresh of the traffic-light file (once the project is on GitHub). |
| `test/test_app.py`, `test/test_more.py` | The automated checks (about 440), run in two batches. |

## Using the app

1. Open `calm-route.html`.
2. Add the Stadia Maps key once: "Add your Stadia Maps key" under the address boxes. It's saved in that browser only, never in the file.

## Running the checks

Needs Python 3, Playwright and Chrome, plus Leaflet for the tests:

```
cd test
npm install            # installs Leaflet 1.9.4 for the test copy
pip install playwright
python3 test_app.py    # about 10 minutes
python3 test_more.py   # about 3 minutes
```

The checks use stand-in map, search, weather and fuel services, so they never touch the real ones or cost anything.

## After editing the app

```
python3 tools/csp.py calm-route.html
```
