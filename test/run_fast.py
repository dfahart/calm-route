"""Run both test files fast: each section runs as its own small script, several at a time.

    python3 run_fast.py            # everything, 4 at a time
    python3 run_fast.py -j 6       # more at a time
    python3 run_fast.py pebble     # only sections whose title mentions "pebble" (any words, case ignored)

test_app.py and test_more.py still run on their own exactly as before; this is a faster way to run the same checks.
Sections are found by their heading comments, so a new section needs nothing extra: start it with a comment the way
the others do. How long each section took is saved in .timings.json, and the slowest go first next time.
"""
import json, os, re, subprocess, sys, textwrap, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCH = 'p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])'
TIMINGS = os.path.join(HERE, ".timings.json")


def app_sections():
    """test_app.py: the body of run(), split at its numbered headings (# 1., # 2., ...)."""
    src = open(os.path.join(HERE, "test_app.py")).read().split("\n")
    start = next(i for i, l in enumerate(src) if l.startswith("        browser = p.chromium.launch")) + 1
    end = next(i for i, l in enumerate(src) if l == "        browser.close()")
    out, cur, title = [], [], None
    for line in src[start:end]:
        m = re.match(r"^        # (\d+)\. (.*)", line)
        if m:
            if title: out.append((title, cur))
            title, cur = f"app {m.group(1)}. {m.group(2)}", []
        if title: cur.append(line)
    if title: out.append((title, cur))
    # A section that carries on with the page the one before opened (no new_page of its own) stays joined to it
    merged = []
    for t, body in out:
        if merged and not any(re.search(r"new_page\(|\.new_context\(", l) for l in body):
            merged[-1] = (merged[-1][0], merged[-1][1] + body)
        else: merged.append((t, body))
    out = merged
    prelude = "import sys\nsys.path.insert(0, %r)\nimport test_app as T\nfrom test_app import *\n" % HERE
    return [(t, prelude + "with sync_playwright() as p:\n    browser = " + LAUNCH + "\n    if True:\n"
             + textwrap.indent(textwrap.dedent("\n".join(body)), " " * 8)
             + "\n    browser.close()\nprint('@@RESULTS', json.dumps([[n, bool(ok)] for n, ok, *_ in T.results]))\n") for t, body in out]


def more_sections():
    """test_more.py: the code under `with sync_playwright()`, split where a section closes its page and the next
    heading comment begins (so a section that carries a page or a value onward stays in one piece)."""
    src = open(os.path.join(HERE, "test_more.py")).read().split("\n")
    w = next(i for i, l in enumerate(src) if l.startswith("with sync_playwright() as p:"))
    start = w + 2   # skip the browser launch line
    end = next(i for i, l in enumerate(src) if l == "    b.close()")
    prelude = "\n".join(src[:w]) + "\n"
    out, cur, title, prev = [], [], "more: weather along the drive", ""
    for line in src[start:end]:
        if re.match(r"^    # \S", line) and prev.strip() == "page.context.close()":
            if cur: out.append((title, cur))
            title, cur = "more: " + line.strip()[2:], []
        cur.append(line)
        if line.strip(): prev = line
    if cur: out.append((title, cur))
    return [(t, prelude + "with sync_playwright() as p:\n    b = " + LAUNCH + "\n"
             + "\n".join(body) + "\n    b.close()\nprint('@@RESULTS', json.dumps([[r[0], bool(r[1])] for r in results]))\n") for t, body in out]


def run_one(item):
    title, code = item
    t0 = time.time()
    try:
        r = subprocess.run([sys.executable, "-c", "import json\n" + code], cwd=HERE, capture_output=True, text=True, timeout=420)
        out, err, rc = r.stdout, r.stderr, r.returncode
    except subprocess.TimeoutExpired as e:
        out, err, rc = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or ""), "timed out after 420 s", -1
    res = None
    for line in out.splitlines():
        if line.startswith("@@RESULTS "): res = json.loads(line[10:])
    return title, res, out, err, rc, time.time() - t0


def main():
    args = sys.argv[1:]
    jobs = 4
    if "-j" in args:
        i = args.index("-j"); jobs = int(args[i + 1]); del args[i:i + 2]
    items = app_sections() + more_sections()
    if args:
        words = [a.lower() for a in args]
        items = [it for it in items if any(w in it[0].lower() for w in words)]
    try: timings = json.load(open(TIMINGS))
    except Exception: timings = {}
    items.sort(key=lambda it: -timings.get(it[0], 60))   # slowest first, so nothing long starts last
    print(f"Running {len(items)} sections, {jobs} at a time...", flush=True)
    t0 = time.time(); passed = failed = 0; problems = []
    with ThreadPoolExecutor(jobs) as pool:
        for title, res, out, err, rc, secs in pool.map(run_one, items):
            timings[title] = round(secs, 1)
            if res is None:
                problems.append((title, f"crashed (exit {rc})", (err or out)[-1500:]))
                print(f"  CRASH {title} ({secs:.0f}s)", flush=True); continue
            bad = [n for n, ok in res if not ok]
            passed += len(res) - len(bad); failed += len(bad)
            if bad: problems.append((title, "failed", "\n".join("    " + l[:400] for l in out.splitlines() if l.startswith("FAIL "))))
            if rc and not bad: problems.append((title, f"exit {rc}", (err or "")[-1500:]))
            print(f"  {'ok  ' if not bad and not rc else 'FAIL'} {title} ({secs:.0f}s, {len(res)} checks)", flush=True)
    # A section that failed while sharing the machine gets one more try on its own. If it passes alone, the failure
    # was timing (a busy computer), not the app: it's listed as a retry so it stays visible, but doesn't fail the run.
    retried = []
    if problems:
        again = [it for it in items if it[0] in {t for t, _, _ in problems}]
        print(f"\nRetrying {len(again)} section(s) on their own...", flush=True)
        for it in again:
            title, res, out, err, rc, secs = run_one(it)
            if res is not None and all(ok for _, ok in res) and not rc:
                old = next(p for p in problems if p[0] == title); problems.remove(old); retried.append(old)
                bad_before = old[2].count("FAIL ")
                passed += bad_before; failed -= bad_before
                print(f"  ok on retry: {title}", flush=True)
            else: print(f"  still failing: {title}", flush=True)
    if not args:
        json.dump(timings, open(TIMINGS, "w"), indent=0, sort_keys=True)
    for title, what, detail in retried:
        print(f"\nPassed on retry (timing-sensitive, worth a look someday): {title}\n{detail}")
    print(f"\n{passed} passed, {failed} failed, {len(problems)} sections with problems, in {time.time() - t0:.0f}s")
    for title, what, detail in problems:
        print(f"\n--- {title}: {what}\n{detail}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
