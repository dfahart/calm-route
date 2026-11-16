"""Download every traffic light in a rectangle from OpenStreetMap.

    python3 tools/fetch_signals.py SOUTH WEST NORTH EAST points.json                         # Overpass, in tiles
    python3 tools/fetch_signals.py SOUTH WEST NORTH EAST points.json --pbf "florida georgia"  # Geofabrik state files

Geofabrik mode downloads each state's ready-made OpenStreetMap file and filters it with osmium (needs
osmium-tool). It doesn't depend on the busy public Overpass servers. List every state the rectangle touches:
the app treats the whole rectangle as covered.

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


def from_pbf(states, s, w, n, e):
    import os, subprocess
    pts = []
    for st in states:
        url = f"https://download.geofabrik.de/north-america/us/{st}-latest.osm.pbf"
        for attempt in range(3):
            try:
                print(f"downloading {url}")
                subprocess.run(["curl", "-sS", "--fail", "-L", "--retry", "3", "-o", "state.pbf", url], check=True, timeout=1800)
                break
            except Exception as ex:
                print(f"  failed: {ex}"); time.sleep(60)
        else:
            sys.exit(f"Couldn't download {st}; keeping the old file.")
        subprocess.run(["osmium", "tags-filter", "state.pbf", "n/highway=traffic_signals", "-o", "sig.osm.pbf", "--overwrite"], check=True)
        subprocess.run(["osmium", "export", "sig.osm.pbf", "-f", "geojsonseq", "-o", "sig.geojsonseq", "--overwrite"], check=True)
        k = 0
        for line in open("sig.geojsonseq"):
            line = line.strip().lstrip("\x1e")
            if not line: continue
            g = json.loads(line).get("geometry") or {}
            if g.get("type") != "Point": continue
            lon, lat = g["coordinates"]
            if s <= lat <= n and w <= lon <= e:
                pts.append([lat, lon]); k += 1
        print(f"  {st}: {k} lights in the rectangle")
        os.remove("state.pbf")
    return pts


def main():
    s, w, n, e = map(float, sys.argv[1:5])
    out = sys.argv[5]
    if "--pbf" in sys.argv:
        got = from_pbf(sys.argv[sys.argv.index("--pbf") + 1].split(), s, w, n, e)
        seen, pts = set(), []
        for p in got:
            k = (round(p[0], 6), round(p[1], 6))
            if k not in seen: seen.add(k); pts.append(p)
        json.dump(pts, open(out, "w")); print(f"total {len(pts)} lights"); return
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
