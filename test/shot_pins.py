import test_app as T
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for w, h, mob in ((360, 740, True), (1280, 900, False)):
        page = T.new_page(b, profile={}, width=w, height=h, mobile=mob)
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        T.type_and_pick(page, "to", "mcdonalds", 1); T.find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r !== state.fast)))"); T.wait_pins(page)
        bar = page.evaluate("(() => { const r = document.querySelector('.actionrow'); return [r.scrollWidth, r.clientWidth, document.documentElement.scrollWidth - innerWidth]; })()")
        print(w, bar, page.text_content("#detailNote"), page.errors)
        if not mob: page.screenshot(path="pins_d.png")
    b.close()
