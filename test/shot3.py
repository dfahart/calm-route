import json, test_app as T
from playwright.sync_api import sync_playwright
init = "localStorage.setItem('calmRouteFuel', JSON.stringify({on:true, city:'25', hw:'38', price:'3.15'})); localStorage.setItem('calmRoutePractice', JSON.stringify({on:true, skill:'merge', levels:{merge:1,left:2,boxed:2,bridge:2,turns:2}, pebbles:5, drives:3}));"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    T.TOLL["on"] = True
    page = T.new_page(b, profile={"toll": 2, "bridge": 3}, width=360, height=780, mobile=True, init_script=init)
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    T.type_and_pick(page, "to", "mcdonalds", 1)
    T.find_routes(page)
    page.evaluate("noteDriveStarted(); practiceCfg.askAfter = 0; renderAsk()")
    print("overflow:", page.evaluate("document.documentElement.scrollWidth - window.innerWidth"), page.errors)
    print("small tap targets:", page.evaluate("[...document.querySelectorAll('button, a, select, input, summary')].filter(e => e.offsetParent && (e.getBoundingClientRect().height < 24)).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().height))"))
    page.screenshot(path="a3_full.png", full_page=True)
    page.click("#editProfile"); page.wait_for_timeout(200)
    print("quiz overflow:", page.evaluate("document.documentElement.scrollWidth - window.innerWidth"))
    b.close()
