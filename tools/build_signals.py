"""Build a traffic-light file for Calm Route.

Input: a JSON list of [lat, lon] traffic-light points (OpenStreetMap highway=traffic_signals),
taken from one rectangle, for example an Overpass query

    [out:json];node(S,W,N,E)["highway"="traffic_signals"];out skel qt;

Output: signals/<region>.js, a small script the app loads once. A script (not a JSON fetch) so it also
works when the app is opened as a local file. It sets window.CALM_SIGNALS[region] to:

    {"v":1, "region":"US-MI", "built":"2026-11-13", "bbox":[S,W,N,E], "n":N, "scale":100000,
     "data":"<base64>"}

"data" holds the points sorted by latitude, as zigzag varint deltas of lat and lon at 1e-5 degrees
(about 1 m). The rectangle matters: the app treats every place inside it as covered, so a left turn
there with no light nearby is reported as having no light. Only build from a query over the whole
rectangle, never from a state outline, or border towns would look like they have no lights.

Usage:  python3 build_signals.py points.json US-MI 41.69 -90.42 48.31 -82.12 [out_dir]

readfile() below reads a built .js back into the same dict (used by the tests).
"""
import base64, datetime, json, os, sys

SCALE = 100_000


def zigzag(n):
    return (n << 1) ^ (n >> 63)


def varint(n, out):
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return


def encode(points):
    q = sorted({(round(lat * SCALE), round(lon * SCALE)) for lat, lon in points})   # also removes duplicates
    out, plat, plon = bytearray(), 0, 0
    for lat, lon in q:
        varint(zigzag(lat - plat), out)
        varint(zigzag(lon - plon), out)
        plat, plon = lat, lon
    return len(q), base64.b64encode(bytes(out)).decode()


def decode(data):
    """Reference decoder, the same steps the app takes. Used by the self-check below."""
    raw, i, lat, lon, pts = base64.b64decode(data), 0, 0, 0, []
    def read():
        nonlocal i
        shift = result = 0
        while True:
            b = raw[i]; i += 1
            result |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                return (result >> 1) ^ -(result & 1)
    while i < len(raw):
        lat += read(); lon += read()
        pts.append((lat / SCALE, lon / SCALE))
    return pts


def readfile(path):
    t = open(path).read()
    return json.loads(t[t.index("]=") + 2:].rstrip().rstrip(";"))


def main():
    src, region = sys.argv[1], sys.argv[2]
    bbox = [float(x) for x in sys.argv[3:7]]
    out_dir = sys.argv[7] if len(sys.argv) > 7 else "signals"
    pts = [p for p in json.load(open(src)) if bbox[0] <= p[0] <= bbox[2] and bbox[1] <= p[1] <= bbox[3]]
    n, data = encode(pts)
    back = decode(data)
    assert len(back) == n and all(abs(a - round(a * SCALE) / SCALE) < 1e-9 for a, _ in back[:50])
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{region}.js")
    body = json.dumps({"v": 1, "region": region, "built": datetime.date.today().isoformat(), "bbox": bbox,
                       "n": n, "scale": SCALE, "data": data}, separators=(",", ":"))
    with open(path, "w") as f:
        f.write(f"(window.CALM_SIGNALS=window.CALM_SIGNALS||{{}})[{json.dumps(region)}]={body};\n")
    print(f"{path}: {n} lights, {os.path.getsize(path) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
