const POLL_MS = 2 * 60 * 1000;

const state = {
  items: [],
  sources: [],
  updatedAt: null,
  enabledSources: null, // Set of source ids; null until first load
  locationFilter: null, // location name or null
  seenKeys: new Set(),
  firstLoad: true,
};

// ---- map ----
const map = L.map('map', {
  worldCopyJump: true,
  minZoom: 2,
  maxZoom: 10,
  zoomControl: true,
  attributionControl: true,
}).setView([25, 15], 2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  subdomains: 'abcd',
}).addTo(map);

// English-only place labels rendered by the app (the CARTO label tiles mix
// local-language names, so we draw our own from the gazetteer instead).
const CONTINENTS = [
  { name: 'North America', lat: 47, lon: -101 },
  { name: 'South America', lat: -14, lon: -59 },
  { name: 'Europe', lat: 51, lon: 14 },
  { name: 'Africa', lat: 7, lon: 19 },
  { name: 'Asia', lat: 47, lon: 88 },
  { name: 'Oceania', lat: -24, lon: 136 },
];
let countryLabels = [];
const labelLayer = L.layerGroup().addTo(map);

function renderLabels() {
  labelLayer.clearLayers();
  const continents = map.getZoom() <= 3;
  const labels = continents ? CONTINENTS : countryLabels;
  const cls = continents ? 'map-label continent' : 'map-label country';
  for (const l of labels) {
    L.marker([l.lat, l.lon], {
      icon: L.divIcon({ className: cls, html: `<span>${l.name}</span>`, iconSize: null }),
      interactive: false,
      keyboard: false,
    }).addTo(labelLayer);
  }
}
map.on('zoomend', renderLabels);
renderLabels();
fetch('/api/labels')
  .then((r) => r.json())
  .then((labels) => {
    countryLabels = labels;
    renderLabels();
  });

const markerLayer = L.layerGroup().addTo(map);

// ---- helpers ----
const $ = (id) => document.getElementById(id);

function itemKey(item) {
  return item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function relTime(iso) {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function visibleItems() {
  return state.items.filter((item) => {
    if (state.enabledSources && !state.enabledSources.has(item.source)) return false;
    if (state.locationFilter && (!item.location || item.location.name !== state.locationFilter)) return false;
    return true;
  });
}

// ---- rendering ----
function renderChips() {
  const el = $('source-chips');
  el.innerHTML = '';
  for (const src of state.sources) {
    const chip = document.createElement('button');
    chip.className = 'chip' + (src.ok ? '' : ' dead') + (state.enabledSources.has(src.id) ? ' on' : '');
    chip.textContent = src.name;
    chip.title = src.ok ? `${src.count} headlines` : 'feed unavailable';
    if (src.ok) {
      chip.onclick = () => {
        if (state.enabledSources.has(src.id)) state.enabledSources.delete(src.id);
        else state.enabledSources.add(src.id);
        renderAll();
      };
    }
    el.appendChild(chip);
  }
}

function renderHeadlines() {
  const el = $('headlines');
  el.innerHTML = '';
  const items = visibleItems();
  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.items.length ? 'No headlines match the current filter.' : 'No headlines available — feeds may be unreachable.';
    el.appendChild(p);
    return;
  }
  for (const item of items) {
    const a = document.createElement('a');
    a.className = 'headline';
    a.href = item.link;
    a.target = '_blank';
    a.rel = 'noopener';
    if (!state.firstLoad && !state.seenKeys.has(itemKey(item))) a.classList.add('fresh');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const src = document.createElement('span');
    src.className = 'src';
    src.textContent = item.sourceName;
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = relTime(item.publishedAt);
    meta.append(src, time);
    if (item.location) {
      const loc = document.createElement('span');
      loc.className = 'loc';
      loc.textContent = item.location.name;
      meta.appendChild(loc);
    }

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title;

    a.append(meta, title);
    el.appendChild(a);
  }
}

function renderMarkers() {
  markerLayer.clearLayers();
  const bySourceVisible = state.items.filter(
    (i) => i.location && (!state.enabledSources || state.enabledSources.has(i.source))
  );
  const groups = new Map();
  for (const item of bySourceVisible) {
    const g = groups.get(item.location.name) || { ...item.location, count: 0 };
    g.count++;
    groups.set(item.location.name, g);
  }
  for (const g of groups.values()) {
    const active = state.locationFilter === g.name;
    const radius = Math.min(4 + Math.sqrt(g.count) * 2.4, 16);
    const marker = L.circleMarker([g.lat, g.lon], {
      radius,
      color: active ? '#fff' : '#4cc2ff',
      weight: active ? 1.5 : 1,
      fillColor: '#4cc2ff',
      fillOpacity: active ? 0.75 : 0.35,
    });
    marker.bindTooltip(`${g.name} · ${g.count}`, {
      className: 'loc-tooltip',
      direction: 'top',
      offset: [0, -radius],
    });
    marker.on('click', () => {
      setLocationFilter(g.name === state.locationFilter ? null : g.name);
      if (state.locationFilter) map.flyTo([g.lat, g.lon], Math.max(map.getZoom(), 4), { duration: 0.8 });
    });
    marker.addTo(markerLayer);
  }
}

function renderFilterBar() {
  const bar = $('filter-bar');
  if (state.locationFilter) {
    bar.classList.remove('hidden');
    $('filter-name').textContent = state.locationFilter;
  } else {
    bar.classList.add('hidden');
  }
}

function renderUpdated() {
  $('updated').textContent = state.updatedAt ? `updated ${relTime(state.updatedAt)} ago` : '—';
}

function renderAll() {
  renderChips();
  renderHeadlines();
  renderMarkers();
  renderFilterBar();
  renderUpdated();
}

function setLocationFilter(name) {
  state.locationFilter = name;
  renderHeadlines();
  renderMarkers();
  renderFilterBar();
}

$('filter-clear').onclick = () => setLocationFilter(null);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setLocationFilter(null);
});

// ---- data ----
async function load() {
  const btn = $('refresh-btn');
  btn.classList.add('spinning');
  try {
    const res = await fetch('/api/news');
    const data = await res.json();
    state.sources = data.sources || [];
    state.updatedAt = data.updatedAt;
    state.items = data.items || [];
    if (!state.enabledSources) {
      state.enabledSources = new Set(state.sources.filter((s) => s.ok).map((s) => s.id));
    }
    renderAll();
    for (const item of state.items) state.seenKeys.add(itemKey(item));
    state.firstLoad = false;
  } catch (err) {
    console.error('load failed', err);
  } finally {
    btn.classList.remove('spinning');
  }
}

$('refresh-btn').onclick = load;
load();
setInterval(load, POLL_MS);

// ---- clock ----
function tick() {
  $('clock').textContent = new Date().toISOString().slice(11, 19) + ' UTC';
  renderUpdated();
}
tick();
setInterval(tick, 1000);
