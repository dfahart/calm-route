import test_app as T
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    T.calls["stadia"].clear(); T.calls["photon"].clear(); T.calls["route"].clear()
    page = T.new_page(b, profile={}, query=f"?stadiaKey={T.STADIA_KEY}")
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    T.type_and_pick(page, "to", "mcdonalds", 1)
    T.find_routes(page)
    print(sorted(set(T.calls["stadia"])), len(T.calls["photon"]), len(T.calls["route"]))
    b.close()
