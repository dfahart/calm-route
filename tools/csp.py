"""Stamp the Content Security Policy with the hash of the page's own script.
Run after every edit to calm-route.html (the tests and the release copy need it):
    python3 tools/csp.py calm-route.html
The policy allows only this page's script, Leaflet from cdnjs (checked by its fingerprint), and the
map, search, weather and fuel services the app actually uses."""
import base64, hashlib, re, sys
path = sys.argv[1] if len(sys.argv) > 1 else "calm-route.html"
s = open(path, encoding="utf-8").read()
m = re.search(r"<script>(.*?)</script>", s, re.S)
digest = base64.b64encode(hashlib.sha256(m.group(1).encode("utf-8")).digest()).decode()
s2, n = re.subn(r"'sha256-[A-Za-z0-9+/=]+'|'sha256-SCRIPTHASH'", f"'sha256-{digest}'", s, count=1)
assert n == 1, "CSP placeholder not found"
open(path, "w", encoding="utf-8").write(s2)
print("script hash", digest)
