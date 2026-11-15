import json, test_app as T
from playwright.sync_api import sync_playwright
prac = {"on": True, "skill": "merge", "levels": {"merge": 1, "left": 3, "boxed": 2, "bridge": 1, "turns": 4}, "pebbles": 12, "drives": 7, "practiceDrives": 3, "levelUps": 2,
        "totals": {"merges": 4, "lefts": 9, "bridges": 1, "hwMiles": 14}, "keepsakes": ["first", "merge", "left", "practice", "five"]}
init = f"localStorage.setItem('calmRoutePractice', {json.dumps(json.dumps(prac))}); localStorage.setItem('calmRoutePlaces', JSON.stringify({{home:{{main:'Home', sub:'', lat:42.2005, lon:-85.6225}}, work:null, recent:[]}}));"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for name, w, h, mob in (("d", 1280, 1500, False), ("m", 375, 812, True)):
        page = T.new_page(b, profile={"bridge": 3}, width=w, height=h, mobile=mob, init_script=init)
        page.click("#pebbleCard summary")
        page.focus("#from"); page.click("#quick [data-go=home]")
        T.type_and_pick(page, "to", "mcdonalds", 0)
        T.find_routes(page)
        page.evaluate("noteDriveStarted(); practiceCfg.askAfter = 0; renderAsk()")
        page.wait_for_timeout(300)
        if mob:
            page.evaluate("window.scrollTo(0, document.querySelector('.panel').offsetTop)"); page.screenshot(path="new_m1.png")
            page.evaluate("document.getElementById('results').scrollIntoView()"); page.screenshot(path="new_m2.png")
            page.evaluate("document.getElementById('momentBox').scrollIntoView({block:'center'})"); page.screenshot(path="new_m3.png")
        else:
            page.locator(".panel").screenshot(path="new_d.png")
            page.evaluate("document.querySelector('.scroll').scrollTop = 99999"); page.locator(".panel").screenshot(path="new_d2.png")
        print(name, page.errors)
    b.close()
