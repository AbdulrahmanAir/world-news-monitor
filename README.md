# World News Monitor

A crisp, popup-free world news dashboard — dark world map with headline markers
and one fixed side panel. Inspired by [World Monitor](https://www.worldmonitor.app/),
minus the clutter.

## Run

```sh
python3 server.py
```

Then open <http://localhost:3000>. No dependencies — Python 3 stdlib only.

## How it works

- `server.py` fetches 8 world-news RSS feeds (BBC, Al Jazeera, Guardian, NYT,
  France 24, DW, NPR, CNN) every 5 minutes, deduplicates headlines, and geotags
  them by matching country/city names from `data/locations.json`.
- The frontend (`public/`) is plain HTML/CSS/JS with Leaflet and free CARTO
  dark tiles (label-free); continent and country names are rendered by the app
  in English only. The browser polls `/api/news` every 2 minutes.

## Using it

- **Click a marker** → the side panel filters to that location and the map
  flies there. Press **Esc** or the ✕ to clear. No popups, ever.
- **Source chips** in the top bar toggle feeds on/off.
- Marker size reflects how many headlines mention that place; hover shows
  the name and count.
- **⟳** refreshes immediately; new headlines flash briefly when they arrive.

## Tweaking

- Add/remove feeds in the `FEEDS` list at the top of `server.py`.
- Add places or aliases in `data/locations.json` (longest match wins).
- Port: `PORT=8080 python3 server.py`.
