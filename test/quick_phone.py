from test_app import *
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = new_page(b, profile={}, width=375, height=812, mobile=True)
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    page.fill("#to", "42.30, -85.55"); page.wait_for_selector("#to-s [role=option]"); page.locator("#to-s [role=option]").first.dispatch_event("mousedown")
    find_routes(page)
    page.wait_for_timeout(1200)
    top = page.evaluate("document.getElementById('results').getBoundingClientRect().top")
    print("results top after search:", top, "scrollY:", page.evaluate("scrollY"))
    page.screenshot(path="phone2.png")
    b.close()
