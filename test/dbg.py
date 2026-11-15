import test_app as T
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for k in range(5):
        page = T.new_page(b, profile={"merge": 3})
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        T.type_and_pick(page, "to", "mcdonalds", 1)
        T.find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r.merges === 0)))")
        page.evaluate("window.__z=[]; map.on('zoomend moveend', e => __z.push(e.type + map.getZoom()))")
        page.locator("#momentBox .where").first.click()
        z0 = page.evaluate("map.getZoom()")
        page.wait_for_timeout(800)
        print(z0, page.evaluate("map.getZoom()"), page.evaluate("__z"), page.evaluate("document.activeElement.className"), page.evaluate("state.sel.events.length"))
        page.context.close()
    b.close()
