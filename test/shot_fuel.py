import test_app as T
from playwright.sync_api import sync_playwright
init = "localStorage.setItem('calmRouteFuel', JSON.stringify({on:true, city:'25', hw:'38', price:'3.15'}));"
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = T.new_page(b, profile={"toll": 2}, width=1280, height=1700, init_script=init)
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    T.type_and_pick(page, "to", "mcdonalds", 1)
    T.find_routes(page)
    page.evaluate("document.querySelector('.scroll').scrollTop = 700")
    page.locator(".panel").screenshot(path="fuel.png")
    print(page.errors)
    b.close()
