#!/usr/bin/env python3
"""World News Monitor — stdlib-only server.

Fetches world-news RSS feeds, geotags headlines against data/locations.json,
and serves the dashboard at http://localhost:3000. Run: python3 server.py
"""

import json
import os
import re
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(os.environ.get("PORT", 3000))
HOST = os.environ.get("HOST", "127.0.0.1")  # deploys set HOST=0.0.0.0
REFRESH_SECONDS = 5 * 60
MAX_PER_FEED = 30
MAX_ITEMS = 300

FEEDS = [
    {"id": "bbc", "name": "BBC", "url": "https://feeds.bbci.co.uk/news/world/rss.xml"},
    {"id": "aljazeera", "name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml"},
    {"id": "guardian", "name": "Guardian", "url": "https://www.theguardian.com/world/rss"},
    {"id": "nyt", "name": "NYT", "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"},
    {"id": "france24", "name": "France 24", "url": "https://www.france24.com/en/rss"},
    {"id": "dw", "name": "DW", "url": "https://rss.dw.com/rdf/rss-en-world"},
    {"id": "npr", "name": "NPR", "url": "https://feeds.npr.org/1004/rss.xml"},
    {"id": "cnn", "name": "CNN", "url": "http://rss.cnn.com/rss/edition_world.rss"},
]

# ---------------------------------------------------------------- geotagging

# Longest pattern first so "South Korea" beats "Korea" and "New Delhi" beats
# "Delhi". Case-sensitive: proper nouns are capitalized in headlines, and this
# keeps aliases like "US"/"LA" from matching ordinary words.
def build_matchers():
    locations = json.loads((ROOT / "data" / "locations.json").read_text())
    matchers = []
    for loc in locations:
        place = {"name": loc["name"], "lat": loc["lat"], "lon": loc["lon"]}
        for pattern in [loc["name"], *loc["aliases"]]:
            regex = re.compile(r"(^|[^A-Za-z])" + re.escape(pattern) + r"([^A-Za-z]|$)")
            matchers.append((len(pattern), regex, place))
    matchers.sort(key=lambda m: -m[0])
    return matchers


MATCHERS = build_matchers()

# English-only country labels for the map (city entries are markers, not labels)
LABELS = [
    {"name": loc["name"], "lat": loc["lat"], "lon": loc["lon"]}
    for loc in json.loads((ROOT / "data" / "locations.json").read_text())
    if not loc.get("city")
]


def geotag(text):
    for _, regex, place in MATCHERS:
        if regex.search(text):
            return place
    return None


# ------------------------------------------------------------- feed fetching

TAG_RE = re.compile(r"<[^>]*>")
WS_RE = re.compile(r"\s+")


def strip_html(s):
    return WS_RE.sub(" ", TAG_RE.sub(" ", s or "")).strip()


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def child_text(elem, *names):
    wanted = set(names)
    for child in elem:
        if local_name(child.tag) in wanted:
            text = child.text or child.get("href") or ""
            if text.strip():
                return text.strip()
    return ""


def parse_date(raw):
    if not raw:
        return None
    for parse in (parsedate_to_datetime, datetime.fromisoformat):
        try:
            dt = parse(raw.replace("Z", "+00:00") if parse is datetime.fromisoformat else raw)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat()
        except (ValueError, TypeError):
            continue
    return None


def fetch_feed(feed):
    """Parse RSS 2.0, RDF, or Atom into headline dicts."""
    req = urllib.request.Request(feed["url"], headers={"User-Agent": "world-news-monitor/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        root = ET.fromstring(resp.read())

    entries = [el for el in root.iter() if local_name(el.tag) in ("item", "entry")]
    items = []
    for entry in entries[:MAX_PER_FEED]:
        title = strip_html(child_text(entry, "title"))
        if not title:
            continue
        summary = strip_html(child_text(entry, "description", "summary"))
        items.append({
            "title": title,
            "link": child_text(entry, "link"),
            "source": feed["id"],
            "sourceName": feed["name"],
            "publishedAt": parse_date(child_text(entry, "pubDate", "date", "updated", "published")),
            "location": geotag(f"{title} {summary}"),
        })
    return items


cache = {"updatedAt": None, "sources": [], "items": []}
cache_lock = threading.Lock()


def refresh():
    items, sources = [], []
    results = {}

    def worker(feed):
        try:
            results[feed["id"]] = fetch_feed(feed)
        except Exception as exc:
            results[feed["id"]] = exc

    threads = [threading.Thread(target=worker, args=(f,)) for f in FEEDS]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    for feed in FEEDS:
        result = results.get(feed["id"])
        if isinstance(result, list):
            sources.append({"id": feed["id"], "name": feed["name"], "count": len(result), "ok": True})
            items.extend(result)
        else:
            sources.append({"id": feed["id"], "name": feed["name"], "count": 0, "ok": False})
            print(f"[feed] {feed['name']} failed: {result}")

    seen = set()
    deduped = []
    for item in items:
        key = re.sub(r"[^a-z0-9]+", " ", item["title"].lower()).strip()
        if key and key not in seen:
            seen.add(key)
            deduped.append(item)
    deduped.sort(key=lambda i: i["publishedAt"] or "", reverse=True)

    with cache_lock:
        cache.update(
            updatedAt=datetime.now(timezone.utc).isoformat(),
            sources=sources,
            items=deduped[:MAX_ITEMS],
        )
    tagged = sum(1 for i in cache["items"] if i["location"])
    ok = sum(1 for s in sources if s["ok"])
    print(f"[refresh] {len(cache['items'])} headlines from {ok}/{len(FEEDS)} feeds, {tagged} geotagged")


def refresh_loop():
    while True:
        try:
            refresh()
        except Exception as exc:
            print(f"[refresh] failed: {exc}")
        time.sleep(REFRESH_SECONDS)


# -------------------------------------------------------------------- server

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/news":
            with cache_lock:
                self.send_json(json.dumps(cache).encode())
        elif path == "/api/labels":
            self.send_json(json.dumps(LABELS).encode())
        else:
            super().do_GET()

    def send_json(self, body):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the console to feed-refresh lines only


def main():
    threading.Thread(target=refresh_loop, daemon=True).start()
    handler = partial(Handler, directory=str(ROOT / "public"))
    server = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"World News Monitor → http://localhost:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
