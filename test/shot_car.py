import test_app as T
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = T.new_page(b, profile={}, width=375, height=812, mobile=True)
    page.fill("#from", "42.2005, -85.6225"); page.wait_for_selector("#from-s [role=option]"); page.locator("#from-s [role=option]").first.dispatch_event("mousedown")
    T.type_and_pick(page, "to", "mcdonalds", 1); T.find_routes(page)
    page.click("#fuelBox summary"); page.check("#fuelOn")
    page.wait_for_function("document.getElementById('carYear').options.length > 1")
    page.select_option("#carYear", "2018"); page.wait_for_function("document.getElementById('carMake').options.length > 1")
    page.select_option("#carMake", "Honda"); page.wait_for_function("document.getElementById('carModel').options.length > 1")
    page.select_option("#carModel", "Civic 4Dr"); page.wait_for_function("document.getElementById('carTrim').options.length > 2")
    page.select_option("#carTrim", "102"); page.wait_for_function("document.getElementById('mpgCity').value === '30'")
    print("overflow:", page.evaluate("document.documentElement.scrollWidth - window.innerWidth"), page.errors)
    page.locator("#fuelBox").screenshot(path="car.png")
    b.close()
