import test_app as T
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    for k in range(4):
        page = T.new_page(b, profile={"merge": 3})
        page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
        T.type_and_pick(page, "to", "mcdonalds", 1)
        T.find_routes(page)
        page.evaluate("selectRoute(state.routes.indexOf(state.routes.find(r => r.merges === 0)))")
        page.evaluate("window.__z=[]; const sv = map.setView.bind(map); map.setView = (...a) => { __z.push('setView ' + a[1] + ' ' + new Error().stack.split('\\n')[2].trim()); return sv(...a); }; const fb = map.fitBounds.bind(map); map.fitBounds = (...a) => { __z.push('fit ' + new Error().stack.split('\\n')[2].trim()); return fb(...a); }; 0")
        page.locator("#momentBox .where").first.click()
        page.wait_for_timeout(700)
        print(page.evaluate("map.getZoom()"), page.evaluate("__z"))
        page.context.close()
    b.close()
