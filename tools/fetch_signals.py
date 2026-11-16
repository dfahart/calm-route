"""Download every traffic light in a rectangle from OpenStreetMap (Overpass), in tiles.

    python3 tools/fetch_signals.py SOUTH WEST NORTH EAST points.json

A whole state in one request often times out on the public servers (502/504), so the rectangle is split into
tiles of at most 2 x 2 degrees. Each tile tries three servers, three rounds, waiting longer each round.
If any tile still fails, nothing is written and the script exits with an error: a file with a hole in it would
make the app think a road has no traffic light where it does, so the old file must stay instead.
"""
import json, math, sys, time, urllib.parse, urllib.request

SERVERS = ["https://overpass-api.de", "https://overpass.kumi.systems", "https://overpass.private.coffee"]
AGENT = "CalmRoute-signal-refresh/2 (monthly; github.com/dfahart/calm-route)"


def fetch_tile(s, w, n, e):
    q = f'[out:json][timeout:240];node({s},{w},{n},{e})["highway"="traffic_signals"];out skel qt;'
    body = urllib.parse.urlencode({"data": q}).encode()
    for rnd in range(3):
        for server in SERVERS:
            try:
                req = urllib.request.Request(server + "/api/interpreter", data=body, headers={"User-Agent": AGENT})
                with urllib.request.urlopen(req, timeout=300) as r:
                    d = json.load(r)
                if "elements" in d and "remark" not in d:      # a 'remark' means the server gave up part way
                    return [[el["lat"], el["lon"]] for el in d["elements"]]
                print(f"  {server}: incomplete answer ({d.get('remark', 'no elements')[:80]})")
            except Exception as ex:
                print(f"  {server}: {ex}")
            time.sleep(15)
        time.sleep(60 * (rnd + 1))
    return None


def main():
    s, w, n, e = map(float, sys.argv[1:5])
    out = sys.argv[5]
    rows, cols = math.ceil((n - s) / 2), math.ceil((e - w) / 2)
    dl, dw = (n - s) / rows, (e - w) / cols
    pts, seen = [], set()
    for i in range(rows):
        for j in range(cols):
            ts, tw = s + i * dl, w + j * dw
            tile = (round(ts, 4), round(tw, 4), round(ts + dl, 4), round(tw + dw, 4))
            print(f"tile {i * cols + j + 1} of {rows * cols}: {tile}")
            got = fetch_tile(*tile)
            if got is None:
                sys.exit(f"Tile {tile} failed on every server; keeping the old file.")
            for p in got:                                   # a light on a tile edge comes back twice
                k = (round(p[0], 6), round(p[1], 6))
                if k not in seen:
                    seen.add(k); pts.append(p)
            print(f"  {len(got)} lights")
            time.sleep(5)                                   # be gentle: volunteer-run servers
    json.dump(pts, open(out, "w"))
    print(f"total {len(pts)} lights")


if __name__ == "__main__":
    main()
