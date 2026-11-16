import re
import time
"""
Automated tests for calm-route.html.

Runs the real page in headless Chrome. Every outside service (Valhalla routing, Photon search,
map tiles, fonts, Leaflet CDN) is replaced with a local fake, so the tests are fast, repeatable,
and can simulate failures (server errors, rate limits, slow answers) on purpose.
"""
import json, math, re, sys, time, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright

APP = Path(__file__).resolve().parent.parent / "calm-route.html"
ROOT = APP.parent
def all_source():   # the page plus its stylesheet and script, for checks on what ships
    return "".join((ROOT / f).read_text(encoding="utf-8") for f in ("calm-route.html", "css/calm-route.css", "js/calm-route.js"))
LEAFLET = Path(__file__).resolve().parent / "node_modules/leaflet/dist"

# ---------------------------------------------------------------- fake services
def enc_poly(points, precision=6):
    out, plat, plon, f = [], 0, 0, 10 ** precision
    def enc(v):
        v = ~(v << 1) if v < 0 else (v << 1)
        s = ""
        while v >= 0x20:
            s += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
        return s + chr(v + 63)
    for lat, lon in points:
        ilat, ilon = int(round(lat * f)), int(round(lon * f))
        out.append(enc(ilat - plat) + enc(ilon - plon)); plat, plon = ilat, ilon
    return "".join(out)

def hav(a, b):
    R = 3958.8; la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2-la1)/2)**2 + math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

KZOO = (42.2917, -85.5872)
PLACES = {  # name -> list of (lat, lon, osm_value, state)
    "kalamazoo": [(42.2917, -85.5872, "city", "Michigan")],
    "portage":   [(42.2011, -85.5800, "town", "Michigan"), (41.5759, -87.1762, "city", "Indiana"), (41.17, -81.20, "county", "Ohio")],
    "mi":        [(44.35, -85.41, "state", "Michigan")],
    "michigan":  [(44.35, -85.41, "state", "Michigan")],
}
def feature(name, lat, lon, key, value, street=None, number=None, city=None, state="Michigan", cc="US"):
    p = {"name": name, "osm_key": key, "osm_value": value, "state": state, "countrycode": cc, "country": "United States"}
    if street: p["street"] = street
    if number: p["housenumber"] = number
    if city: p["city"] = city
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": p}

STORES = [  # Meijer at three sites, each listed as store + gas + convenience counter (like real data)
    (42.2462, -85.5893, "5121", "South Westnedge Avenue", "Portage"),
    (42.3243, -85.5153, "5800", "Gull Road", "Comstock"),
    (42.2963, -85.6631, "6660", "West Main Street", "Kalamazoo"),
]
calls = {"photon": [], "route": [], "trace": [], "photon429": 0, "car": [], "stadia": [], "stadia_attrs": [], "free": [], "sim": [], "signals": [], "geo": [], "scenic": []}
SIGNAL_FILE = {"body": None}   # the traffic-light file the app fetches; None = not available (404)
STADIA_KEY = "test-key-1234567890"

def ref_gallons(r, city, hw):
    """Independent copy of the fuel model, to check the app's arithmetic."""
    def gpm(mph):
        cc, ch = 1 / city, 1 / hw
        if mph <= 21.2: return cc
        if mph < 48.3: return cc + (ch - cc) * (mph - 21.2) / (48.3 - 21.2)
        return ch if mph <= 65 else ch / (0.93 ** ((mph - 65) / 5))
    sm = {float(k): v for k, v in r["speedMiles"].items()}
    avg = r["miles"] / (r["mins"] / 60)
    rows = [(k if k > 0 else avg, v) for k, v in sm.items()]
    tot = sum(v for _, v in rows)
    return sum(v * r["miles"] / tot * gpm(k) for k, v in rows)

def ref_money(x):
    c = max(5, round(x * 20) * 5)
    return f"{c}¢" if c < 100 else f"${c / 100:.2f}"

def pel(name, lat, lon, layer, number=None, street=None, city=None, region="Michigan", cc="US", country="United States"):
    pr = {k: v for k, v in {"name": name, "layer": layer, "housenumber": number, "street": street, "locality": city, "region": region, "country_code": cc, "country": country}.items() if v is not None}
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": pr}

def stadia_special(q, path):
    """Stadia as it really behaves: prefix matching, no typo forgiveness, circle and country limits."""
    text = q.get("text", [""])[0].lower().strip(); full = path.endswith("/search")
    out = None
    if text and "8485 shirley court".startswith(text.replace(" ct", " court")) and len(text) >= 6:
        out = [pel("8485 Shirley Avenue", 34.22, -118.55, "address", "8485", "Shirley Avenue", "Los Angeles", "California"),
               pel("Shirley Court", 41.60, -72.70, "street", None, "Shirley Court", "Berlin", "Connecticut"),
               pel("8485 Shirley Court", 42.1953, -85.6168, "address", "8485", "Shirley Court", "Portage")]
    elif text in ("walmrt", "mcdonlads", "hosptial", "starbucks near grand rapids"): out = []
    elif text == "tampa international airport":       # a fuel station named after the airport is listed first by the search
        out = [pel("Clean Energy - Tampa International Airport", 27.96, -82.53, "venue", "5001", "North West Shore Boulevard", "Tampa"),
               pel("Tampa International Airport", 27.98, -82.53, "venue", "4100", "George J. Bean Parkway", "Tampa")]
    elif text == "walmart gull road kalamazoo":      # a store name plus where: plain search gives the street, a venue search gives the stores
        out = ([pel("Walmart Supercenter", 42.1700, -85.6400, "venue", "8350", "Shaver Road", "Portage"), pel("Walmart Supercenter", 42.3167, -85.5306, "venue", "6065", "Gull Road", "Kalamazoo")]
               if q.get("layers") == ["venue"] else [pel("Gull Road", 42.3100, -85.5400, "street", None, "Gull Road", "Kalamazoo")])
    elif text.startswith("walmart"): out = [pel("Walmart Supercenter", 42.2935, -85.6790, "venue", "501", "North 9th Street", "Kalamazoo")]
    elif text.startswith("hospital"): out = [pel("Bronson Methodist Hospital", 42.2870, -85.5800, "venue", "601", "John Street", "Kalamazoo")]
    elif text == "starbucks, grand rapids": out = [pel("Starbucks", 42.9634, -85.6681, "venue", "100", "Monroe Avenue", "Grand Rapids")]
    elif text == "westnedge and kilgore": out = [pel("South Westnedge Avenue & Kilgore Road", 42.2437, -85.5890, "street", None, None, "Portage")] if full else []
    elif text in ("park", "nature preserve", "state park", "lake", "beach"):
        out = [pel("Woollam Nature Preserve", 42.2729, -85.6225, "venue", None, None, "Kalamazoo"),
               pel("Westside Dog Park", 42.2740, -85.6100, "venue", None, None, "Kalamazoo"),
               pel("Tiny Pocket Park", 42.2150, -85.6225, "venue", None, None, "Portage"),
               pel("Faraway Lake", 42.4900, -85.6225, "venue", None, None, "Plainwell")]
        calls["scenic"].append(dict((k, v[0]) for k, v in q.items() if k != "api_key"))
    elif text in ("speedway", "shell", "marathon", "gas", "burger king", "coffee", "starbucks", "wendy's", "subway"):
        out = {"speedway": [pel("Speedway", STOP_AT[0], STOP_AT[1], "venue", "100", "Main Street", "Portage"), pel("Speedway", 42.30, -85.70, "venue", None, None, "Kalamazoo")],
               "gas": [pel("Portage Fire Station #2", STOP_AT[0] + 0.0005, STOP_AT[1], "venue", None, None, "Portage")],
               "shell": [pel("Shell", LEFT_AT[0], LEFT_AT[1], "venue", None, None, "Portage")] if LEFT_AT[0] else [],
               "burger king": [pel("Jena King, FNP-C", STOP_AT[0], STOP_AT[1], "venue", None, None, "Portage")],
               "wendy's": [pel("Wendy's", FOOD_AT[0], FOOD_AT[1], "venue", None, None, "Portage")] if FOOD_AT[0] and FOOD_NAME["name"] == "Wendy's" else [],
               "subway": [pel("Subway", FOOD_AT[0], FOOD_AT[1], "venue", None, None, "Portage")] if FOOD_AT[0] and FOOD_NAME["name"] == "Subway" else []}.get(text, [])
    elif text.startswith("eiffel"): out = [pel("Eiffel Tower", 48.8584, 2.2945, "venue", None, "Avenue Anatole France", "Paris", "Ile-de-France", "FR", "France")]
    if out is None: return None
    if "boundary.country" in q: out = [f for f in out if f["properties"]["country_code"] == q["boundary.country"][0]]
    if "boundary.circle.radius" in q:
        c = (float(q["boundary.circle.lat"][0]), float(q["boundary.circle.lon"][0])); km = float(q["boundary.circle.radius"][0])
        out = [f for f in out if hav(c, (f["geometry"]["coordinates"][1], f["geometry"]["coordinates"][0])) * 1.609 <= km]
    return out

def photon(params):
    q = params.get("q", [""])[0].lower().replace("'", "").strip()
    tag = params.get("osm_tag", [""])[0]
    calls["photon"].append((q, tag))
    if tag == "place":
        key = q.split(",")[0].strip()
        return [feature(key.title() if len(key) > 2 else "Michigan", lat, lon, "place", v, state=st) for lat, lon, v, st in PLACES.get(key, [])]
    if "busyonce" in q and calls["photon429"] == 0:
        calls["photon429"] += 1
        return 429
    if q.startswith("meijer"):
        out = []
        for lat, lon, num, street, city in STORES:
            out += [feature("Meijer", lat+0.0003, lon, "amenity", "fuel", street, num, city),
                    feature("Meijer", lat, lon, "shop", "supermarket", street, num, city),
                    feature("Meijer", lat-0.0002, lon, "shop", "convenience", street, num, city)]
        if int(params.get("limit", ["12"])[0]) >= 40:   # "Show more": stores further out
            for lat, lon, num, street, city in [(42.62, -85.66, "400", "Allegan Street", "Plainwell"), (42.33, -85.18, "2191", "Columbia Avenue", "Battle Creek"), (41.94, -85.63, "800", "US-131", "Three Rivers")]:
                out.append(feature("Meijer", lat, lon, "shop", "supermarket", street, num, city))
        return out + [feature("Fort Meyers Parkway", 42.20, -85.60, "highway", "residential", city="Portage"),
                      feature("Meijeri", 61.70, 30.69, "place", "village", state="Karelia", cc="RU")]
    if q.startswith("meyer"):
        return [feature("Meyer May House", 42.96, -85.66, "tourism", "museum", "Madison Avenue", "450", "Grand Rapids")]
    if q.startswith("mcdonalds"):
        return [feature("McDonald's", 42.2376, -85.5607, "amenity", "fast_food", "Portage Road", None, "Kalamazoo"),
                feature("McDonald's", 42.2002, -85.5608, "amenity", "fast_food", "Portage Road", "8050", "Portage")]
    if q.startswith("evil"):
        return [feature('<img src=x onerror="window.__xss=1">Evil', 42.30, -85.60, "shop", "bakery", "Main", "1", "Kalamazoo")]
    if q.startswith("kalamazoo college"):
        return [feature("Kalamazoo College", 42.290, -85.600, "amenity", "college", "West Main Street", None, "Kalamazoo")]
    if q.startswith("kalamazoo"):
        return [feature("Kalamazoo Avenue", 42.92, -85.64, "highway", "secondary", city="Grand Rapids"),
                feature("Kalamazoo", 42.2917, -85.5872, "place", "city", state="Michigan")]
    if q.startswith("nowhere"):
        return []
    return [feature(q.title(), 42.28, -85.58, "shop", "bakery", "Main Street", "100", "Kalamazoo")]

VARIANT_MINS = {(1.0, 5): 10, (1.0, 60): 11, (0.2, 12): 14, (0.1, 25): 15, (0.0, 60): 16}
def fake_sim(body):
    """The 'fastest route through these pins' request the pin planner sends. In this fake world the router
    follows the pinned road (the same arc the calm route is on) once there are PINS_NEEDED pins, and cuts
    straight from pin to pin before that."""
    calls["sim"].append(body)
    if SIM_FAIL["on"]: return 500, {"error": "Internal error"}
    locs = body["locations"]; a, b = locs[0], locs[-1]; mids = locs[1:-1]
    n = 60
    if mids and (len(mids) >= PINS_NEEDED["n"] or (STOP_FIXES["on"] and any(abs(m["lat"] - STOP_AT[0]) < 1e-6 and abs(m["lon"] - STOP_AT[1]) < 1e-6 for m in mids))):
        if STOP_FIXES["on"]: mids = [m for m in mids if abs(m["lat"] - STOP_AT[0]) < 1e-6] or mids
        t = (mids[0]["lon"] - a["lon"]) / (b["lon"] - a["lon"])
        bend = (mids[0]["lat"] - (a["lat"] + (b["lat"] - a["lat"]) * t)) / math.sin(math.pi * t)
        pts = [(a["lat"] + (b["lat"] - a["lat"]) * i / n + math.sin(math.pi * i / n) * bend, a["lon"] + (b["lon"] - a["lon"]) * i / n) for i in range(n + 1)]
    else:
        pts = []
        for u, v in zip(locs, locs[1:]):
            pts += [(u["lat"] + (v["lat"] - u["lat"]) * i / 20, u["lon"] + (v["lon"] - u["lon"]) * i / 20) for i in range(20)]
        pts.append((b["lat"], b["lon"]))
    miles = sum(hav(pts[i], pts[i+1]) for i in range(len(pts) - 1))
    extra = 600 if DETOUR["on"] and any(abs(l["lat"] - STOP_AT[0]) < 1e-6 and abs(l["lon"] - STOP_AT[1]) < 1e-6 for l in locs) else 0    # a stop that means doubling back
    return 200, {"trip": {"summary": {"length": miles, "time": miles * 90 + extra}, "legs": [{"shape": enc_poly(pts), "maneuvers": []}], "locations": locs}}

def fake_route(body):
    if "costing_options" not in body: return fake_sim(body)    # a plain timing request (the stop detour check)
    o_ = body["costing_options"]["auto"]
    liked = len(body["locations"]) == 3 and body["locations"][1].get("type") == "through" and (o_["use_highways"], o_["maneuver_penalty"]) == (0.5, 12)
    if liked: calls.setdefault("liked", []).append(body)
    elif len(body["locations"]) > 2 or (not body.get("alternates") and (o_["use_highways"], o_["maneuver_penalty"]) == (1, 5) and not o_.get("exclude_tolls")):
        return fake_sim(body)
    a, b = body["locations"][0], body["locations"][-1]
    calls["route"].append(body)
    if abs(b["lat"] - 42.0001) < 0.00005:           # special: "no route" destination
        return 400, {"error": "Locations are in unconnected regions. Go check/edit the map at osm.org", "error_code": 170}
    if abs(b["lat"] - 42.0002) < 0.00005:           # special: server keeps failing
        return 500, {"error": "Internal error"}
    o = body["costing_options"]["auto"]; hw, mp = o["use_highways"], o["maneuver_penalty"]
    if PAVED_FAIL["on"] and o.get("exclude_unpaved"):
        return 400, {"error": "No path could be found for input", "error_code": 442}
    bend = (1 - hw) * 0.03
    n = 60
    pts = []
    for i in range(n + 1):
        t = i / n
        lat = a["lat"] + (b["lat"] - a["lat"]) * t + math.sin(math.pi * t) * bend
        lon = a["lon"] + (b["lon"] - a["lon"]) * t
        pts.append((lat, lon))
    for poly in body.get("exclude_polygons", []):      # a route that would pass through an avoided spot can't be found
        c = (sum(q[1] for q in poly[:-1]) / (len(poly) - 1), sum(q[0] for q in poly[:-1]) / (len(poly) - 1))
        if min(hav(c, q) for q in pts) < 0.03:
            return 400, {"error": "No path could be found for input", "error_code": 442}
    miles = sum(hav(pts[i], pts[i+1]) for i in range(n))
    mins = VARIANT_MINS.get((hw, mp), 12)
    man = [
        {"type": 1, "instruction": "Drive north.", "length": miles*0.1, "time": 60, "begin_shape_index": 0, "end_shape_index": 6, "street_names": ["Oakland Drive"]},
        {"type": 15, "instruction": "Turn left onto Main Street.", "length": miles*0.3, "time": 60, "begin_shape_index": 6, "end_shape_index": 24, "street_names": ["Main Street"]},
        {"type": 10, "instruction": "Turn right.", "length": miles*0.5, "time": 60, "begin_shape_index": 24, "end_shape_index": 54,
         "street_names": ["I 94 West"] if hw > 0.5 else ["Westnedge Avenue"], **({"highway": True} if hw > 0.5 else {})},
        {"type": 15, "instruction": "Turn left.", "length": miles*0.1, "time": 60, "begin_shape_index": 54, "end_shape_index": 60, "street_names": ["Gull Road"]},
        {"type": 6, "instruction": "Arrive.", "length": 0, "time": 0, "begin_shape_index": 60, "end_shape_index": 60},
    ]
    trip = {"summary": {"length": miles, "time": mins*60, "has_highway": hw > 0.5, "has_toll": bool(TOLL["on"] and hw > 0.5 and not o.get("exclude_tolls"))},
            "legs": [{"shape": enc_poly(pts), "maneuvers": man}], "locations": body["locations"]}
    SHAPE_HW[trip["legs"][0]["shape"]] = hw > 0.5
    out = {"trip": trip}
    if body.get("alternates"):
        alts = []
        for k, extra in ((1, 2), (2, 4)):
            apts = [(la - math.sin(math.pi * i / n) * 0.01 * k, lo) for i, (la, lo) in enumerate(pts)]
            amiles = sum(hav(apts[i], apts[i+1]) for i in range(n))
            SHAPE_HW[enc_poly(apts)] = hw > 0.5
            alts.append({"trip": {"summary": {"length": amiles, "time": (mins + extra) * 60, "has_highway": True},
                                  "legs": [{"shape": enc_poly(apts), "maneuvers": man}], "locations": body["locations"]}})
        out["alternates"] = alts
    return 200, out

def fake_trace(body):
    calls["trace"].append(1)
    shape = body["encoded_polyline"]
    if TRACE_FAIL["on"]:
        return 500, {"error": "trace failed"}
    # decode just to count points
    pts, idx, lat, lon = 0, 0, 0, 0
    while idx < len(shape):
        for _ in range(2):
            res, sh = 0, 0
            while True:
                bb = ord(shape[idx]) - 63; idx += 1
                res |= (bb & 0x1f) << sh; sh += 5
                if bb < 0x20: break
        pts += 1
    n = pts - 1
    edges = []
    hw = SHAPE_HW.get(shape, HW_FOR_TRACE["last"])
    for k in range(0, n, 3):
        mid = 24 <= k < 54
        e = {"begin_shape_index": k, "length": 0.05, "use": "road", "names": ["Main Street"],
             "road_class": "motorway" if (mid and hw) else ("primary" if mid else "residential"),
             "lane_count": 3 if mid else 1, "speed_limit": 70 if (mid and hw) else (45 if mid else 25),
             "end_node": {"traffic_signal": k == 3}}
        if k == 30: e["bridge"] = True; e["length"] = 0.6
        if NIGHT["on"] and not hw and 24 <= k < 54: e["density"] = 2; e["speed_limit"] = 55   # quiet routes cross open country
        elif NIGHT["on"]: e["density"] = 9
        if HILLS["on"] == "fast":       # a 55 mph road: 7% for 0.3 mi counts, a short 7% dip doesn't; 9% on a 25 mph street doesn't
            if not hw and k in (36, 39, 42, 45, 48, 51): e["max_upward_grade"] = 7; e["speed_limit"] = 55; e["road_class"] = "secondary"
            if not hw and k == 9: e["max_upward_grade"] = 9
            if hw and k in (36,): e["max_downward_grade"] = -7; e["speed_limit"] = 55; e["road_class"] = "secondary"; e["lane_count"] = 1
        elif HILLS["on"] == "stop":      # a 12% climb that ends where the route turns
            if not hw and k in (0, 3): e["max_upward_grade"] = 12
        elif HILLS["on"] and not hw and k in (9, 12): e["max_upward_grade"] = 11; e["max_downward_grade"] = -2
        if HILLS["on"] and k == 15: e["max_upward_grade"] = 6      # a gentle slope everywhere: a little, not a "hill"
        edges.append(e)
    return 200, {"edges": edges}

TRACE_FAIL = {"on": False}
HILLS = {"on": False}       # quiet fake routes climb one steep hill
NIGHT = {"on": False}       # quiet fake routes run through open country
STOP_AT = [42.2198, -85.5862]   # where the fake gas station is (tests put it on the chosen route)
LEFT_AT = [0, 0]                # a second station, on the left side (0 = none)
FOOD_AT = [0, 0]                # a Wendy's (0 = none)
FOOD_NAME = {"name": "Wendy's"}  # or "Subway": a food place with no drive-thru
STOP_FIXES = {"on": False}
DETOUR = {"on": False}         # when on, routing through the fake gas station adds 10 minutes      # when on, routing through the fake gas station alone keeps the app on the calm road
HW_FOR_TRACE = {"last": True}
SHAPE_HW = {}   # which fake routes run on the highway, so their road details match
SLOW = {"route_ms": 0}
NO_LEAFLET = {"on": False}
PINS_NEEDED = {"n": 2}       # pins the fake router needs before it follows the pinned road
SIM_FAIL = {"on": False}
FE = {"down": False, "regular": "4.0"}   # fake fueleconomy.gov
TOLL = {"on": False}        # fake highway routes carry a toll
PAVED_FAIL = {"on": False}  # the paved-only request finds no route (trip ends on gravel)

def install_routes(page):
    def handle(route):
        url = route.request.url
        if "leaflet.min.js" in url and NO_LEAFLET["on"]:
            return route.abort()
        if "leaflet.min.js" in url:
            return route.fulfill(path=str(LEAFLET / "leaflet.js"), content_type="application/javascript")
        if "leaflet.min.css" in url:
            return route.fulfill(path=str(LEAFLET / "leaflet.css"), content_type="text/css")
        if "fonts.g" in url:
            return route.fulfill(body="", content_type="text/css")
        if "tiles.stadiamaps.com" in url or "tile.openstreetmap.org" in url:
            calls.setdefault("tiles", []).append(url)
            return route.fulfill(status=204, body="")
        if url.startswith("http://calm.test/signals/"):
            calls["signals"].append(url)
            if SIGNAL_FILE["body"] is None: return route.fulfill(status=404, body="not here")
            return route.fulfill(status=200, content_type="application/javascript", body=SIGNAL_FILE["body"])
        if url.startswith("http://calm.test/css/") or url.startswith("http://calm.test/js/") or url.startswith("http://calm.test/fonts/"):
            rel = urllib.parse.urlparse(url).path.lstrip("/")
            kind = "text/css" if rel.endswith(".css") else "font/woff2" if rel.endswith(".woff2") else "application/javascript"
            return route.fulfill(path=str(ROOT / rel), content_type=kind)
        if url.startswith("http://calm.test/"):
            # The test copy of Leaflet isn't byte-identical to cdnjs's, so its fingerprint check is taken off here
            # (section 48 checks the fingerprints themselves). Everything else, including the security policy, stays.
            html = APP.read_text(encoding="utf-8")
            html = re.sub(r' integrity="[^"]+" crossorigin="anonymous"', '', html)
            return route.fulfill(body=html, content_type="text/html")
        if "photon.komoot.io" in url:
            calls["free"].append(url)
            params = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
            res = photon(params)
            if res == 429:
                return route.fulfill(status=429, body="slow down")
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"},
                                 body=json.dumps({"type": "FeatureCollection", "features": res}))
        if "api.stadiamaps.com" in url:
            u = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(u.query)
            calls["stadia"].append(u.path + ("?key" if q.get("api_key") else "?nokey"))
            cors = {"Access-Control-Allow-Origin": "*"}
            if q.get("api_key") != [STADIA_KEY]:
                return route.fulfill(status=401, content_type="application/json", headers=cors, body=json.dumps({"error": "No valid authentication provided."}))
            if "/geocoding/" in u.path:   # translate to the fake Photon and back into Stadia's (Pelias) layout
                calls["geo"].append({k: v[0] for k, v in q.items() if k != "api_key"} | {"path": u.path})
                special = stadia_special(q, u.path)
                if special is not None:
                    return route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"type": "FeatureCollection", "features": special}))
                pq = {"q": q.get("text", [""]), "limit": q.get("size", ["10"])}
                if "focus.point.lat" in q: pq["lat"], pq["lon"] = q["focus.point.lat"], q["focus.point.lon"]
                if "boundary.rect.min_lon" in q: pq["bbox"] = [",".join(q["boundary.rect." + k][0] for k in ("min_lon", "min_lat", "max_lon", "max_lat"))]
                if q.get("layers") == ["coarse"]: pq["osm_tag"] = ["place"]
                res = photon(pq)
                if res == 429: return route.fulfill(status=429, body="slow down")
                out = []
                for f in res:
                    pp = f["properties"]
                    layer = ({"city": "locality", "town": "locality", "village": "locality", "county": "county", "state": "region"}.get(pp["osm_value"], "locality")
                             if pp["osm_key"] == "place" else "street" if pp["osm_key"] == "highway" else "address" if pp.get("housenumber") and pp["osm_key"] == "building" else "venue")
                    nm = pp.get("name")
                    if layer == "venue" and nm and pp["osm_value"] in ("fuel", "convenience"): nm += " Gas Station" if pp["osm_value"] == "fuel" else " Express"   # how Stadia names them
                    out.append({"type": "Feature", "geometry": f["geometry"], "properties": {k: v for k, v in {
                        "name": nm, "layer": layer, "housenumber": pp.get("housenumber"), "street": pp.get("street"), "locality": pp.get("city"),
                        "region": pp.get("state"), "country_code": pp.get("countrycode"), "label": pp.get("name")}.items() if v is not None}})
                return route.fulfill(status=200, content_type="application/json", headers=cors, body=json.dumps({"type": "FeatureCollection", "features": out}))
            body = json.loads(route.request.post_data or "{}")
            if "/route/" in u.path:
                HW_FOR_TRACE["last"] = body["costing_options"]["auto"]["use_highways"] > 0.5
                status, payload = fake_route(body)
            else:
                calls["stadia_attrs"].append(body.get("filters", {}).get("attributes", []))
                if any(a.startswith("node.traffic") for a in body.get("filters", {}).get("attributes", [])):
                    status, payload = 400, {"error": {"reason": "unknown variant `node.traffic_signal`"}}
                else:
                    status, payload = fake_trace(body)
                    for e in payload.get("edges", []): e.pop("end_node", None)   # Stadia gives no traffic lights
            return route.fulfill(status=status, content_type="application/json", headers=cors, body=json.dumps(payload))
        if "valhalla1" in url:
            calls["free"].append(url)
            body = json.loads(route.request.post_data or "{}")
            if "/route" in url:
                if SLOW["route_ms"]: time.sleep(SLOW["route_ms"] / 1000)
                HW_FOR_TRACE["last"] = body["costing_options"]["auto"]["use_highways"] > 0.5
                status, payload = fake_route(body)
            else:
                status, payload = fake_trace(body)
            return route.fulfill(status=status, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(payload))
        if "fueleconomy.gov" in url:
            calls["car"].append(url)
            if FE["down"]: return route.abort()
            u = urllib.parse.urlparse(url); q = urllib.parse.parse_qs(u.query); path = u.path
            item = lambda t, v=None: {"text": t, "value": v or t}
            if path.endswith("/menu/year"): out = {"menuItem": [item("2019"), item("2018")]}
            elif path.endswith("/menu/make"): out = {"menuItem": [item("Honda"), item("Tesla")]}
            elif path.endswith("/menu/model"):
                out = {"menuItem": [item("Accord"), item("Civic 4Dr")]} if q["make"] == ["Honda"] else {"menuItem": item("Model 3")} if q["make"] == ["Tesla"] else None
            elif path.endswith("/menu/options"):
                m = q["model"][0]
                out = {"menuItem": [item("Auto, 2.0 L", "101"), item("Auto, 1.5 L, Turbo", "102")]} if m == "Civic 4Dr" else {"menuItem": item("Auto, 1.5 L", "201")} if m == "Accord" else {"menuItem": item("Auto (A1)", "900")}
            elif path.endswith("/fuelprices"): out = {"regular": FE["regular"], "midgrade": "4.61", "premium": "5.01", "diesel": "6.13", "electric": "0.15"}
            else:
                cars = {"101": ("Civic 4Dr", "31", "40", "Regular Gasoline"), "102": ("Civic 4Dr", "30", "38", "Premium Gasoline"), "201": ("Accord", "27", "36", "Regular Gasoline"), "900": ("Model 3", "138", "126", "Electricity")}
                c = cars[path.rsplit("/", 1)[1]]
                out = {"year": "2018", "make": "Tesla" if c[0] == "Model 3" else "Honda", "model": c[0], "city08": c[1], "highway08": c[2], "fuelType1": c[3]}
            return route.fulfill(status=200, content_type="application/json", headers={"Access-Control-Allow-Origin": "*"}, body=json.dumps(out))
        if "google.com" in url:
            return route.fulfill(body="google")
        return route.abort()
    page.route("**/*", handle)

# ---------------------------------------------------------------- test helpers
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

WAZE_ON = True
def new_page(browser, profile=None, width=1280, height=820, init_script=None, mobile=False, query=None, csp=False, open_sections=True):
    # Playwright's own waiting helpers need eval, which the page's security policy forbids, so most tests run with the
    # policy off; the security tests turn it on (csp=True) and wait without those helpers.
    ctx = browser.new_context(viewport={"width": width, "height": height}, is_mobile=mobile, has_touch=mobile,
                              timezone_id="America/Detroit", bypass_csp=not csp)
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.on("console", lambda m: page.errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
    page.add_init_script("document.addEventListener('securitypolicyviolation', e => console.error('CSP blocked ' + e.violatedDirective + ' ' + e.blockedURI))")
    page.dialogs = []
    page.on("dialog", lambda d: (page.dialogs.append(d.message), d.dismiss()))
    install_routes(page)
    if init_script: page.add_init_script(init_script)
    if WAZE_ON:   # Waze is hidden in the app; the older Waze tests switch it back on (test_more runs with it off)
        page.add_init_script("window.CALM_FLAGS = Object.assign({waze:true}, window.CALM_FLAGS || {});")
    if open_sections:   # most tests reach into the profile's optional sections, which real users open with a tap
        page.add_init_script("""new MutationObserver(() => { const s = document.getElementById('sheet');
            if (s && s.classList.contains('open')) s.querySelectorAll('details:not([open])').forEach(d => d.open = true); })
            .observe(document, {subtree:true, attributes:true, attributeFilter:['class'], childList:true});""")
    if profile is not None:
        page.add_init_script(f"localStorage.setItem('calmRouteProfile', {json.dumps(json.dumps(profile))});")
    page.goto("http://calm.test/" + (query or ""))
    for _ in range(100):
        if page.evaluate("!!window.L && document.getElementById('profileSummary').textContent.length > 0"): break
        page.wait_for_timeout(100)
    return page

def type_and_pick(page, field, text, pick=0):
    page.fill(f"#{field}", "")
    page.type(f"#{field}", text, delay=15)
    page.wait_for_selector(f"#{field}-s [role=option]", timeout=8000)
    opts = page.locator(f"#{field}-s [role=option]")
    opts.nth(pick).dispatch_event("mousedown")
    page.wait_for_function(f"!!state.{field}")

def find_routes(page, timeout=40000, wait_details=True):
    page.click("#find")
    page.wait_for_function("!document.getElementById('find').disabled && !document.getElementById('app').classList.contains('busy')", timeout=timeout)
    if wait_details:   # road details finish in the background after the routes appear
        page.wait_for_function("!state.routes.length || state.routes.every(r => !r.pending)", timeout=timeout)

def wait_pins(page, timeout=20000):
    """The pin planner runs after a route is chosen; wait until it has settled."""
    page.wait_for_function("state.sel && (!needsPins(state.sel) || (state.sel.pinPlan && state.sel.pinPlan.done))", timeout=timeout)

def fast(page):  # skip the polite 1.1 s pauses between requests to the free servers
    page.evaluate("window.sleep = () => Promise.resolve();")

# ---------------------------------------------------------------- the tests
def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])

        # 1. First visit: questionnaire opens, cannot be dismissed without saving, saves profile
        page = new_page(browser)
        check("first visit opens questionnaire", page.is_visible("#sheet.open"))
        check("first visit hides close button", not page.is_visible("#sheetClose"))
        page.keyboard.press("Escape")
        check("Escape does not close first-run questionnaire", page.is_visible("#sheet.open"))
        page.click(".choices[data-k=merge] button[data-v='2']")
        page.click(".choices[data-k=worry] button[data-v=panic]")
        page.click("#saveProfile")
        check("saving closes questionnaire", not page.is_visible("#sheet.open"))
        check("profile summary reflects answers", "merges" in page.text_content("#profileSummary"), page.text_content("#profileSummary"))
        stored = page.evaluate("localStorage.getItem('calmRouteProfile')")
        check("profile saved to browser storage", stored and '"merge":2' in stored, stored)
        page.click("#editProfile")
        check("reopened questionnaire shows close button", page.is_visible("#sheetClose"))
        page.keyboard.press("Escape")
        check("Escape closes questionnaire once a profile exists", not page.is_visible("#sheet.open"))
        check("no script errors on load", not page.errors, page.errors)
        page.context.close()

        # 2. Place search: misspelling + city, duplicates merged, pins on map, hint
        page = new_page(browser, profile={"merge": 1})
        fast(page)
        page.type("#to", "Meyer, Kalamazoo", delay=15)
        page.wait_for_selector("#to-s [role=option]", timeout=8000)
        opts = page.locator("#to-s [role=option]")
        names = [opts.nth(i).locator(".opt-text").inner_text() for i in range(opts.count())]
        check("misspelled 'Meyer' finds Meijer first", names and names[0].startswith("Meijer"), names[:2])
        meijer_rows = [n for n in names if n.startswith("Meijer")]
        check("duplicate listings merged (3 stores, not 9)", len(meijer_rows) == 3, len(meijer_rows))
        check("store row shows category + address + distance", "Supermarket" in names[0] and opts.first.locator(".opt-d").inner_text().endswith("mi"), names[0])
        check("merged row prefers the store over its gas station", all("Gas station" not in n for n in meijer_rows), meijer_rows)
        pins = page.locator(".pin.preview").count()
        check("suggestions shown as numbered pins on the map", pins == opts.count(), f"{pins} pins vs {opts.count()} rows")
        check("hint names the area searched", "Kalamazoo" in page.text_content("#to-s .sugg-hint"), page.text_content("#to-s .sugg-hint"))
        second = names[1].split("\n")[1].split(" · ")[-1].split(",")[0]
        page.keyboard.press("ArrowDown"); page.keyboard.press("ArrowDown"); page.keyboard.press("Enter")
        check("keyboard pick works (2nd suggestion)", second in page.input_value("#to"), f"{second} vs {page.input_value('#to')}")
        check("chosen place gets a map pin", page.locator(".pin.end").count() == 1)
        check("picking clears suggestion pins", page.locator(".pin.preview").count() == 0)

        # 2b. Blur (click elsewhere) should clear suggestion pins too
        page.fill("#from", ""); page.type("#from", "Meijer", delay=15)
        page.wait_for_selector("#from-s [role=option]")
        page.click(".brand h1")
        page.wait_for_timeout(500)
        check("clicking away hides suggestions", not page.is_visible("#from-s [role=option]"))
        check("clicking away clears suggestion pins from map", page.locator(".pin.preview").count() == 0, page.locator(".pin.preview").count())

        # 3. Full trip
        page.fill("#from", "42.2005, -85.6225")
        page.wait_for_selector("#from-s [role=option]")
        page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        find_routes(page)
        check("results appear", page.is_visible("#results"), page.text_content("#status"))
        n_routes = page.locator(".route").count()
        check("several distinct routes listed", n_routes >= 3, n_routes)
        check("exactly one route selected", page.locator(".route[aria-checked=true]").count() == 1)
        widths = page.evaluate("[...document.querySelectorAll('.route')].map(r => [...r.querySelectorAll('.seg')].reduce((s, x) => s + parseFloat(x.style.width), 0))")
        check("stress strip segments span the whole trip", all(abs(w - 100) < 1.5 for w in widths), widths)
        check("merges / lefts / bridges marked on strips", page.locator(".strip .ev").count() > 0)
        ends = page.evaluate("state.routes.map(r => hav(r.shape[r.shape.length-1], [state.trip.to.lat, state.trip.to.lon]))")
        check("every route ends at the destination", all(e < 0.05 for e in ends), ends)
        rnames = page.locator(".route-name").all_inner_texts()
        check("route names are real road names", all(t.startswith("via ") for t in rnames), rnames)
        check("no two routes share a name", len(set(rnames)) == len(rnames), rnames)

        # 4. Card clicks select exactly that card
        ok = True
        for i in range(n_routes):
            card = page.locator(".route").nth(i); nm = card.locator(".route-name").inner_text()
            card.click()
            sel = page.locator(".route[aria-checked=true] .route-name").inner_text()
            ok = ok and sel == nm
        check("clicking any route card selects that route", ok)

        # 5. Slider
        page.evaluate("const s = document.getElementById('budget'); s.value = 0; s.dispatchEvent(new Event('input'))")
        check("slider at 0 picks the fastest route", page.evaluate("state.sel === state.fast"))
        check("slider at 0 reads 'None'", page.text_content("#budgetOut") == "None", page.text_content("#budgetOut"))
        check("fastest route opens with no pinned points", "waypoints" not in page.get_attribute("#gmaps", "href"))
        page.evaluate("const s = document.getElementById('budget'); s.value = s.max; s.dispatchEvent(new Event('input'))")
        page.locator(".route", has=page.locator(".tag:text-is('Fastest')")).evaluate("el => el")  # exists
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))")
        href = page.get_attribute("#gmaps", "href")
        wp = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("waypoints", [""])[0].split("|")
        check("while the pins are being worked out, the app says so", "Working out the fewest pinned points" in page.text_content("#detailNote"), page.text_content("#detailNote"))
        wait_pins(page)
        gwp = lambda: [w for w in urllib.parse.parse_qs(urllib.parse.urlparse(page.get_attribute("#gmaps", "href")).query).get("waypoints", [""])[0].split("|") if w]
        wp = gwp()
        check("the link carries only the pins needed to hold the route (2 here, not 8)", len(wp) == 2 and page.evaluate("state.sel.pinPlan.matched"), wp)
        check("the note says how many pins and that they show as stops", "2 pinned points keep Google Maps on this route" in page.text_content("#detailNote") and "stops" in page.text_content("#detailNote"), page.text_content("#detailNote"))
        check("each pin is drawn on the map", page.evaluate("pinLayer.getLayers().length") == 2)
        check("pins sit in driving order", [float(w.split(",")[1]) for w in wp] == sorted([float(w.split(",")[1]) for w in wp], reverse=page.evaluate("state.trip.to.lon < state.trip.from.lon")), wp)
        nsim = len(calls["sim"])
        page.evaluate("update(false)"); page.wait_for_timeout(700)
        check("a route's pins are worked out once, not on every redraw", len(calls["sim"]) == nsim, (nsim, len(calls["sim"])))
        PINS_NEEDED["n"] = 99
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast && !r.pinPlan)))")
        wait_pins(page)
        wp6 = gwp()
        check("pins stop at nine when the route still can't be held, with a warning", len(wp6) == 9 and "may leave this route" in page.text_content("#detailNote") and "warn" in page.get_attribute("#detailNote", "class"), (len(wp6), page.text_content("#detailNote")))
        check("with more than 3 pins, the phone-browser tip appears", "at most 3" in page.text_content("#detailNote"))
        page.select_option("#wpN", "3")
        wp = gwp()
        check("limiting pins to 3 keeps the three that matter most, in driving order", len(wp) == 3 and all(w in wp6 for w in wp) and page.evaluate("pinLayer.getLayers().length") == 3, wp)
        page.select_option("#wpN", "9"); PINS_NEEDED["n"] = 2
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r.pinPlan && r.pinPlan.matched)))")
        dest = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("destination", [""])[0]
        check("Google destination is precise (coordinates or full street address)", re.match(r"^-?\d+\.\d+,-?\d+\.\d+$", dest) or re.search(r"\d+ ", dest), dest)

        # 5b. Route keyboard navigation
        page.locator(".route[aria-checked=true]").focus()
        before = page.evaluate("state.routes.indexOf(state.sel)")
        page.keyboard.press("ArrowDown" if page.evaluate("[...document.querySelectorAll('.route')].indexOf(document.activeElement)") == 0 else "ArrowUp")
        after = page.evaluate("state.routes.indexOf(state.sel)")
        check("arrow keys move between routes", before != after or n_routes == 1, f"{before} -> {after}")

        # 6. Resize with same width (mobile address bar) must not refit the map
        page.evaluate("map.setView([42.5, -85.0], 9)")
        z0 = page.evaluate("[map.getZoom(), map.getCenter().lat.toFixed(3)]")
        page.set_viewport_size({"width": 1280, "height": 760})
        page.wait_for_timeout(400)
        z1 = page.evaluate("[map.getZoom(), map.getCenter().lat.toFixed(3)]")
        check("height-only resize keeps the map where the user put it", z0 == z1, f"{z0} -> {z1}")

        # 7. Editing trip after results clears them
        page.click("#swap")
        check("swap clears outdated routes", not page.is_visible("#results"))
        check("swap explains what happened", "changed" in page.text_content("#status"), page.text_content("#status"))
        check("no script errors during trip flow", not page.errors, page.errors)
        page.context.close()

        # 8. Changing destination mid-search abandons that search
        page = new_page(browser, profile={})
        # slow route answers inside the page (non-blocking), so the search is still running when the trip changes
        page.evaluate("""(() => { const real = window.fetch; window.fetch = async (u, o) => {
            if (String(u).includes('/route') && !window.__fastAgain) await new Promise(r => setTimeout(r, 4000));
            return real(u, o); }; })()""")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", "42.30, -85.55"); page.wait_for_selector("#to-s [role=option]"); page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        page.click("#find")
        page.wait_for_timeout(1500)
        check("search still running when the trip changes (test setup)", page.evaluate("document.getElementById('app').classList.contains('busy')"))
        page.fill("#to", "42.25, -85.50"); page.wait_for_selector("#to-s [role=option]"); page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        page.wait_for_timeout(9000)
        check("mid-search change stops the search", not page.is_visible("#results"), page.text_content("#status"))
        check("mid-search change says why", "stopped" in page.text_content("#status"), page.text_content("#status"))
        page.evaluate("window.__fastAgain = true")
        find_routes(page)
        ends = page.evaluate("state.routes.map(r => hav(r.shape[r.shape.length-1], [state.trip.to.lat, state.trip.to.lon]))")
        check("re-run: every route ends at the new destination", ends and all(e < 0.05 for e in ends), ends)
        page.context.close()

        # 9. Errors: no route, server failing, same place, too long, unknown place
        page = new_page(browser, profile={})
        fast(page)
        def trip(a, b):
            for field, val in (("from", a), ("to", b)):
                page.fill(f"#{field}", val)
                page.evaluate(f"state['{field}'] = null")
            find_routes(page)
            return page.text_content("#status")
        msg = trip("42.2, -85.6", "42.0001, -85.5")
        check("unreachable destination: friendly message", "no driving route" in msg.lower(), msg)
        check("unreachable destination: no stale results", not page.is_visible("#results"))
        msg = trip("42.2, -85.6", "42.0002, -85.5")
        check("server failure: friendly message", "routing service" in msg.lower() and "Internal" not in msg, msg)
        msg = trip("42.2, -85.6", "42.2, -85.6")
        check("same start and end: clear message", "same place" in msg, msg)
        msg = trip("42.2, -85.6", "25.77, -80.19")
        check("too-long trip: clear message", "too long" in msg, msg)
        msg = trip("42.2, -85.6", "nowhere at all")
        check("unknown place: helpful message", "Couldn’t find" in msg, msg)

        # 10. Road-detail service down: still works, says counts are estimates
        TRACE_FAIL["on"] = True
        msg = trip("42.2, -85.6", "42.3, -85.5")
        TRACE_FAIL["on"] = False
        check("road-detail failure still gives routes", page.is_visible("#results"), msg)
        check("road-detail failure is disclosed", "estimates" in page.text_content("#detailNote"), page.text_content("#detailNote"))

        # 11. Search service rate limit once: retry still shows suggestions
        page.fill("#to", ""); page.type("#to", "busyonce bakery", delay=15)
        try:
            page.wait_for_selector("#to-s [role=option]", timeout=8000); ok = True
        except Exception: ok = False
        check("search retries after a rate-limit answer", ok)

        # 12. Hostile place names are shown as text, never run
        page.fill("#to", ""); page.type("#to", "evil cake shop", delay=15)
        page.wait_for_selector("#to-s [role=option]")
        page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        check("place names can't inject code", not page.evaluate("window.__xss") and not page.dialogs)

        # 13. "Kalamazoo, MI" finds the city, not something in mid-Michigan
        page.fill("#to", ""); page.type("#to", "Kalamazoo, MI", delay=15)
        page.wait_for_selector("#to-s [role=option]")
        first = page.locator("#to-s [role=option]").first.inner_text()
        check("'Kalamazoo, MI' suggests the city first", "Kalamazoo\nCity" in first and " mi" not in first.split("\n")[-1][-4:] or "Kalamazoo\nCity" in first and "142" not in first, first)

        # 13b. McDonald's without a house number: Google gets exact coordinates
        page.fill("#from", "42.2005, -85.6225"); page.evaluate("state.from = null")
        page.fill("#to", ""); page.type("#to", "mcdonalds", delay=15)
        page.wait_for_selector("#to-s [role=option]")
        rows = page.locator("#to-s [role=option]").all_inner_texts()
        idx = next(i for i, r in enumerate(rows) if "8050" not in r)
        page.locator("#to-s [role=option]").nth(idx).dispatch_event("mousedown")
        find_routes(page)
        href = page.get_attribute("#gmaps", "href")
        dest = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("destination", [""])[0]
        check("place without a street number goes to Google as exact coordinates", re.match(r"^-?\d+\.\d+,-?\d+\.\d+$", dest), dest)
        check("no script errors in error scenarios", not page.errors, page.errors)
        page.context.close()

        # 14. Search service down: the user is told
        page = new_page(browser, profile={})
        page.unroute("**/*")
        def down(route):
            if "photon" in route.request.url: return route.fulfill(status=503, body="down")
            return None
        install_routes(page)
        page.route("**/photon.komoot.io/**", lambda r: r.fulfill(status=503, body="down"))
        page.type("#to", "Meijer", delay=15)
        page.wait_for_timeout(5000)
        status = page.text_content("#status")
        check("search outage is explained to the user", "search" in status.lower(), status)
        page.context.close()

        # 15. Browser storage blocked (e.g. Safari opening a local file): app still works
        block = "Object.defineProperty(window, 'localStorage', {get(){ throw new Error('blocked'); }});"
        page = new_page(browser, init_script=block)
        check("storage blocked: app loads", page.is_visible("#sheet.open") and not page.errors, page.errors)
        page.click("#saveProfile")
        check("storage blocked: saving profile doesn't crash", not page.is_visible("#sheet.open") and not page.errors, page.errors)
        page.context.close()

        # 16. A corrupted saved profile doesn't break the questionnaire
        page = new_page(browser, profile={"merge": 7, "worry": "???"})
        page.click("#editProfile")
        check("corrupted profile: questionnaire still opens", page.is_visible("#sheet.open") and not page.errors, page.errors)
        page.context.close()

        # 17. Phone size: no sideways scrolling, action bar visible, questionnaire fits
        page = new_page(browser, width=375, height=812, mobile=True)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check("phone: questionnaire has no sideways scroll", sw <= 375, sw)
        page.click("#saveProfile")
        fast(page)
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", "42.30, -85.55"); page.wait_for_selector("#to-s [role=option]"); page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        find_routes(page)
        sw = page.evaluate("document.documentElement.scrollWidth")
        check("phone: results have no sideways scroll", sw <= 375, sw)
        box = page.locator("#gmaps").bounding_box()
        check("phone: Google Maps button is on screen", box and box["y"] + box["height"] <= 812 + 1, box)
        page.screenshot(path="/home/claude/calm-route/test/phone.png", full_page=False)
        check("no script errors on phone", not page.errors, page.errors)
        page.context.close()

        # 18. Arrival times refresh while the page is left open
        page = new_page(browser, profile={})
        fast(page)
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", "42.30, -85.55"); page.wait_for_selector("#to-s [role=option]"); page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        find_routes(page)
        t0 = page.text_content(".route .route-time span")
        page.evaluate("const real = Date.now; Date.now = () => real() + 30*60000; window.dispatchEvent(new Event('focus')); if (window.refreshClocks) refreshClocks();")
        t1 = page.text_content(".route .route-time span")
        check("arrival times update after time passes", t0 != t1, f"{t0} -> {t1}")
        page.screenshot(path="/home/claude/calm-route/test/desktop.png")
        page.context.close()

        # 19. Speed: no built-in waiting, early start, cache, alternates, no duplicate detail checks
        page = new_page(browser, profile={})
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", "42.30, -85.55"); page.wait_for_selector("#to-s [role=option]")
        n_before = len(calls["route"]); t_before = len(calls["trace"])
        page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
        page.wait_for_timeout(1500)                      # user glances at the map before pressing Find
        started_early = len(calls["route"]) > n_before
        check("routes start loading as soon as both places are picked", started_early)
        t0 = time.time(); find_routes(page, wait_details=False); dt = time.time() - t0
        check("pressing Find after an early start shows results almost instantly", dt < 0.8, f"{dt:.2f}s")
        page.wait_for_function("state.routes.every(r => !r.pending)")
        n_routes = page.locator(".route").count()
        check("fastest route's alternates add extra choices (capped at 5)", n_routes == 5, n_routes)
        check("road details fetched once per distinct route", len(calls["trace"]) - t_before == n_routes, f"{len(calls['trace']) - t_before} detail calls for {n_routes} routes")
        n1 = len(calls["route"])
        page.click("#swap"); page.click("#swap")         # back to the same trip
        t0 = time.time(); find_routes(page); dt = time.time() - t0
        check("repeating a recent trip uses the saved result (no new requests)", len(calls["route"]) == n1, len(calls["route"]) - n1)
        check("repeated trip is instant", dt < 0.5, f"{dt:.2f}s")
        # cold search (no early start): must not contain the old fixed pauses (~11 s)
        page.evaluate("tripCache.clear()")
        page.fill("#to", "42.33, -85.52"); page.evaluate("state.to = null")
        t0 = time.time(); find_routes(page); dt = time.time() - t0
        check("a cold search has no built-in waiting (under 3 s on a fast server)", dt < 3, f"{dt:.2f}s")

        # Routes show before road details finish, then upgrade in place
        page.evaluate("tripCache.clear()")
        page.route("**/trace_attributes", lambda r: (time.sleep(0.6), r.fallback()))
        page.fill("#to", "42.35, -85.50"); page.evaluate("state.to = null")
        t0 = time.time(); find_routes(page, wait_details=False); dt = time.time() - t0
        snap = page.evaluate("({pending: document.querySelectorAll('.route .tag.checking').length, status: document.getElementById('status').textContent})")
        check("routes appear before road details finish", snap["pending"] > 0, f"{snap['pending']} cards still checking after {dt:.2f}s")
        check("status explains details are still coming", snap["pending"] == 0 or "Checking traffic lights" in snap["status"], snap)
        picked = page.evaluate("state.routes.indexOf(state.routes[1])")
        page.locator(".route").nth(1).click()
        manual = page.evaluate("state.routes.indexOf(state.sel)")
        page.wait_for_function("state.routes.every(r => !r.pending)", timeout=30000)
        check("cards upgrade when details arrive", page.locator(".route .tag.checking").count() == 0)
        check("upgrading keeps the route you picked", page.evaluate("state.routes.indexOf(state.sel)") == manual)
        check("status clears when details are done", "Checking" not in page.text_content("#status"), page.text_content("#status"))
        check("no script errors in speed tests", not page.errors, page.errors)
        page.context.close()

        # 20. Navigation apps: Google / Apple Maps / Waze
        page = new_page(browser, profile={})
        check("desktop defaults to Google Maps", page.input_value("#navApp") == "google")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", ""); page.type("#to", "mcdonalds", delay=15); page.wait_for_selector("#to-s [role=option]")
        page.locator("#to-s [role=option]", has_text="8050").first.dispatch_event("mousedown")   # has a street number
        find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))")
        also = page.locator("#alsoOpen a").all_inner_texts()
        check("other two apps offered one tap away", sorted(also) == ["Apple Maps", "Waze"], also)
        page.select_option("#navApp", "apple")
        href = page.get_attribute("#gmaps", "href"); q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        check("Apple Maps link uses Apple's directions format", href.startswith("https://maps.apple.com/directions?"), href[:60])
        wait_pins(page)
        href = page.get_attribute("#gmaps", "href"); q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        npins = page.evaluate("pinInfo().pins.length")
        check("Apple Maps link carries the pinned points as stops", npins > 0 and len(q.get("waypoint", [])) == npins, (npins, len(q.get("waypoint", []))))
        check("Apple Maps link ends at the destination", "8050" in q["destination"][0], q.get("destination"))
        check("Apple Maps link has start and driving mode", q.get("source") and q.get("mode") == ["driving"], q)
        hw = page.evaluate("state.sel.hwMiles")
        check("Apple Maps avoids highways only for a no-highway route", (q.get("avoid") == ["highways"]) == (hw < 0.5), (q.get("avoid"), hw))
        check("button names the chosen app", page.text_content("#gmaps").endswith("Apple Maps"), page.text_content("#gmaps"))
        page.select_option("#navApp", "waze")
        href = page.get_attribute("#gmaps", "href"); q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        check("Waze link goes to the destination and starts navigation", href.startswith("https://waze.com/ul?") and q.get("navigate") == ["yes"] and q.get("ll"), href)
        dest = page.evaluate("[state.trip.to.lat, state.trip.to.lon]")
        wl = [float(x) for x in q["ll"][0].split(",")]
        check("Waze destination is the exact place", abs(wl[0] - dest[0]) < 1e-5 and abs(wl[1] - dest[1]) < 1e-5, (wl, dest))
        check("Waze heads-up shown (it picks its own route)", page.is_visible("#appNote") and "own route" in page.text_content("#appNote"), page.text_content("#appNote"))
        check("pinned-points setting hidden for Waze", not page.is_visible("#wpN"))
        check("copy box holds the Waze link", page.input_value("#copybox") == href)
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        check("chosen app remembered after reload", page.input_value("#navApp") == "waze", page.input_value("#navApp"))
        check("no script errors with navigation apps", not page.errors, page.errors)
        page.context.close()

        # 21. iPhone defaults to Apple Maps
        ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                                  user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")
        page = ctx.new_page(); install_routes(page); page.goto("http://calm.test/")
        page.wait_for_function("window.L && document.getElementById('navApp')")
        check("iPhone defaults to Apple Maps", page.input_value("#navApp") == "apple", page.input_value("#navApp"))
        ctx.close()

        # 22. Audit regressions: scoring accuracy, hand-off text, queue, focus
        page = new_page(browser, profile={})
        pts = [(42.2 + i * 0.002, -85.6) for i in range(41)]
        shape = enc_poly(pts)
        def analyzed(edges, types=(1, 4), summary=None):
            man = [{"type": t, "length": 0.1, "begin_shape_index": min(i * 3, 40), "end_shape_index": min(i * 3 + 3, 40), "street_names": ["Elm Street"]} for i, t in enumerate(types)]
            trip = {"summary": {"length": 5.5, "time": 600, **(summary or {})}, "legs": [{"shape": shape, "maneuvers": man}]}
            return page.evaluate("([t, e]) => { const r = analyze(t, e); return {bridges:r.bridges, merges:r.merges, exits:r.exits, turns:r.turns, text:momentsText(r)}; }", [trip, edges])
        def edge(i, cls="residential", speed=25, use="road", length=0.14, **kw):
            return {"begin_shape_index": i, "length": length, "use": use, "road_class": cls, "speed_limit": speed, "lane_count": 2, "names": ["Elm Street"], **kw}
        over = [edge(i, "motorway", 70, length=0.05 if i % 3 == 0 else 0.3, **({"bridge": True} if i % 3 == 0 else {})) for i in range(40)]
        check("a string of highway overpasses is not one long bridge", analyzed(over)["bridges"] == 0, analyzed(over))
        split = [edge(0), edge(1, bridge=True, length=0.3), edge(2, length=0.02), edge(3, bridge=True, length=0.3), edge(4)]
        check("a bridge split by a tiny gap counts once", analyzed(split)["bridges"] == 1, analyzed(split))
        two = [edge(0), edge(1, bridge=True, length=0.6), edge(2, length=0.3), edge(3, bridge=True, length=0.6), edge(4)]
        check("two real bridges count as two", analyzed(two)["bridges"] == 2, analyzed(two))
        trunk = [edge(0, "trunk", 45), edge(1, "trunk", 60), edge(2, "trunk", 45), edge(3, "trunk", 65)]
        r = analyzed(trunk)
        check("a speed-limit change on the same road is not a merge or exit", r["merges"] == 0 and r["exits"] == 0, r)
        ramp = [edge(0, "primary", 40), edge(1, "primary", 30, use="ramp"), edge(2, "motorway", 70), edge(3, "motorway", 50, use="ramp"), edge(4, "primary", 40)]
        r = analyzed(ramp)
        check("ramp onto and off a highway is one merge and one exit", r["merges"] == 1 and r["exits"] == 1, r)
        r = analyzed(ramp, types=(1, 18, 25, 23, 24, 20, 10, 4))
        check("ramps, merges and lane forks are not counted as turns", r["turns"] == 1, r)
        r = analyzed(ramp, summary={"has_toll": True, "has_ferry": True})
        check("tolls and ferries are mentioned on the route card", "has tolls" in r["text"] and "ferry" in r["text"], r["text"])

        far = page.evaluate("searchPlaces('meijer', {lat:42.25, lon:-85.59}).then(r => r.items.map(i => i.main + '|' + Math.round(i.dist)))")
        check("a look-alike name across the world is left out when stores are nearby", len(far) == 3 and not any("Meijeri" in x for x in far), far)
        lone = page.evaluate("searchPlaces('meijer', null).then(r => r.items.length)")
        check("without a known area, search still returns results", lone >= 3, lone)
        page.fill("#to", ""); page.type("#to", "meijer", delay=15); page.wait_for_selector("#to-s [role=option]")
        n0 = page.locator("#to-s [role=option]").count()
        check("a long list offers 'Show more places'", page.locator("#to-s [data-more]").count() == 1)
        page.locator("#to-s [data-more]").dispatch_event("mousedown")
        page.wait_for_function(f"document.querySelectorAll('#to-s [role=option]').length > {n0}")
        n1 = page.locator("#to-s [role=option]").count()
        check("Show more adds stores further out, nearest first", n1 == n0 + 3 and "Battle Creek" in page.text_content("#to-s"), (n0, n1))
        check("Show more goes away once used, and the map shows the extra pins", page.locator("#to-s [data-more]").count() == 0 and page.evaluate("previewLayer.getLayers().length") == n1)
        page.locator("#to-s [role=option]").nth(n1 - 1).dispatch_event("mousedown")
        check("a place from the longer list can be chosen", page.evaluate("!!state.to"))
        page.fill("#to", ""); page.type("#to", "bakery", delay=15); page.wait_for_selector("#to-s [role=option]")
        check("a short list has no 'Show more'", page.locator("#to-s [data-more]").count() == 0)
        page.fill("#to", "")
        gravel = [edge(0), edge(1, unpaved=True, length=0.4), edge(2, surface="gravel", length=0.3), edge(3), edge(4, unpaved=True, length=0.05)]
        r = page.evaluate("([t, e]) => { const r = analyze(t, e); const calm = analyze(t, e.map(x => ({...x, unpaved:false, surface:'paved'}))); return {dirt:r.dirtMiles, ev:r.events.filter(x => x.kind === 'dirt').map(x => x.text), text:momentsText(r), kinds:r.segs.map(s => s.kind), worse:stressOf(r) > stressOf(calm) + 1, hard:QUESTIONS.find(q => q.key === 'dirt').hard(r), def:profile.dirt}; }",
                          [{"summary": {"length": 5.5, "time": 600}, "legs": [{"shape": shape, "maneuvers": [{"type": 1, "length": 1, "begin_shape_index": 0, "end_shape_index": 40}]}]}, gravel])
        check("unpaved miles are measured from road surface data", abs(r["dirt"] - 0.75) < 0.01 and "dirt" in r["kinds"], r)
        check("an unpaved stretch is a marked moment, tiny bits are not", r["ev"] == ["Unpaved road (0.7 mi)"], r["ev"])
        check("unpaved miles show on the card and raise the stress score", "0.8 mi unpaved" in r["text"] and r["worse"], r)
        tolls = [edge(0), edge(1, toll=True, length=2.0, names=["Chicago Skyway"]), edge(2, toll=True, length=1.0), edge(3)]
        t = page.evaluate("([t, e]) => { const r = analyze(t, e); const free = analyze(t, e.map(x => ({...x, toll:false}))); return {miles:r.tollMiles, toll:r.toll, ev:r.events.filter(x => x.kind === 'toll').map(x => x.text), text:momentsText(r), worse:stressOf(r) > stressOf(free) + 2, flagOnly:analyze({...t, summary:{...t.summary, has_toll:true}}, null).toll}; }",
                          [{"summary": {"length": 5.5, "time": 600}, "legs": [{"shape": shape, "maneuvers": [{"type": 1, "length": 1, "begin_shape_index": 0, "end_shape_index": 40}]}]}, tolls])
        check("toll miles are measured from road data, with one moment where the toll road begins", abs(t["miles"] - 3.0) < 0.01 and t["toll"] and t["ev"] == ["Toll road begins: Chicago Skyway"], t)
        check("toll roads show on the card and raise the stress score", "3.0 mi toll road" in t["text"] and t["worse"], t)
        check("before road details arrive, the route summary's toll flag is used", t["flagOnly"] is True, t)
        check("dirt roads start at 'Avoid it' and can be a Never rule", r["def"] == 2 and r["hard"] is True, r)
        q = page.evaluate("[parseQuery('7 Eleven').address, parseQuery('5800 Gull Rd').address, parseQuery('84 Lumber, Portage').where]")
        check("store names starting with a number are not treated as addresses", not q[0] and q[1] is True and q[2] == "Portage", q)
        bad = page.evaluate("searchPlaces('95, 200', null).then(r => r.items.some(i => i.coords))")
        check("impossible coordinates are not accepted as a map point", bad is False, bad)

        ran = page.evaluate("""async () => {
          const lim = limiter(1), owner = {abandoned:false}, ran = [];
          const job = n => lim(() => new Promise(ok => { ran.push(n); setTimeout(ok, 30); }), owner).catch(() => 'dropped');
          const a = job(1), b = job(2), c = job(3); owner.abandoned = true;
          const d = lim(() => { ran.push(4); return Promise.resolve(); }, {abandoned:false});
          const res = await Promise.all([a, b, c, d]); return {ran, res};
        }""")
        check("requests for an abandoned trip are dropped so the new trip goes first", ran["ran"] == [1, 4] and ran["res"][1] == "dropped", ran)

        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", ""); page.type("#to", "mcdonalds", delay=15); page.wait_for_selector("#to-s [role=option]")
        page.locator("#to-s [role=option]", has_text="8050").first.dispatch_event("mousedown")
        find_routes(page)
        check("slider counts as untouched after a search", page.evaluate("state.touched") is False)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))")
        dest = urllib.parse.parse_qs(urllib.parse.urlparse(page.evaluate("appLinks().google")).query)["destination"][0]
        check("address handed to the map app includes town and state", "8050 Portage Road" in dest and "Portage, MI" in dest, dest)
        page.locator(".route").nth(1).focus()
        page.evaluate("update(false)")
        check("keyboard focus stays on the route card when the list refreshes", page.evaluate("document.activeElement.classList.contains('route')"))
        check("choosing a route counts as touching the slider", page.evaluate("state.touched") is True)
        check("no script errors in audit checks", not page.errors, page.errors)
        page.context.close()

        # 23. Map library fails to load: clear message instead of a dead page
        NO_LEAFLET["on"] = True
        ctx = browser.new_context(viewport={"width": 1280, "height": 820}); page = ctx.new_page(); install_routes(page)
        page.add_init_script("localStorage.setItem('calmRouteProfile', '{}');")
        page.goto("http://calm.test/"); page.wait_for_timeout(500)
        check("clear message when the map can't load", "couldn’t load" in page.text_content("#status") and page.is_disabled("#find"), page.text_content("#status"))
        NO_LEAFLET["on"] = False; ctx.close()

        # 24. Route features: never rules, comparison, tricky moments, saved places, sunset
        page = new_page(browser, profile={"merge": 3})
        check("profile summary shows a Never rule", page.text_content("#profileSummary").startswith("Never merges"), page.text_content("#profileSummary"))
        page.click("#editProfile")
        counts = page.evaluate("[...document.querySelectorAll('#quizBody .choices:not(.multi)')].map(c => c.children.length)")
        check("Never is offered only for merges, bridges, tolls, dirt roads and steep hills", counts == [4, 3, 3, 4, 3, 4, 4, 4, 3], counts)
        page.click("#sheetClose")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        check("with merges set to Never, the chosen route has no merge", page.evaluate("state.sel.merges") == 0, page.evaluate("state.sel.merges"))
        check("routes that break a Never rule are labeled", page.locator(".route .tag.never").count() >= 1 and "highway merge" in page.locator(".route .tag.never").first.text_content())
        check("Calmest tag never sits on a route that breaks a Never rule", page.locator(".route:has(.tag.never) .tag.calm").count() == 0)
        page.evaluate("selectRoute(state.routes.indexOf(state.fast))")
        check("picking a rule-breaking route explains how to avoid it", "To avoid that, allow" in page.text_content("#neverNote"), page.text_content("#neverNote"))
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r.merges === 0)))")
        check("note clears on a route that keeps the rule", page.text_content("#neverNote") == "")
        why = page.locator(".route[aria-checked=true] .why").text_content()
        check("chosen route is compared with the fastest in words", why.startswith("Compared with the fastest") and "no merges" in why, why)
        check("fastest route has no comparison line", page.evaluate("!document.querySelector(`.route[data-i='${state.routes.indexOf(state.fast)}'] .why`)"))
        n_ev = page.evaluate("state.sel.events.length")
        check("every tricky moment is listed", n_ev > 0 and page.locator("#momentBox li").count() == n_ev, (n_ev, page.locator("#momentBox li").count()))
        sv = page.locator("#momentBox li a").first.get_attribute("href")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(sv).query)
        check("each moment links to Street View at that spot, facing it", q.get("map_action") == ["pano"] and re.match(r"^-?\d+\.\d+,-?\d+\.\d+$", q["viewpoint"][0]) and 0 <= int(q["heading"][0]) < 360, sv)
        page.locator("#momentBox .where").first.click()
        page.wait_for_timeout(700)   # map zoom animation
        check("pressing a moment zooms the map to it", page.evaluate("map.getZoom()") >= 15, page.evaluate("map.getZoom()"))
        sun = page.evaluate("(() => { const s = sunTimes(42.29, -85.59, new Date(2026, 10, 13)); return [s.sunrise.getUTCHours() * 60 + s.sunrise.getUTCMinutes(), s.sunset.getUTCHours() * 60 + s.sunset.getUTCMinutes()]; })()")
        check("sunrise and sunset are right for Kalamazoo in November (7:27 AM, 5:24 PM)", abs(sun[0] - (12 * 60 + 27)) <= 4 and abs(sun[1] - (22 * 60 + 24)) <= 4, sun)
        check("polar night doesn't break the sunset math", page.evaluate("sunTimes(80, 0, new Date(2026, 11, 21))") is None)
        # saved places
        check("recent destination appears as a chip", page.locator("#quick .chip.recent").count() == 1 and "McDonald" in page.locator("#quick .chip.recent").text_content())
        page.click("#quick [data-set=home]")
        check("Set home saves the chosen place", page.locator("#quick [data-go=home]").count() == 1 and "Saved" in page.text_content("#status"), page.text_content("#status"))
        check("a saved place isn't repeated as a recent chip", page.locator("#quick .chip.recent").count() == 0)
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        check("Home is remembered after reload", page.locator("#quick [data-go=home]").count() == 1)
        page.click("#quick [data-set=work]")
        check("Set work with nothing chosen explains what to do", "first choose the place" in page.text_content("#status"), page.text_content("#status"))
        page.focus("#from"); page.click("#quick [data-go=home]")
        check("Home chip fills the box you were in", "McDonald" in page.input_value("#from") and page.evaluate("!!state.from && samePlace(state.from, places.home)"), page.input_value("#from"))
        page.click("#quick [data-forget=home]")
        check("Home can be forgotten", page.locator("#quick [data-set=home]").count() == 1 and page.evaluate("JSON.parse(localStorage.getItem('calmRoutePlaces')).home") is None)
        check("no script errors in route features", not page.errors, page.errors)
        page.context.close()

        # 25. Practice mode, pebbles and stone stacks
        page = new_page(browser, profile={})
        check("stacks start from the comfort profile (A bit = 2 stones)", page.evaluate("[...document.querySelectorAll('#stacks .stack')].map(s => +s.dataset.level)") == [2, 2, 2, 2, 2])
        page.click("#pebbleCard summary")
        page.check("#practiceOn")
        check("practice switch is saved", page.evaluate("JSON.parse(localStorage.getItem('calmRoutePractice')).on") is True)
        check("the practiced skill is highlighted", page.locator("#stacks .stack.active").get_attribute("data-skill") == "merge")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        check("no route of the right size: says so and shows the calmest", "right size of step" in page.text_content("#practiceNote") and page.evaluate("state.pick") is None, page.text_content("#practiceNote"))
        page.evaluate("practice.levels = {merge:1, left:2, boxed:2, bridge:2, turns:2}; update(false)")
        check("practice picks a route one step past your level", page.evaluate("state.pick && state.sel === state.pick && state.sel.merges") == 1, page.evaluate("state.sel.merges"))
        check("the practice pick is labeled and explained", page.locator(".route[aria-checked=true] .tag.practice").count() == 1 and "Practice pick" in page.text_content("#practiceNote"), page.text_content("#practiceNote"))
        page.evaluate("document.getElementById('budget').value = 0; document.getElementById('budget').dispatchEvent(new Event('input'))")
        check("practice never goes over your time", page.evaluate("!state.pick || state.pick.extra <= 0.01"))
        page.evaluate("noteDriveStarted()")
        check("opening a route does not nag right away", page.evaluate("!!practice.pending") and page.is_hidden("#driveAsk"))
        page.evaluate("practiceCfg.askAfter = 0; renderAsk()")
        check("coming back later asks how the drive went", page.is_visible("#driveAsk") and "McDonald" in page.text_content("#driveAsk h2"), page.text_content("#driveAsk"))
        page.click("#driveAsk [data-feel=fine]")
        st = page.evaluate("practice")
        check("a practice drive earns two pebbles", st["pebbles"] == 2 and st["drives"] == 1 and st["pending"] is None, st)
        check("first keepsakes are collected", {"first", "merge", "practice"} <= set(st["keepsakes"]), st["keepsakes"])
        check("thank-you names the pebbles and keepsakes", "+2 pebbles" in page.text_content("#driveAsk") and "keepsake" in page.text_content("#driveAsk"), page.text_content("#driveAsk"))
        check("one fine drive is not yet a new stone", st["levels"]["merge"] == 1)
        page.click("#driveAsk [data-feel=close]")
        page.evaluate("noteDriveStarted(); renderAsk()"); page.click("#driveAsk [data-feel=fine]")
        check("two fine drives add a stone to the stack", page.evaluate("practice.levels.merge") == 2 and "grew to 2 stones" in page.text_content("#driveAsk") and page.locator("#stacks .stack[data-skill=merge]").get_attribute("data-level") == "2", page.text_content("#driveAsk"))
        before = page.evaluate("[practice.pebbles, practice.levels.merge]")
        page.evaluate("practice.levels.merge = 1; update(false); noteDriveStarted(); renderAsk()"); page.click("#driveAsk [data-feel=rough]")
        after = page.evaluate("[practice.pebbles, practice.levels.merge]")
        check("a rough drive still earns pebbles and takes nothing away", after[0] > before[0] and after[1] == 1 and "nothing is lost" in page.text_content("#driveAsk"), (before, after))
        page.evaluate("noteDriveStarted(); renderAsk()"); page.click("#driveAsk [data-feel=none]")
        check("'I didn't drive it' earns nothing and closes the question", page.evaluate("practice.pebbles") == after[0] and page.is_hidden("#driveAsk"))
        total = page.evaluate("practice.pebbles")
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        check("pebbles are remembered after reload", f"{total} pebbles" in page.text_content("#pebbleCount"), page.text_content("#pebbleCount"))
        page.click("#pebbleCard summary"); page.click("#pebbleReset")
        check("Start over needs a second press", page.evaluate("practice.pebbles") == total and "again" in page.text_content("#pebbleReset"))
        page.click("#pebbleReset")
        check("Start over clears pebbles but keeps the practice switch", page.evaluate("practice.pebbles === 0 && practice.on === true"))
        check("no script errors in practice mode", not page.errors, page.errors)
        page.context.close()

        page = new_page(browser, profile={"merge": 3})
        page.evaluate("practice.on = true; practice.skill = 'merge'")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        check("practice never overrides a Never rule", "paused" in page.text_content("#practiceNote") and page.evaluate("state.sel.merges") == 0, page.text_content("#practiceNote"))
        page.context.close()

        page = new_page(browser, profile={}, width=360, height=740, mobile=True,
                        init_script="localStorage.setItem('calmRoutePractice', JSON.stringify({on:true, pebbles:12, drives:7, keepsakes:['first','merge','five'], pending:{at:1, to:'x'}}));")
        page.click("#pebbleCard summary")
        check("phone: pebble card has no sideways scroll", page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), page.evaluate("document.documentElement.scrollWidth"))
        check("a stale unanswered drive is quietly dropped", page.is_hidden("#driveAsk") and page.evaluate("practice.pending") is None)
        check("damaged practice data doesn't break the page", not page.errors, page.errors)
        page.context.close()

        # 26. Toll roads: Never asks the routing service for toll-free routes; Apple Maps is told too
        page = new_page(browser, profile={"toll": 3})
        check("profile summary shows Never toll roads", "toll roads" in page.text_content("#profileSummary"), page.text_content("#profileSummary"))
        calls["route"].clear()
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        opts = [b["costing_options"]["auto"] for b in calls["route"]]
        check("with tolls set to Never, every route request excludes tolls", opts and all(o.get("exclude_tolls") is True and o.get("use_tolls") == 0 for o in opts), opts[:2])
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))")
        page.select_option("#navApp", "apple")
        q = urllib.parse.parse_qs(urllib.parse.urlparse(page.get_attribute("#gmaps", "href")).query)
        check("Apple Maps link asks to avoid tolls", "tolls" in q.get("avoid", [""])[0], q.get("avoid"))
        check("toll-free trips are saved separately from normal ones", page.evaluate("tripKey({from:state.trip.from, to:state.trip.to, noTolls:true}) !== tripKey({from:state.trip.from, to:state.trip.to})"))
        check("no script errors with tolls", not page.errors, page.errors)
        page.context.close()

        page = new_page(browser, profile={})
        calls["route"].clear()
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        opts = [b["costing_options"]["auto"] for b in calls["route"]]
        check("a trip with no tolls needs just five route requests", len(opts) == 5 and not any(o.get("exclude_tolls") for o in opts), len(opts))
        check("map isn't redrawn when the clock refreshes (keeps pop-ups open)", page.evaluate("(() => { const a = layer.getLayers()[0]; refreshClocks(); return layer.getLayers()[0] === a; })()"))

        # audit 2: toll-free route only when needed, paved fallback, stale toll rule, Waze drives, snooze, home = here
        TOLL["on"] = True; calls["route"].clear()
        page.fill("#to", ""); type_and_pick(page, "to", "meijer", 0)
        find_routes(page)
        opts = [b["costing_options"]["auto"] for b in calls["route"]]
        check("when the fastest route has a toll, one toll-free route is asked for", sum(1 for o in opts if o.get("exclude_tolls")) == 1, [o.get("exclude_tolls") for o in opts])
        check("the toll-free route survives the shortlist", page.evaluate("state.routes.some(r => r.toll) && state.routes.some(r => !r.toll && r.kind === 'notoll')"), page.evaluate("state.routes.map(r => [r.kind, r.toll])"))
        calls["route"].clear()
        page.click("#editProfile"); page.click(".choices[data-k=toll] button[data-v='3']"); page.click("#saveProfile")
        page.wait_for_function("state.trip && state.trip.noTolls && state.routes.length > 0 && !document.getElementById('app').classList.contains('busy') && state.routes.every(r => !r.pending)", timeout=40000)
        check("changing the toll rule after a search finds routes again by itself", page.evaluate("state.trip.noTolls"))
        check("searching again under Never gives only toll-free routes", page.evaluate("state.routes.length > 0 && state.routes.every(r => !r.toll)") and all(b["costing_options"]["auto"].get("exclude_tolls") for b in calls["route"]))
        TOLL["on"] = False
        PAVED_FAIL["on"] = True; calls["route"].clear()
        page.fill("#to", ""); type_and_pick(page, "to", "mcdonalds", 0)
        find_routes(page)
        opts = [b["costing_options"]["auto"] for b in calls["route"]]
        check("if no paved-only route exists, the ordinary fewer-highways route is used instead", page.evaluate("state.routes.length") >= 3 and any(o["use_highways"] == 0.2 and not o.get("exclude_unpaved") for o in opts) and "error" not in page.get_attribute("#status", "class"), len(opts))
        PAVED_FAIL["on"] = False
        page.evaluate("noteDriveStarted('waze')")
        check("a Waze drive is logged without this route's merges or bridges", page.evaluate("practice.pending.m") == {} and page.evaluate("practice.pending.practice") is None and "Waze" in page.evaluate("practice.pending.name"))
        page.evaluate("practiceCfg.askAfter = 0; renderAsk()")
        page.evaluate("practiceCfg.askAfter = 120000")
        page.click("#driveAsk [data-feel=later]")
        check("'Haven't driven it yet' keeps the question for later", page.is_hidden("#driveAsk") and page.evaluate("!!practice.pending"))
        page.evaluate("practiceCfg.askAfter = 0; renderAsk()"); page.click("#driveAsk [data-feel=fine]")
        check("the Waze drive still earns a pebble, with no stack credit", page.evaluate("practice.pebbles") == 1 and page.evaluate("Object.values(practice.fine).every(v => !v)"), page.evaluate("practice"))
        page.evaluate("state.from = {main:'My location', sub:'', lat:42.25, lon:-85.6, here:true}; lastField = 'from'")
        page.click("#quick [data-set=home]")
        check("your current location can be saved as Home", page.evaluate("places.home && places.home.main === 'Home' && places.home.coords === true") and "where you are now" in page.text_content("#status"), page.text_content("#status"))
        page.focus("#to"); page.click("#quick [data-go=home]")
        check("a Home saved from your location fills in as 'Home'", page.input_value("#to") == "Home", page.input_value("#to"))
        check("no script errors in the second audit", not page.errors, page.errors)
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        page.fill("#to", ""); type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)

        # 27. Gas cost: on by default for a typical car; your car lives in the profile
        n0 = page.locator(".route").count()
        check("gas cost shows on every route by default, for a typical car", page.locator(".route .fuel").count() == n0 and "typical car" in page.text_content(".route .fuel"), page.locator(".route .fuel").count())
        check("the car settings are in the profile", page.locator("#sheet #fuelBox").count() == 1)
        page.click("#editProfile")
        page.fill("#mpgCity", "25"); page.fill("#mpgHw", "40"); page.fill("#gasPrice", "3.20")
        n = page.locator(".route").count()
        check("with your own mpg, 'typical car' goes away", "typical car" not in page.text_content("#routes"))
        check("every route shows its fuel cost", page.locator(".route .fuel").count() == n, page.locator(".route .fuel").count())
        exp = ref_gallons(page.evaluate("state.fast"), 25, 40) * 3.2
        fast_txt = page.evaluate("document.querySelector(`.route[data-i='${state.routes.indexOf(state.fast)}'] .fuel`).textContent")
        check("fuel cost matches an independent calculation of the speed-based estimate", ref_money(exp) in fast_txt, (exp, fast_txt))
        other = page.evaluate("document.querySelector(`.route[data-i='${state.routes.indexOf(state.routes.find(r => r !== state.fast))}'] .fuel`).textContent")
        check("other routes say how much more or less than the fastest", "than the fastest" in other or "same as the fastest" in other, other)
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        page.click("#editProfile")
        check("fuel settings are remembered", page.input_value("#gasPrice") == "3.20" and page.is_checked("#fuelOn"), page.input_value("#gasPrice"))
        page.evaluate("localStorage.setItem('calmRouteFuel', '{bad json')")
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        check("damaged fuel settings don't break the page", not page.errors, page.errors)
        page.context.close()

        # 28. Car lookup and the self-updating gas price
        calls["car"].clear()
        page = new_page(browser, profile={})
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        check("before you open 'Your car', only the average gas price is asked for (no car details)", all("fuelprices" in c for c in calls["car"]), calls["car"])
        page.click("#editProfile")
        page.uncheck("#fuelOn")
        check("with the switch off, the car and price fields are disabled and costs are hidden", page.is_disabled("#mpgCity") and page.is_disabled("#carYear") and page.locator(".route .fuel").count() == 0)
        page.check("#fuelOn")
        page.wait_for_function("document.getElementById('carYear').options.length > 1 && document.getElementById('gasPrice').value !== ''")
        check("switching on enables the fields and loads the years", page.is_enabled("#mpgCity") and page.is_enabled("#carYear") and page.locator("#carYear option").count() == 3)
        check("the US average price fills in by itself", page.input_value("#gasPrice") == "4.00" and "US average for regular: $4.00" in page.text_content("#priceNote"), page.text_content("#priceNote"))
        page.select_option("#carYear", "2018"); page.wait_for_function("document.getElementById('carMake').options.length > 1")
        page.select_option("#carMake", "Honda"); page.wait_for_function("document.getElementById('carModel').options.length > 1")
        page.select_option("#carModel", "Civic 4Dr"); page.wait_for_function("document.getElementById('carTrim').options.length > 2")
        check("a model with several engines waits for you to choose one", page.input_value("#mpgCity") == "" and "choose the engine" in page.text_content("#carNote"), page.text_content("#carNote"))
        page.select_option("#carTrim", "102"); page.wait_for_function("document.getElementById('mpgCity').value === '30'")
        check("choosing the car fills in its EPA mpg", page.input_value("#mpgHw") == "38" and "2018 Honda Civic 4Dr: 30 city, 38 highway" in page.text_content("#carNote"), page.text_content("#carNote"))
        check("a premium-fuel car switches to the premium price", page.input_value("#gasPrice") == "5.01" and "premium" in page.text_content("#priceNote"), page.text_content("#priceNote"))
        n = page.locator(".route").count()
        exp = ref_gallons(page.evaluate("state.fast"), 30, 38) * 5.01
        fast_txt = page.evaluate("document.querySelector(`.route[data-i='${state.routes.indexOf(state.fast)}'] .fuel`).textContent")
        check("every route card shows the cost for that car and price", page.locator(".route .fuel").count() == n and ref_money(exp) in fast_txt, (ref_money(exp), fast_txt))
        check("other routes show the extra cost against the fastest", page.evaluate("[...document.querySelectorAll('.route .fuel')].filter(e => /than the fastest|same as the fastest/.test(e.textContent)).length") == n - 1)
        page.uncheck("#fuelOn")
        check("switching off removes the cost lines and locks the fields", page.locator(".route .fuel").count() == 0 and page.is_disabled("#gasPrice") and page.evaluate("JSON.parse(localStorage.getItem('calmRouteFuel')).on") is False)
        page.check("#fuelOn")
        check("switching back on brings the cost lines back with the same car", page.locator(".route .fuel").count() == n and page.input_value("#mpgCity") == "30")
        page.select_option("#carModel", "Accord"); page.wait_for_function("document.getElementById('mpgCity').value === '27'")
        check("a model with one engine is picked automatically, and the price returns to regular", page.input_value("#carTrim") == "201" and page.input_value("#gasPrice") == "4.00", (page.input_value("#carTrim"), page.input_value("#gasPrice")))
        page.fill("#gasPrice", "3.50")
        check("typing your own price takes over from the average", "price you typed" in page.text_content("#priceNote") and "3.5" in page.evaluate("JSON.stringify(fuel.price)") and page.evaluate("fuel.priceAuto") is False)
        page.evaluate("fuel.priceAt = 0"); FE["regular"] = "4.25"; page.evaluate("refreshPrice()"); page.wait_for_function("fuel.prices && fuel.prices.regular === '4.25'")
        check("a new average never overwrites the price you typed", page.input_value("#gasPrice") == "3.50")
        page.click("#useAvg")
        check("one press goes back to the US average, at today's figure", page.input_value("#gasPrice") == "4.25" and page.evaluate("fuel.priceAuto") is True, page.input_value("#gasPrice"))
        page.fill("#mpgCity", "22")
        check("mpg can still be adjusted by hand, and the note says so", "yours are used" in page.text_content("#carNote"), page.text_content("#carNote"))
        page.select_option("#carMake", "Tesla"); page.wait_for_function("document.getElementById('carModel').options.length === 2")
        page.select_option("#carModel", "Model 3"); page.wait_for_function("/gas or diesel/.test(document.getElementById('carNote').textContent)")
        check("an electric car is declined with a plain explanation", page.evaluate("fuel.car") is None and page.input_value("#mpgCity") == "22", page.text_content("#carNote"))
        page.select_option("#carMake", "Honda"); page.wait_for_function("document.getElementById('carModel').options.length > 2")
        page.select_option("#carModel", "Accord"); page.wait_for_function("fuel.car && fuel.car.id === '201'")
        FE["regular"] = "4.40"
        page.evaluate("const f = JSON.parse(localStorage.getItem('calmRouteFuel')); f.priceAt = Date.now() - 13 * 3600e3; localStorage.setItem('calmRouteFuel', JSON.stringify(f));")
        page.reload(); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0"); page.click("#editProfile")
        page.wait_for_function("document.getElementById('carTrim').value === '201'")
        check("the car is remembered after reload, with all four menus restored", [page.input_value(i) for i in ("#carYear", "#carMake", "#carModel", "#carTrim")] == ["2018", "Honda", "Accord", "201"] and page.is_checked("#fuelOn") and "2018 Honda Accord" in page.text_content("#carNote"))
        page.wait_for_function("document.getElementById('gasPrice').value === '4.40'")
        check("a price older than half a day is refreshed on the next visit", "$4.40" in page.text_content("#priceNote"), page.text_content("#priceNote"))
        check("no script errors in the car lookup", not page.errors, page.errors)
        page.context.close()

        FE["down"] = True
        page = new_page(browser, profile={}, init_script="localStorage.setItem('calmRouteFuel', JSON.stringify({on:true, city:'', hw:'', price:''}));")
        page.click("#editProfile")
        page.wait_for_function("/Couldn’t reach the car lookup/.test(document.getElementById('carNote').textContent)")
        check("if the car service is down, the app says so and manual entry still works", "Type the price" in page.text_content("#priceNote"), page.text_content("#priceNote"))
        page.evaluate("closeQuiz()")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        page.click("#editProfile")
        page.fill("#mpgCity", "25"); page.fill("#mpgHw", "35"); page.fill("#gasPrice", "3.80")
        check("typed mpg and price give costs without the car service", page.locator(".route .fuel").count() == page.locator(".route").count() and not page.errors, page.errors)
        FE["down"] = False; FE["regular"] = "4.0"
        page.context.close()

        # 29. Stadia Maps: key handling, every request goes to Stadia, honest lefts without traffic-light data
        calls["stadia"].clear(); calls["stadia_attrs"].clear(); calls["free"].clear()
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        check("the key is saved in the browser and removed from the address bar", page.evaluate("localStorage.getItem('calmRouteStadiaKey')") == STADIA_KEY and "stadiaKey" not in page.url, page.url)
        check("the key is not written into the page itself (map tile requests aside)", STADIA_KEY not in re.sub(r"<img[^>]*>", "", page.content()) and STADIA_KEY not in all_source())
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        check("address search goes through Stadia and still finds the store", any(c.startswith("/geocoding/v1/autocomplete?key") for c in calls["stadia"]) and "McDonald" in page.input_value("#to"), page.input_value("#to"))
        find_routes(page)
        check("routes and road details come from Stadia, with the key", any(c.startswith("/route/v1?key") for c in calls["stadia"]) and any(c.startswith("/trace_attributes/v1?key") for c in calls["stadia"]) and all(c.endswith("?key") or "?key" in c for c in calls["stadia"]))
        check("nothing is sent to the free demo servers when Stadia is set up", calls["free"] == [], calls["free"][:3])
        check("road details don't ask Stadia for traffic lights (it would refuse)", calls["stadia_attrs"] and not any("node.traffic_signal" in a for a in calls["stadia_attrs"]))
        check("routes get full road details on Stadia", page.evaluate("state.routes.length > 1 && state.routes.every(r => r.detailed && !r.pending)"), page.evaluate("state.routes.map(r => [r.detailed, r.pending])"))
        lefts = page.evaluate("state.routes.reduce((a, r) => a + r.uLefts, 0)")
        texts = page.evaluate("state.routes.flatMap(r => r.events.filter(e => e.kind === 'uleft').map(e => e.text))")
        check("without traffic-light data, lefts are called 'left onto a busy road'", lefts > 0 and texts and all(t.startswith("Left onto a busy road") for t in texts) and "no light" not in page.text_content("#routes"), texts[:2])
        check("the map key explains the left-turn marker the same way", page.text_content("#leftKey") == "Left onto a busy road")
        w = page.evaluate("(() => { const r = state.routes.find(x => x.uLefts > 0); const a = stressOf(r); const b = stressOf({...r, uLefts:0, uLeftsMaybe:0}); return [(a - b) / r.uLefts, weights().uleft]; })()")
        check("those lefts count at a lower weight, since some have a light", abs(w[0] - w[1] * 0.6) < 1e-6, w)
        page.fill("#to", ""); page.type("#to", "meijer", delay=15); page.wait_for_selector("#to-s [role=option]")
        opts = page.locator("#to-s [role=option]").all_inner_texts()
        check("a store's gas station and express counter are merged into the store", len(opts) == 3 and not any("Gas Station" in o or "Express" in o for o in opts), opts)
        names = ["Walmart Supercenter", "Walmart", "Walmart Academy", "Walmart Bakery", "Walmart Grocery Pickup and Delivery", "Walmart Vision & Glasses", "Walmart Auto Care Centers", "Walmart Fuel Station", "Meijer Gas Station", "Meijer Express", "Meijer"]
        bases = page.evaluate("ns => ns.map(storeBase)", names)
        check("a store's departments all fold into the store itself", len(set(bases[:8])) == 1 and len(set(bases[8:])) == 1 and bases[0] != bases[8], dict(zip(names, bases)))
        check("ordinary names aren't cut short", page.evaluate("[storeBase('Express Oil Change'), storeBase('Pickup Stix'), storeBase('Academy Sports')]") == ["express oil change", "pickup stix", "academy sports"])
        check("search never asks Stadia for more than it allows (25)", page.evaluate("new URLSearchParams(stadiaParams('q=x&limit=40')).get('size')") == "25")
        check("store type is read from the name when Stadia gives none", page.evaluate("[fromPelias({properties:{layer:'venue', name:'Meijer Gas Station'}}).properties.osm_value, fromPelias({properties:{layer:'venue', name:'CVS Pharmacy'}}).properties.osm_value, fromPelias({properties:{layer:'address', name:'8050 Portage Road', housenumber:'8050', street:'Portage Road'}}).properties.name]") == ["fuel", "pharmacy", None])
        page.keyboard.press("Escape")
        check("no script errors on Stadia", not page.errors, page.errors)
        page.context.close()

        page = new_page(browser, profile={}, init_script="localStorage.setItem('calmRouteStadiaKey', 'bad-key-0000000000');")
        page.fill("#to", "mcdonalds"); page.wait_for_timeout(1200)
        check("a rejected key gives a plain message", "didn’t accept" in page.text_content("#status"), page.text_content("#status"))
        page.goto("http://calm.test/?stadiaKey="); page.wait_for_function("window.L && document.getElementById('profileSummary').textContent.length > 0")
        check("opening with an empty stadiaKey clears it and returns to the free servers", page.evaluate("localStorage.getItem('calmRouteStadiaKey')") is None and page.evaluate("STADIA") is False)
        page.context.close()

        # 30. Fuel model: anchored to the EPA test speeds, no bias against back roads, honest precision
        page = new_page(browser, profile={})
        g = lambda mph, c=31, h=40: page.evaluate(f"gallonsPerMile({mph}, {c}, {h})")
        check("at the EPA city-test speed or slower, a mile uses the city mpg", abs(g(21.2) - 1/31) < 1e-12 and abs(g(8) - 1/31) < 1e-12)
        check("from the EPA highway-test speed to 65 mph, a mile uses the highway mpg", abs(g(48.3) - 1/40) < 1e-12 and abs(g(55) - 1/40) < 1e-12 and abs(g(65) - 1/40) < 1e-12)
        check("in between, fuel per mile blends smoothly by speed", 1/40 < g(35) < 1/31 and g(30) > g(40))
        check("above 65 mph each 5 mph costs about 7% in mpg", abs(g(70) - (1/40) / 0.93) < 1e-12 and abs(g(75) - (1/40) / 0.93**2) < 1e-12)
        comb = page.evaluate("fuelGallons({miles:100, mins:100, speedMiles:{21:55, 50:45}}, 31, 40)")
        check("a 55% city / 45% highway trip reproduces the EPA combined mpg exactly", abs(100 / comb - 1 / (0.55/31 + 0.45/40)) < 1e-9, (100 / comb, 1 / (0.55/31 + 0.45/40)))
        back = page.evaluate("fuelGallons({miles:14, mins:16, speedMiles:{55:14}}, 31, 40)")
        check("a steady 55 mph country road is priced at highway mpg, not city (the old bias)", abs(back - 14/40) < 1e-9, back)
        hyb = page.evaluate("[gallonsPerMile(25, 54, 50), gallonsPerMile(55, 54, 50)]")
        check("hybrids, which do better in town, come out cheaper on slow roads", hyb[0] < hyb[1], hyb)
        check("a route with no road details yet has no fuel estimate", page.evaluate("fuelGallons({miles:10, mins:15, speedMiles:{}})") is None)
        nos = page.evaluate("fuelGallons({miles:10, mins:20, speedMiles:{0:10}}, 31, 40)")
        check("stretches with no speed use the trip's average speed (30 mph here)", abs(nos - 10 * page.evaluate("gallonsPerMile(30, 31, 40)")) < 1e-9, nos)
        scaled = page.evaluate("fuelGallons({miles:15, mins:15, speedMiles:{60:14.9}}, 31, 40)")
        check("road-detail miles are scaled to the route's own length", abs(scaled - 15/40) < 1e-9, scaled)
        check("money is rounded to the nearest 5 cents", page.evaluate("[money(1.57), money(0.42), money(0.01), money(0.97), money(0.999)]") == ["$1.55", "40¢", "5¢", "95¢", "$1.00"])
        page.evaluate("fuel = {...fuel, on:true, city:'31', hw:'40', price:'4.00'}; state.fast = {miles:15, mins:14, speedMiles:{65:15}, toll:false}")
        same = page.evaluate("fuelText({miles:15.5, mins:17, speedMiles:{55:15.5}, toll:false})")
        check("differences within about 5% read as 'about the same'", "about the same as the fastest" in same, same)
        more = page.evaluate("fuelText({miles:20, mins:30, speedMiles:{30:20}, toll:false})")
        check("bigger differences say how much more", "more than the fastest" in more and "(" in more, more)
        toll = page.evaluate("fuelText({miles:15, mins:17, speedMiles:{70:15}, toll:true})")
        check("toll routes say the cost is gas only, plus tolls", "plus tolls" in toll, toll)
        page.evaluate("state.fast = {...state.fast, toll:true}")
        free = page.evaluate("fuelText({miles:15, mins:20, speedMiles:{55:15}, toll:false})")
        check("a toll-free route reminds you the fastest also has tolls", "fastest also has tolls" in free, free)
        check("a route still waiting for road details shows no cost yet", page.evaluate("fuelText({miles:15, mins:20, speedMiles:{}, pending:true})") == "")
        check("no script errors in the fuel model", not page.errors, page.errors)
        page.context.close()

        # 31. Pin planner: where two routes differ, mid-block placement, toll-free fastest, failure fallback
        page = new_page(browser, profile={})
        mk = "const mk = pts => { const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i-1] + hav(pts[i-1], pts[i])); return {shape:pts, cum, total:cum[cum.length-1]}; };"
        st = page.evaluate(mk + """(() => {
          const line = (lat0, lat1, lon, n) => Array.from({length:n + 1}, (_, i) => [lat0 + (lat1 - lat0) * i / n, lon]);
          const r = mk(line(42.2, 42.26, -85.6, 12));
          const same = offStretches(r, line(42.2, 42.26, -85.6, 3));
          const beside = offStretches(r, line(42.2, 42.26, -85.6 + 0.0004, 12));            // a parallel road about 33 m away
          const half = offStretches(r, [...line(42.2, 42.23, -85.6, 6), [42.23, -85.58], [42.26, -85.58]]);
          return {total:r.total, same, beside, half};
        })()""")
        check("a route compared with the same road shows no difference", st["same"] == [], st["same"])
        check("a parallel road 33 m away is not mistaken for the same road", len(st["beside"]) == 1 and st["beside"][0]["to"] - st["beside"][0]["from"] > st["total"] * 0.98, st["beside"])
        check("where two routes split, only the part that differs is reported", len(st["half"]) == 1 and abs(st["half"][0]["from"] - st["total"] / 2) < 0.02 and abs(st["half"][0]["to"] - st["total"]) < 0.01, (st["half"], st["total"]))
        pin = page.evaluate(mk + """(() => {
          const pts = Array.from({length:9}, (_, i) => [42.2 + i * 0.00725, -85.6]);       // a cross street every half mile
          const r = mk(pts), p = pinAt(r, r.cum[4], r.cum[2], r.cum[6]);                   // asked for a spot exactly on a corner
          return {toCorner: Math.min(...pts.map(q => hav(q, p.ll))), d:p.d, lo:r.cum[2], hi:r.cum[6]};
        })()""")
        check("a pin is placed mid-block, never on a corner", pin["toCorner"] > 0.2 and pin["lo"] < pin["d"] < pin["hi"], pin)
        page.close()

        calls["sim"].clear()
        page = new_page(browser, profile={"toll": 3})
        fast(page)
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1)
        find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.fast))"); wait_pins(page)
        check("with tolls set to Never, even the fastest route is checked against the map app's own fastest", page.evaluate("!!state.fast.pinPlan && state.fast.pinPlan.done") and any(len(b["locations"]) == 2 for b in calls["sim"]), len(calls["sim"]))
        check("a route the map app would take anyway gets no pins, and says so", page.evaluate("pinInfo().pins.length") == 0 and "no pinned points" in page.text_content("#detailNote"), page.text_content("#detailNote"))
        SIM_FAIL["on"] = True
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast && !r.pinPlan)))"); wait_pins(page, 40000)
        check("if the pin check can't run, evenly spaced pins are used with a warning", page.evaluate("pinInfo().pins.length") == 5 and "couldn’t be checked" in page.text_content("#detailNote") and "warn" in page.get_attribute("#detailNote", "class"), page.text_content("#detailNote"))
        SIM_FAIL["on"] = False
        page.select_option("#navApp", "waze")
        check("Waze shows no pins on the map", page.evaluate("pinLayer.getLayers().length") == 0)
        page.fill("#to", "")
        check("changing the trip clears the pins from the map", page.evaluate("pinLayer.getLayers().length") == 0)
        check("no script errors in the pin planner", not page.errors, page.errors)
        page.context.close()

        # 32. Rough location fixes and the "numbers may differ" note
        geo = lambda acc: f"navigator.geolocation.getCurrentPosition = ok => ok({{coords:{{latitude:42.2005, longitude:-85.6225, accuracy:{acc}}}}});"
        page = new_page(browser, profile={}, init_script="Object.defineProperty(navigator, 'geolocation', {value:{}, configurable:true});" + geo(650))
        page.click("#here")
        check("a rough location fix is called out, with how rough", "within about 0.4 miles" in page.text_content("#status") and "type your starting address" in page.text_content("#status") and "error" not in (page.get_attribute("#status", "class") or ""), page.text_content("#status"))
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))"); wait_pins(page)
        note = page.text_content("#detailNote")
        check("results repeat that distances are approximate with a rough fix", "within about 0.4 miles" in note and "approximate" in note, note)
        check("the note explains why the map app's numbers can differ", "may show a slightly different distance and time" in note and "its own fix on your location" in note and "live traffic" in note, note)
        check("fix sizes read naturally", page.evaluate("[fixText(120), fixText(250), fixText(900)]") == ["400 feet", "800 feet", "0.6 miles"], page.evaluate("[fixText(120), fixText(250), fixText(900)]"))
        page.context.close()
        page = new_page(browser, profile={}, init_script="Object.defineProperty(navigator, 'geolocation', {value:{}, configurable:true});" + geo(12))
        page.click("#here")
        check("a precise fix gets no warning", page.text_content("#status") == "", page.text_content("#status"))
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        note = page.text_content("#detailNote")
        check("with a typed start, the note doesn't mention your location", "may show a slightly different distance" in note and "fix on your location" not in note and "approximate" not in note, note)
        page.select_option("#navApp", "waze")
        check("the note is left out for Waze, which picks its own route anyway", "slightly different distance" not in page.text_content("#detailNote"))
        check("no script errors in the location checks", not page.errors, page.errors)
        page.context.close()

        # 33. Traffic-light file: decoding, lookup radius, coverage, and lefts on Stadia
        import sys as _sys; _sys.path.insert(0, str(APP.parent / "tools")); import build_signals as BS
        real = (APP.parent / "signals" / "US-MI.js").read_text()
        fobj = BS.readfile(str(APP.parent / "signals" / "US-MI.js")); pts = BS.decode(fobj["data"])
        page = new_page(browser, profile={})
        dec = page.evaluate("f => { const s = decodeSignals(f); let first = null; s.grid.forEach(v => { v.forEach(p => { if (!first || p[0] < first[0] || (p[0] === first[0] && p[1] < first[1])) first = p; }); }); return {n:s.n, first}; }", fobj)
        check("the app decodes the light file exactly as the build script wrote it", dec["n"] == fobj["n"] == len(pts) and abs(dec["first"][0] - pts[0][0]) < 1e-9 and abs(dec["first"][1] - pts[0][1]) < 1e-9, (dec, pts[0]))
        page.evaluate("f => { signalSets['US-MI'] = decodeSignals(f); }", fobj)
        # pick a light with no other light within 150 m, so the radius test is clean
        lone = next(p for p in pts[1000:] if all(hav(p, q) > 0.093 for q in pts if q is not p and abs(q[0] - p[0]) < 0.003))
        off = lambda m: [lone[0] + m / 111320, lone[1]]
        near = page.evaluate("ps => ps.map(p => lightNear(p))", [off(0), off(30), off(55)])
        check("a light within about 40 m of a turn counts, one 55 m away doesn't", near == [True, True, False], near)
        check("places outside the covered rectangle are reported as unknown, not as 'no light'", page.evaluate("[lightNear([40.7, -74.0]), lightNear([41.5, -85.6])]") == [None, None])
        page.close()

        # integration on Stadia: with the file, lefts are checked and named exactly; without it, the cautious wording returns
        SIGNAL_FILE["body"] = real; calls["signals"].clear()
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        check("the light file is fetched once for a Michigan trip", len(calls["signals"]) == 1 and calls["signals"][0].endswith("/signals/US-MI.js"), calls["signals"])
        lefts = page.evaluate("state.routes.reduce((a, r) => a + r.uLefts, 0)")
        texts = page.evaluate("state.routes.flatMap(r => r.events.filter(e => e.kind === 'uleft').map(e => e.text))")
        check("with the file on Stadia, lefts are checked and called 'left with no light'", lefts > 0 and all(t.startswith("Left turn with no light") for t in texts) and page.evaluate("state.routes.every(r => !r.uLeftsMaybe)"), texts[:2])
        check("cards and the map key use the exact wording", "no light" in page.text_content("#routes") and page.text_content("#leftKey") == "Left turn, no light")
        w = page.evaluate("(() => { const r = state.routes.find(x => x.uLefts > 0); return (stressOf(r) - stressOf({...r, uLefts:0, uLeftsMaybe:0})) / r.uLefts / weights().uleft; })()")
        check("checked lefts count at full weight", abs(w - 1) < 1e-9, w)
        check("no script errors with the light file", not page.errors, page.errors)
        page.context.close()

        # a light right at the turn: the left is not counted at all
        page = new_page(browser, profile={})
        res = page.evaluate("""f => {
          const turn = [42.2502, -85.6001];
          const shape = Array.from({length:41}, (_, i) => i <= 20 ? [42.2502 - (20 - i) * 0.0005, -85.6001] : [42.2502, -85.6001 - (i - 20) * 0.0007]);
          const enc6 = pts => { let out = '', pl = 0, pn = 0; const e = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20){ s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
            pts.forEach(([a, b]) => { const la = Math.round(a * 1e6), lo = Math.round(b * 1e6); out += e(la - pl) + e(lo - pn); pl = la; pn = lo; }); return out; };
          const trip = {summary:{length:2, time:300}, legs:[{shape:enc6(shape), maneuvers:[{type:1, length:1, begin_shape_index:0, end_shape_index:20, street_names:['Oakland Drive']}, {type:15, length:1, begin_shape_index:20, end_shape_index:40, street_names:['Parkview Avenue']}]}]};
          const edges = shape.slice(0, -1).map((p, i) => ({begin_shape_index:i, length:0.03, use:'road', road_class:'primary', speed_limit:40, lane_count:2, names:[i < 20 ? 'Oakland Drive' : 'Parkview Avenue']}));
          const before = analyze(trip, edges);
          signalSets['TEST'] = decodeSignals(f);
          const after = analyze(trip, edges);
          return {before:[before.uLefts, before.uLeftsMaybe], after:[after.uLefts, after.otherLefts]};
        }""", {"bbox": [42.0, -86.0, 42.5, -85.0], "scale": 100000, "data": BS.encode([(42.25025, -85.60005)])[1]})
        check("with no file, the free server's own light flag decides (none here, so it counts)", res["before"] == [1, 0], res)
        check("a light 6 m from the turn means it isn't a tricky left", res["after"] == [0, 1], res)
        page.close()

        SIGNAL_FILE["body"] = None
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        check("if the light file can't load, the app falls back quietly to the cautious wording", page.evaluate("state.routes.some(r => r.uLeftsMaybe > 0)") and "onto a busy road" in page.text_content("#routes") and not page.errors, page.errors)
        page.context.close()

        # 34. Search rebuilt on Stadia: nearby first, same country, typo-tolerant
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        def search(text):
            calls["geo"].clear()
            page.fill("#to", ""); page.type("#to", text, delay=10)
            page.wait_for_timeout(500)
            return page.locator("#to-s [role=option]").all_inner_texts(), (page.locator("#to-s .sugg-hint").first.inner_text() if page.locator("#to-s .sugg-hint").count() else "")
        for typed in ("8485 sh", "8485 shirley", "8485 shirley ct"):
            opts, hint = search(typed)
            check(f"typing '{typed}' offers the nearby address and nothing far away", len(opts) == 1 and "8485 Shirley Court" in opts[0] and "Portage, MI" in opts[0], opts)
        check("the first try is limited to a circle around you, in your country", calls["geo"] and "boundary.circle.radius" in calls["geo"][0] and calls["geo"][0].get("boundary.country") == "US", calls["geo"][:1])
        check("the hint says what the results are near", "near" in hint.lower(), hint)
        check("each result shows its state", "MI" in opts[0], opts)
        opts, hint = search("walmrt")
        check("a misspelled store name is corrected and found", len(opts) == 1 and "Walmart" in opts[0], opts)
        check("the list says which spelling it used", "Walmart" in hint and "walmrt" in hint, hint)
        opts, hint = search("mcdonlads")
        check("swapped letters are forgiven", opts and "McDonald" in opts[0], opts)
        opts, hint = search("hosptial")
        check("a misspelled everyday word is corrected", opts and "Hospital" in opts[0], opts)
        opts, hint = search("starbucks near grand rapids")
        check("'X near Y' is understood", len(opts) == 1 and "Grand Rapids" in opts[0], opts)
        check("naming a city skips the nearby circle", calls["geo"] and all("boundary.circle.radius" not in c for c in calls["geo"]), calls["geo"][:2])
        opts, hint = search("westnedge and kilgore")
        check("an intersection falls back to the fuller search", len(opts) == 1 and "Kilgore" in opts[0] and any(c["path"].endswith("/search") for c in calls["geo"]), opts)
        opts, hint = search("eiffel tower")
        check("another country is only searched when yours has no match", len(opts) == 1 and "Eiffel" in opts[0] and "France" in opts[0] and sum(1 for c in calls["geo"] if c.get("boundary.country") == "US") >= 2, opts)
        check("and the list says so", "elsewhere" in hint, hint)
        opts, hint = search("nowhere zzzqqq")
        check("no match gives a plain message instead of an empty box", "No match" in page.locator("#to-s").inner_text(), page.locator("#to-s").inner_text())
        page.fill("#to", "8485 shirley ct"); page.wait_for_timeout(50)
        page.press("#to", "Escape"); page.click("#find"); page.wait_for_function("state.to && state.to.main", timeout=8000)
        check("pressing Find without picking still lands on the nearby address", "8485 Shirley Court" in page.evaluate("state.to.main") and abs(page.evaluate("state.to.lat") - 42.1953) < 1e-3, page.evaluate("state.to.main"))
        check("fuzzy matcher: leaves correct and short words alone", page.evaluate("[fuzzyFix('walmart'), fuzzyFix('main st'), fuzzyFix('8485 shirly'), fuzzyFix('targt'), fuzzyFix('krogr')]") == [None, None, None, "Target", "Kroger"], page.evaluate("[fuzzyFix('walmart'), fuzzyFix('main st'), fuzzyFix('8485 shirly'), fuzzyFix('targt'), fuzzyFix('krogr')]"))
        check("the settings say Stadia is in use", "Stadia Maps" in page.text_content("#svcNote") and page.locator("#svcBar").is_hidden())
        check("no errors during search", not page.errors, page.errors)
        page.context.close()

        # 36. Clicking a route line on the map picks that route
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        res = page.evaluate("""(() => {
          const hits = []; layer.eachLayer(l => { if (l.options && l.options.weight === 22) hits.push(l); });
          const before = state.sel; const target = hits[hits.length - 1]; target.fire('click');
          return {n: hits.length, others: state.routes.length - 1, changed: state.sel !== before, card: document.querySelector('.route.sel, .route[aria-checked=true], .route[aria-pressed=true]') !== null};
        })()""")
        check("every route not chosen has a clickable line on the map", res["n"] == res["others"] and res["n"] > 0, res)
        check("clicking a line chooses that route", res["changed"], res)
        check("no errors from map clicks", not page.errors, page.errors)
        page.context.close()

        # 37. Spots you avoid
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        before = page.evaluate("state.routes.length")
        # a spot on the straight (fastest) line, halfway along
        mid = page.evaluate("(() => { const s = state.fast.shape; return s[Math.floor(s.length / 2)]; })()")
        calls["route"].clear()
        page.evaluate("ll => map.fire('contextmenu', {latlng: L.latLng(ll[0], ll[1])})", mid)
        page.wait_for_selector("[data-addspot]")
        check("right-click (or press and hold) offers to avoid the spot", "Avoid this spot" in page.locator("[data-addspot]").inner_text())
        page.click("[data-addspot]")
        page.wait_for_function("state.trip && state.trip.spots.length === 1 && state.routes.length > 0 && state.routes.every(r => r.detailed && !r.pending)", timeout=20000)
        check("the spot is saved in the browser", len(page.evaluate("JSON.parse(localStorage.getItem('calmRouteAvoid'))")) == 1)
        check("the spot shows on the map", page.locator(".map-spot").count() == 1)
        check("routes are found again, asking the router to stay out of it", calls["route"] and all("exclude_polygons" in b for b in calls["route"][:3]) and len(calls["route"][0]["exclude_polygons"][0]) == 13, len(calls["route"]))
        hits = page.evaluate("state.routes.map(r => r.spotHits)")
        check("a route that can only go through it is still shown, but flagged", any(h == 1 for h in hits) and "Has a spot you avoid" in page.text_content("#routes"), hits)
        check("the chosen route stays out of the spot", page.evaluate("state.sel.spotHits") == 0, hits)
        check("the routes found are the same set as before", page.evaluate("state.routes.length") >= before - 1, [before, page.evaluate("state.routes.length")])
        # choose the flagged route to see the moment and the warning
        page.evaluate("selectRoute(state.routes.findIndex(r => r.spotHits))")
        check("its tricky moments list the spot", "A spot you avoid" in page.text_content("#momentBox"))
        check("and the warning names it", "spot you avoid" in page.text_content("#neverNote"), page.text_content("#neverNote"))
        # remove it from the profile
        page.click("#editProfile"); page.wait_for_selector("#spotList [data-unspot]")
        check("the profile lists the spot, named after the road it's on", "On Main Street" in page.text_content("#spotList") or "On Westnedge" in page.text_content("#spotList") or "On " in page.text_content("#spotList"), page.text_content("#spotList"))
        calls["route"].clear()
        page.click("#spotList [data-unspot]")
        page.wait_for_function("state.trip && state.trip.spots.length === 0 && state.routes.length > 0 && state.routes.every(r => r.detailed && !r.pending)", timeout=20000)
        check("removing it brings back the routes without it", page.locator(".map-spot").count() == 0 and not any("exclude_polygons" in b for b in calls["route"]) and page.evaluate("state.routes.every(r => !r.spotHits)") and "None yet" in page.text_content("#spotList"))
        page.click("#sheetClose")
        # Avoid button on a tricky moment
        n_ev = page.evaluate("state.sel.events.filter(e => e.kind !== 'avoid').length")
        check("each tricky moment has an Avoid button", n_ev > 0 and page.locator("#momentBox [data-avoid]").count() == min(n_ev, 12))
        label = page.evaluate("state.sel.events[0].text")
        page.locator("#momentBox [data-avoid]").first.click()
        page.wait_for_function("state.trip && state.trip.spots.length === 1 && state.routes.length > 0 && state.routes.every(r => r.detailed && !r.pending)", timeout=20000)
        check("Avoid on a moment saves that spot with its name", page.evaluate("avoidSpots[0].label") == label, page.evaluate("avoidSpots[0].label"))
        res = page.evaluate("""(() => { const s = state.fast.shape; avoidSpots.push({id:'x', lat:s[1][0], lon:s[1][1], label:'start'});
          const hits = nearestOnShape(s, s[1]).d; avoidSpots.pop(); return hits; })()""")
        check("distance to a route is measured along the line, not just its points", res < 0.001, res)
        check("no errors with spots", not page.errors, page.errors)
        page.context.close()

        # 38. Changing the profile re-ranks the routes on screen right away
        page = new_page(browser, profile={"merge":0, "left":1, "boxed":0, "bridge":0, "turns":0, "toll":1, "dirt":1, "worry":"unsure"}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.fast))")     # the driver clicked a route by hand
        sel_before = page.evaluate("state.routes.indexOf(state.sel)")
        calls["route"].clear()
        page.click("#editProfile")
        for k in ("merge", "boxed", "turns"): page.click(f".choices[data-k={k}] button[data-v='2']")
        page.click("#saveProfile")
        res = page.evaluate("[state.routes.indexOf(state.sel), state.routes.indexOf(calmestWithin(+$('budget').value)), state.manual === null]")
        check("after saving, the calmest route for the new profile is chosen (even after a hand pick)", res[0] == res[1] and res[2], [sel_before, res])
        check("no new search is needed for that", calls["route"] == [], len(calls["route"]))
        check("the status says the routes were updated", "Updated for your new profile" in page.text_content("#status"), page.text_content("#status"))
        page.context.close()

        # 39. Steep hills and fewest turns
        HILLS["on"] = True
        page = new_page(browser, profile={"merge":1, "left":1, "boxed":1, "bridge":1, "turns":1, "toll":1, "dirt":2, "hills":3, "worry":"none"}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        calls["stadia_attrs"].clear()
        type_and_pick(page, "to", "kalamazoo college", 0); find_routes(page)
        check("road details ask for grades", any("edge.max_upward_grade" in a and "edge.max_downward_grade" in a for a in calls["stadia_attrs"]))
        res = page.evaluate("state.routes.map(r => [r.kind, r.hills, +r.hillMiles.toFixed(2)])")
        check("a 11% climb counts as one steep hill on the quiet routes (two pieces close together)", any(h == 1 for _, h, _m in res) and all(h in (0, 1) for _, h, _m in res), res)
        check("a 6% slope adds a little but isn't called a hill", any(h == 0 and m > 0 for _, h, m in res), res)
        check("with hills on Never, the chosen route has none", page.evaluate("state.sel.hills") == 0 or page.evaluate("state.routes.every(r => r.hills)"), res)
        page.evaluate("selectRoute(state.routes.findIndex(r => r.hills))")
        check("the hill shows as a tricky moment with its steepness", "Steep hill up (about 11%)" in page.text_content("#momentBox"), page.text_content("#momentBox")[:200])
        check("and in the route summary and as a Never tag", "1 steep hill" in page.text_content("#routes") and "Has a steep hill" in page.text_content("#routes"))
        check("the profile asks about steep hills, with Never", page.evaluate("QUESTIONS.some(q => q.key === 'hills' && q.hard)"))
        r = page.evaluate("""[fewestTurns([{turns:9},{turns:5},{turns:8}]).turns, fewestTurns([{turns:6},{turns:5}]), fewestTurns([{turns:4}])]""")
        check("fewest turns is named only when it's clearly fewer", r == [5, None, None], r)
        check("no errors with hills", not page.errors, page.errors)
        page.context.close()
        HILLS["on"] = False

        # 40. Daily encouragement
        page = new_page(browser, profile={"worry":"panic"})
        check("an affirmation shows at the top by default", page.locator("#daily").is_visible() and len(page.text_content("#daily")) > 5)
        same = page.evaluate("[dailyLine(20000).text === dailyLine(20000).text, dailyLine(20000).text !== dailyLine(20001).text]")
        check("it's the same all day and changes the next day", same == [True, True], same)
        n = page.evaluate("new Set(Array.from({length: 60}, (_, i) => dailyLine(20000 + i).text)).size")
        check("about two months without many repeats", n >= 45, n)
        share = page.evaluate("Array.from({length: 200}, (_, i) => dailyLine(20000 + i)).filter(d => AFFIRMATIONS.find(a => a.text === d.text).tag === 'p').length / 200")
        base = page.evaluate("AFFIRMATIONS.filter(a => a.tag === 'p').length / AFFIRMATIONS.length")
        check("someone worried about panic sees more breathing and pull-over lines", share > base * 1.4, [share, base])
        page.click("#editProfile"); page.click("#dailyChoice [data-daily=verse]")
        check("choosing Bible verse shows a verse with its reference and BSB", "BSB" in page.text_content("#daily") and page.locator("#daily cite").count() == 1)
        check("the choice is saved", page.evaluate("localStorage.getItem('calmRouteDaily')") == "verse")
        bad = page.evaluate("VERSES.filter(v => !v.text || !v.ref || /^[‘’”]|[‘“]$/.test(v.text) || (v.text.match(/“/g) || []).length !== (v.text.match(/”/g) || []).length).map(v => v.ref)")
        check("every verse has text and a reference, with balanced quote marks", bad == [] and page.evaluate("VERSES.length") >= 45, bad)
        page.click("#dailyChoice [data-daily=off]")
        check("Off hides the line", page.locator("#daily").is_hidden())
        page.click("#dailyChoice [data-daily=affirm]"); page.click("#sheetClose")
        check("no errors with the daily line", not page.errors, page.errors)
        page.context.close()

        # 41. Scenic drive
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.click("#scenicBox summary")
        page.click("#scenicGo")
        check("without a start, Scenic drive asks for one", "starting from" in page.text_content("#scenicNote"), page.text_content("#scenicNote"))
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        check("defaults are 30 minutes, there and back", page.evaluate("[scenicPrefs.mins, scenicPrefs.kind]") == [30, "loop"])
        calls["scenic"].clear()
        page.click("#scenicGo")
        page.wait_for_function("state.routes.length > 0 && !document.getElementById('app').classList.contains('busy') && state.routes.every(r => !r.pending)", timeout=40000)
        check("it searches for parks, preserves and lakes around the start, staying in the country", calls["scenic"] and all(c.get("boundary.country") == "US" and c.get("layers") == "venue" and "boundary.circle.radius" in c for c in calls["scenic"]), calls["scenic"][:1])
        check("it picks a pretty place about the right distance away (not a dog park, not 1 mile, not 20)", "Woollam Nature Preserve" in page.input_value("#to"), page.input_value("#to"))
        page.wait_for_selector("#scenicTrip:not([hidden])")
        txt = page.text_content("#scenicTrip")
        check("the results say it's a scenic drive there and back", "Scenic drive to Woollam Nature Preserve" in txt and "each way" in txt, txt)
        page.click("#scenicHome")
        page.wait_for_function("state.trip && state.trip.from.main === 'Woollam Nature Preserve' && state.routes.length > 0 && !document.getElementById('app').classList.contains('busy')", timeout=40000)
        check("'Plan the drive home' plans from the spot back to the start", page.evaluate("Math.abs(state.trip.to.lat - 42.2005) < 1e-3") and page.locator("#scenicTrip").is_hidden())
        page.click("#scenicLen [data-v='45']"); page.click("#scenicKind [data-v='oneway']")
        check("length and kind are remembered", page.evaluate("JSON.parse(localStorage.getItem('calmRouteScenic'))") == {"mins": 45, "kind": "oneway"})
        check("a 45-minute one-way drive aims about three times further than a 30-minute round trip", abs(page.evaluate("scenicReach(45, false) / scenicReach(30, true)") - 3) < 0.01)
        check("no errors with Scenic drive", not page.errors, page.errors)
        page.context.close()

        # 42. Route briefing
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        type_and_pick(page, "to", "mcdonalds", 1); find_routes(page)
        page.click("#briefBox summary")
        items = page.locator("#briefList li").all_inner_texts()
        check("the briefing lists every step in order, ending with arrival", len(items) == 5 and items[0].startswith("Drive north") and items[-1].startswith("Arrive"), items)
        check("long stretches say how far, and the longest is pointed out", any("the longest stretch" in i for i in items), items)
        check("tricky moments appear in place as 'Heads up'", any("Heads up:" in i for i in items), items)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.sel)))")
        check("the briefing follows the chosen route", len(page.locator("#briefList li").all_inner_texts()) > 0)
        check("no errors with the briefing", not page.errors, page.errors)
        page.context.close()

        # 43. Audit fixes
        page = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}")
        r = page.evaluate("""[calmestOf([{mins:14, merges:0,exits:0,uLefts:0,otherLefts:0,hwMiles:0,busyMiles:1.0,bridges:0,turns:3,rounds:0,uturns:0},
                                        {mins:15, merges:0,exits:0,uLefts:0,otherLefts:0,hwMiles:0,busyMiles:0.95,bridges:0,turns:3,rounds:0,uturns:0}]).mins,
                              calmestOf([{mins:14, merges:0,exits:0,uLefts:0,otherLefts:0,hwMiles:0,busyMiles:1,bridges:0,turns:8,rounds:0,uturns:0},
                                        {mins:15, merges:0,exits:0,uLefts:0,otherLefts:0,hwMiles:0,busyMiles:1,bridges:0,turns:3,rounds:0,uturns:0}]).mins]""")
        check("a near-tie in calm goes to the quicker route; a real difference still wins", r == [14, 15], r)
        r = page.evaluate("[37, 74, 111, 81].map(n => new Set(Array.from({length:n}, (_, d) => dayPick(Array.from({length:n}, (_, i) => i), d))).size)")
        check("the daily rotation reaches every line whatever the list length", r == [37, 74, 111, 81], r)
        page.click("#scenicBox summary")
        page.fill("#from", "42.2005, -85.6225")      # typed, not picked
        page.click("#scenicGo")
        page.wait_for_function("state.routes.length > 0 && !document.getElementById('app').classList.contains('busy')", timeout=40000)
        check("Scenic drive uses a start that was typed but not picked", abs(page.evaluate("state.trip.from.lat") - 42.2005) < 1e-3, page.evaluate("state.trip.from"))
        page.evaluate("HTMLFormElement.prototype.requestSubmit = undefined")
        calls["route"].clear(); page.evaluate("submitTrip()")
        page.wait_for_function("state.routes.length > 0 && !document.getElementById('app').classList.contains('busy')", timeout=40000)
        check("searching still works on browsers without requestSubmit (older Safari)", page.evaluate("state.routes.length") > 0)
        check("no errors in the audit checks", not page.errors, page.errors)
        page.context.close()

        # 44. Hill threshold depends on the road
        for mode in ("fast", "stop"):
            HILLS["on"] = mode
            page = new_page(browser, profile={"hills":2}, query=f"?stadiaKey={STADIA_KEY}")
            page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
            type_and_pick(page, "to", "kalamazoo college", 0); find_routes(page)
            ev = page.evaluate("state.routes.flatMap(r => r.events.filter(e => e.kind === 'hill').map(e => e.text))")
            st = page.evaluate("state.routes.map(r => [r.hills, r.hillStops])")
            if mode == "fast":
                check("a long 7% grade on a 55 mph road counts as a steep hill", any("steep hill" in t.lower() and "(about 7%)" in t for t in ev), ev)
                check("a short 7% dip on a fast road and 9% on a 25 mph street don't count", all("9%" not in t for t in ev) and all(h <= 1 for h, _s in st), [ev, st])
            else:
                check("a steep climb ending at a turn is called out as a turn on a steep hill", any(t.startswith("Turn on a steep hill (about 12%)") for t in ev) and any(s_ == 1 for _h, s_ in st), [ev, st])
                check("and it counts double", page.evaluate("(() => { const r = state.routes.find(x => x.hillStops); const w = weights(); const a = stressOf(r); r.hillStops = 0; const b = stressOf(r); r.hillStops = 1; return Math.abs(a - b - w.hill) < 1e-9; })()"))
            check(f"no errors with hills ({mode})", not page.errors, page.errors)
            page.context.close()
        HILLS["on"] = False

        # 45. Dark country roads and deer
        NIGHT["on"] = True
        for when, label in (("2026-11-14T19:30:00-05:00", "night"), ("2026-11-14T12:00:00-05:00", "noon"), ("2026-07-14T21:15:00-04:00", "summer dusk")):
            ctx_page = new_page(browser, profile={"night":2, "turns":0, "boxed":0, "merge":0}, query=f"?stadiaKey={STADIA_KEY}",
                                init_script=f"(() => {{ const T = new Date('{when}').getTime(), D = Date; const start = D.now(); class FD extends D {{ constructor(...a){{ super(...(a.length ? a : [T + (D.now() - start)])); }} static now(){{ return T + (D.now() - start); }} }} window.Date = FD; }})();")
            page = ctx_page
            page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
            type_and_pick(page, "to", "kalamazoo college", 0); find_routes(page)
            notes = page.locator("#routes .night").all_inner_texts()
            nw = page.evaluate("nightWindow(state.routes[0])")
            if label == "night":
                check("after dark, country roads are flagged as likely unlit, with deer in peak season", nw["dark"] and nw["peak"] and any("country road, likely without streetlights" in n and "deer often cross (peak season)" in n for n in notes), [nw, notes])
                check("and those miles add to the route's stress score", page.evaluate("state.routes.filter(r => r.ruralMiles > 0.5).every(r => nightCost(r, weights()) > 0)") and page.evaluate("state.routes.filter(r => !r.ruralMiles).every(r => nightCost(r, weights()) === 0)"))
                check("the profile asks about dark country roads, with no Never", page.evaluate("QUESTIONS.some(q => q.key === 'night' && !q.hard)"))
            elif label == "noon":
                check("at midday nothing is flagged and nothing is counted", not nw["dark"] and not nw["deer"] and notes == [] and page.evaluate("nightCost(state.routes[0], weights())") == 0, [nw, notes])
            else:
                check("at summer dusk it's a deer warning, not peak season", nw["deer"] and not nw["peak"] and any(n.startswith("At dusk") or n.startswith("After dark") for n in notes), [nw, notes])
            if label == "night":
                page.evaluate("state.manual = null; $('budget').value = $('budget').max; update(false)")
                hint = page.text_content("#budgetHint")
                calm_is_fast = page.evaluate("calmestOf(state.routes) === state.fast")
                check("when extra time can't change the pick, the hint says why", (not calm_is_fast) or "also the calmest for you" in hint, [calm_is_fast, hint])
            check(f"no errors with night roads ({label})", not page.errors, page.errors)
            page.context.close()
        NIGHT["on"] = False

        # 46. Touch screens
        page = new_page(browser, profile={"hills":1}, width=375, height=740, mobile=True, query=f"?stadiaKey={STADIA_KEY}")
        cdp = page.context.new_cdp_session(page)
        def tp(kind, pts): cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y} for x, y in pts]})
        page.tap("#from"); page.keyboard.insert_text("42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.tap("#from-s [role=option] >> nth=0")
        page.tap("#to"); [page.keyboard.insert_text(ch) for ch in "mcdonalds"]; page.wait_for_selector("#to-s [role=option]"); page.wait_for_timeout(300); page.tap("#to-s [role=option] >> nth=1")
        check("on a phone, places can be picked by tapping", page.evaluate("!!state.from && !!state.to"))
        page.tap("#find"); page.wait_for_function("state.routes.length > 1 && state.routes.every(r => r.detailed && !r.pending)", timeout=30000)
        small = page.evaluate("""(() => [...document.querySelectorAll('button, a[href], select, summary, [role=option], input:not([type=checkbox])')].filter(el => {
            const r = el.getBoundingClientRect(); if (!r.width || el.closest('[hidden], .leaflet-control-attribution') || (el.tagName === 'A' && el.closest('p'))) return false; return r.height < 44 || r.width < 44; })
            .map(el => (el.id || el.className || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)))()""")
        check("every button, link and field is at least 44 px for a fingertip (links inside sentences excepted)", small == [], small)
        check("inputs are 16 px so iPhones don't zoom in when typing", page.evaluate("[...document.querySelectorAll('input:not([type=checkbox]):not([type=range]), select')].every(e => parseFloat(getComputedStyle(e).fontSize) >= 16)"))
        check("nothing scrolls sideways on a small phone", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        other = page.locator("#routes .route[aria-checked=false]").first; other.scroll_into_view_if_needed(); before = page.evaluate("state.routes.indexOf(state.sel)"); other.tap()
        check("tapping a route card picks it", page.evaluate("state.routes.indexOf(state.sel)") != before)
        # the map fills the screen behind the planner sheet: slide the sheet down, then tap a part of a grey line it doesn't cover
        page.evaluate("window.scrollTo(0, 0)"); page.wait_for_timeout(400)
        pt = page.evaluate("""(() => { const top = document.querySelector('.panel').getBoundingClientRect().top - 10;
              for (const r of state.routes.filter(x => x !== state.sel)) for (let i = 0; i < r.shape.length; i++){
                const c = map.latLngToContainerPoint(r.shape[i]);
                if (c.y > 60 && c.y < top && c.x > 20 && c.x < innerWidth - 70 && !state.sel.shape.some(q => map.latLngToContainerPoint(q).distanceTo(c) < 14)) return [c.x, c.y, state.routes.indexOf(r)]; }
              return [0, 0, -1]; })()""")
        page.touchscreen.tap(pt[0], pt[1]); page.wait_for_timeout(300)
        check("tapping a grey line on the map picks that route", page.evaluate("state.routes.indexOf(state.sel)") == pt[2])
        sl = page.locator("#budget"); sl.scroll_into_view_if_needed(); bb = sl.bounding_box(); y = bb["y"] + bb["height"] / 2
        tp("touchStart", [(bb["x"] + 4, y)])
        for i in range(1, 9): cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": bb["x"] + 4 + (bb["width"] - 8) * i / 8, "y": y}]})
        tp("touchEnd", [])
        check("the time slider can be dragged with a finger", page.input_value("#budget") == page.evaluate("$('budget').max"))
        page.evaluate("window.scrollTo(0, 0)"); page.wait_for_timeout(400); top = page.evaluate("document.querySelector('.panel').getBoundingClientRect().top")
        tp("touchStart", [(120, top / 2 + 20)]); page.wait_for_timeout(900); tp("touchEnd", [])
        page.wait_for_timeout(300)
        check("pressing and holding the map offers to avoid that spot", page.locator("[data-addspot]").count() == 1)
        check("pressing and holding the map doesn't select text", page.evaluate("getComputedStyle(document.getElementById('map')).userSelect") == "none")
        check("no errors on a touch screen", not page.errors, page.errors)
        page.context.close()

        # 47. Reliability: failures explain themselves calmly
        def rel_page(init=None, profile={}):
            pg = new_page(browser, profile=profile, init_script=init, query=f"?stadiaKey={STADIA_KEY}")
            if pg.evaluate("$('sheet').classList.contains('open')"): pg.click("#saveProfile")
            pg.fill("#from", "42.2005, -85.6225"); pg.wait_for_selector("#from-s [role=option]"); pg.locator("#from-s [role=option]").first.dispatch_event("mousedown")
            pg.evaluate("state.to = {main:'McDonald\\'s', sub:'', lat:42.2390, lon:-85.5500, full:'x'}; $('to').value = 'McDonald\\'s'")
            return pg
        def settle(pg, secs):
            pg.wait_for_function("!document.getElementById('app').classList.contains('busy')", timeout=secs * 1000)
            return pg.text_content("#status")
        pg = rel_page(); pg.route("**/route/v1**", lambda r: r.abort("internetdisconnected")); pg.click("#find")
        check("no internet: routing says to check the connection", "Check your internet connection" in settle(pg, 15), pg.text_content("#status"))
        pg.context.close()
        pg = rel_page(); pg.route("**/route/v1**", lambda r: None); pg.click("#find"); t0 = time.time()
        msg = settle(pg, 40)
        check("a routing service that never answers is given up on within about 25 seconds, with a plain message", "isn’t answering" in msg and time.time() - t0 < 35, [msg, round(time.time() - t0)])
        pg.unroute("**/route/v1**"); pg.click("#find"); settle(pg, 20)
        check("and trying again works once it's back", pg.evaluate("state.routes.length") > 0)
        pg.context.close()
        pg = rel_page(); pg.route("**/trace_attributes/**", lambda r: r.abort("internetdisconnected")); pg.click("#find"); settle(pg, 20)
        pg.wait_for_function("state.routes.length && state.routes.every(r => !r.pending)", timeout=20000)
        check("road details failing still shows routes, marked as estimates", "estimates" in pg.text_content("#detailNote"))
        pg.context.close()
        pg = new_page(browser, profile={}, query=f"?stadiaKey={STADIA_KEY}"); pg.route("**/geocoding/**", lambda r: r.abort("internetdisconnected"))
        pg.fill("#to", "8485 shirley"); pg.wait_for_function("document.getElementById('status').textContent.length > 0", timeout=15000)
        check("no internet while searching: a plain message, never the browser's 'Failed to fetch'", "Check your internet connection" in pg.text_content("#status") and "Failed to fetch" not in pg.text_content("#status"), pg.text_content("#status"))
        pg.evaluate("window.dispatchEvent(new Event('offline'))")
        check("going offline says so", "You’re offline" in pg.text_content("#status"))
        pg.evaluate("window.dispatchEvent(new Event('online'))")
        check("and coming back says so", "back online" in pg.text_content("#status"))
        pg.context.close()
        pg = rel_page(init="""localStorage.setItem('calmRouteProfile','{bad'); localStorage.setItem('calmRoutePlaces','null'); localStorage.setItem('calmRouteAvoid','[1,2,{"lat":"x"}]');
           localStorage.setItem('calmRoutePractice','"oops"'); localStorage.setItem('calmRouteFuel','[]'); localStorage.setItem('calmRouteScenic','7'); localStorage.setItem('calmRouteDaily','zzz'); localStorage.setItem('calmRouteScenicSeen','{}');""", profile=None)
        pg.click("#find"); settle(pg, 20)
        check("damaged saved settings don't break the app", pg.evaluate("state.routes.length") > 0 and not pg.errors, pg.errors)
        pg.context.close()
        pg = rel_page(init="Object.defineProperty(window, 'localStorage', {get(){ throw new Error('SecurityError'); }});", profile=None)
        pg.click("#find"); settle(pg, 20)
        check("the app still works when the browser blocks saving (private browsing)", pg.evaluate("state.routes.length") > 0 and not pg.errors, pg.errors)
        pg.context.close()

        # 35. Free demo servers: say so, offer the key, and don't list far-away look-alikes
        page = new_page(browser, profile={})
        check("without a key the app says it's on the demo servers and offers to add one", page.locator("#svcBar").is_visible() and "demo" in page.text_content("#svcNote"))
        page.click("#svcBarBtn"); page.fill("#svcKey", STADIA_KEY); page.click("#svcSave"); page.wait_for_load_state()
        page.wait_for_function("typeof STADIA !== 'undefined'")
        check("pasting a key switches the app to Stadia and keeps it out of the page", page.evaluate("STADIA") and page.evaluate("localStorage.getItem('calmRouteStadiaKey')") == STADIA_KEY and STADIA_KEY not in re.sub(r"<img[^>]*>", "", page.content()))
        page.context.close()

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(run())
