require('dotenv').config();

const express = require('express');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const POLL_MS = 120_000;

const BASE = 'https://smartthingsfind.samsung.com';
const URL_CSRF = `${BASE}/chkLogin.do`;
const URL_DEVICE_LIST = `${BASE}/device/getDeviceList.do`;
const URL_ADD_OP = `${BASE}/dm/addOperation.do`;
const URL_SET_LAST = `${BASE}/device/setLastSelect.do`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HISTORY_MAX = Number(process.env.HISTORY_MAX) || 250;

/** Snap GPS to nearest road (OSRM then Valhalla). Set SNAP_TO_ROAD=0 to disable. */
const SNAP_TO_ROAD = process.env.SNAP_TO_ROAD !== '0';

/** Public OSRM mirrors (tried in order). */
const OSRM_NEAREST_BASES = [
  'https://router.project-osrm.org/nearest/v1/driving',
  'https://routing.openstreetmap.de/routed-car/nearest/v1/driving',
];

const VALHALLA_LOCATE = 'https://valhalla1.openstreetmap.de/locate';

/**
 * Valhalla locate — correlates a point to the nearest road edge.
 * @returns {Promise<{ lat: number, lng: number, distanceM: null, source: string } | null>}
 */
async function snapValhallaLocate(lat, lng) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(VALHALLA_LOCATE, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations: [{ lat, lon: lng }] }),
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data[0]) return null;
    const edges = data[0].edges;
    if (!edges || !edges[0]) return null;
    const e = edges[0];
    const la = e.correlated_lat;
    const lo = e.correlated_lon;
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    return { lat: la, lng: lo, distanceM: null, source: 'valhalla' };
  } catch (e) {
    clearTimeout(t);
    console.warn('[snap] Valhalla locate failed:', e.message || e);
    return null;
  }
}

/**
 * @returns {Promise<{ lat: number, lng: number, distanceM: number|null, source: string } | null>}
 */
async function snapToRoad(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  for (const base of OSRM_NEAREST_BASES) {
    const url = `${base}/${lng},${lat}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      if (data.code !== 'Ok' || !data.waypoints || !data.waypoints[0]) continue;
      const wp = data.waypoints[0];
      const loc = wp.location;
      if (!Array.isArray(loc) || loc.length < 2) continue;
      const [lon2, lat2] = loc;
      if (!Number.isFinite(lat2) || !Number.isFinite(lon2)) continue;
      const dist = typeof wp.distance === 'number' ? wp.distance : null;
      return {
        lat: lat2,
        lng: lon2,
        distanceM: dist,
        source: base,
      };
    } catch (e) {
      clearTimeout(t);
      console.warn('[snap] OSRM attempt failed:', base, e.message || e);
    }
  }

  const v = await snapValhallaLocate(lat, lng);
  if (v) {
    console.log('[snap] using Valhalla fallback');
    return v;
  }
  return null;
}

/** @type {{ lat: number, lng: number, timestamp: string }[]} */
let locationHistory = [];

/** @type {{ lat: number|null, lng: number|null, timestamp: string|null, lastUpdated: string|null, pollStale: boolean, lastError: string|null }} */
let state = {
  lat: null,
  lng: null,
  timestamp: null,
  lastUpdated: null,
  pollStale: true,
  lastError: null,
};

function cookieHeader() {
  const id = process.env.JSESSIONID;
  if (!id) return '';
  return `JSESSIONID=${id.trim()}`;
}

function baseHeaders() {
  return {
    Cookie: cookieHeader(),
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: BASE,
    Referer: `${BASE}/`,
    'X-Requested-With': 'XMLHttpRequest',
  };
}

function getHeader(res, name) {
  const v = res.headers.get(name);
  if (v != null) return v;
  const lower = name.toLowerCase();
  for (const [k, val] of res.headers.entries()) {
    if (k.toLowerCase() === lower) return val;
  }
  return null;
}

function findCsrfInHeaders(res) {
  let found = getHeader(res, '_csrf');
  if (found) return found;
  for (const [k, val] of res.headers.entries()) {
    if (k.toLowerCase().includes('csrf')) return val;
  }
  return null;
}

function parseStfDate(datestr) {
  if (!datestr || typeof datestr !== 'string' || datestr.length < 14) return null;
  const y = datestr.slice(0, 4);
  const m = datestr.slice(4, 6);
  const d = datestr.slice(6, 8);
  const h = datestr.slice(8, 10);
  const min = datestr.slice(10, 12);
  const s = datestr.slice(12, 14);
  const iso = `${y}-${m}-${d}T${h}:${min}:${s}Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * @returns {{ lat: number, lng: number, timestamp: string } | null}
 */
function parseOpLocation(op) {
  if (!op || !['LOCATION', 'LASTLOC', 'OFFLINE_LOC'].includes(op.oprnType)) return null;
  if (op.encLocation && op.encLocation.encrypted) return null;

  let lat = null;
  let lng = null;
  let utcStr = null;

  if ('latitude' in op && op.latitude != null) {
    lat = parseFloat(op.latitude);
    lng = parseFloat(op.longitude);
    if (op.extra && op.extra.gpsUtcDt) utcStr = op.extra.gpsUtcDt;
  } else if (op.encLocation && typeof op.encLocation === 'object' && !op.encLocation.encrypted) {
    const loc = op.encLocation;
    if (loc.latitude != null) {
      lat = parseFloat(loc.latitude);
      lng = parseFloat(loc.longitude);
      utcStr = loc.gpsUtcDt;
    }
  }

  if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

  const utcDate = utcStr ? parseStfDate(utcStr) : null;
  if (!utcDate) return null;

  return { lat, lng, timestamp: utcDate };
}

/**
 * Collect every location point Samsung returned in this response (often multiple past fixes).
 */
function extractAllLocationsFromOps(ops) {
  const list = [];
  if (!ops || !ops.length) return list;
  for (const op of ops) {
    const p = parseOpLocation(op);
    if (p) list.push(p);
  }
  return dedupeHistoryPoints(list);
}

function dedupeHistoryPoints(points) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const key = `${p.timestamp}|${p.lat.toFixed(6)}|${p.lng.toFixed(6)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  out.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return out;
}

function mergeHistoryPoints(newPoints) {
  if (!newPoints || !newPoints.length) return;
  locationHistory = dedupeHistoryPoints([...locationHistory, ...newPoints]);
  locationHistory = locationHistory.slice(0, HISTORY_MAX);
}

/**
 * Latest LOCATION / LASTLOC / OFFLINE_LOC from Samsung.
 * @returns {{ lat: number, lng: number, timestamp: string } | null}
 */
function extractBestLocation(ops) {
  if (!ops || !ops.length) return null;

  let best = null;
  let bestDate = null;

  for (const op of ops) {
    const p = parseOpLocation(op);
    if (!p) continue;
    const t = Date.parse(p.timestamp);
    if (!bestDate || t > Date.parse(bestDate)) {
      bestDate = p.timestamp;
      best = p;
    }
  }

  return best;
}

/** Last resort if operation types differ from expected */
function deepFindLatLng(obj, depth = 0) {
  if (depth > 18 || obj == null || typeof obj !== 'object') return null;
  const la = parseFloat(obj.latitude ?? obj.lat);
  const lo = parseFloat(obj.longitude ?? obj.lng);
  if (
    Number.isFinite(la) &&
    Number.isFinite(lo) &&
    Math.abs(la) <= 90 &&
    Math.abs(lo) <= 180
  ) {
    const ts = obj.extra?.gpsUtcDt ?? obj.gpsUtcDt;
    return {
      lat: la,
      lng: lo,
      timestamp: ts ? parseStfDate(ts) || new Date().toISOString() : new Date().toISOString(),
    };
  }
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const r = deepFindLatLng(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const k of Object.keys(obj)) {
    const r = deepFindLatLng(obj[k], depth + 1);
    if (r) return r;
  }
  return null;
}

function pickDevice(deviceList) {
  const list = deviceList || [];
  if (list.length === 0) return null;

  const byId = process.env.DEVICE_ID?.trim();
  if (byId) {
    const found = list.find((d) => String(d.dvceID) === byId || String(d.dvceId) === byId);
    if (found) return found;
  }

  const tagName = (process.env.TAG_NAME || '').trim().toLowerCase();
  if (tagName) {
    const match = list.find(
      (d) => d.modelName && String(d.modelName).toLowerCase().includes(tagName)
    );
    if (match) return match;
  }

  const tag = list.find((d) => d.deviceTypeCode === 'TAG');
  if (tag) return tag;

  return list[0];
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...baseHeaders(), ...options.headers },
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text };
  }
  return { res, status: res.status, ok: res.ok, json, text };
}

async function getCsrfToken() {
  const { res, status, json, text } = await fetchJson(URL_CSRF, { method: 'GET' });
  let csrf = findCsrfInHeaders(res);
  if (!csrf && json && typeof json === 'object' && json._csrf) {
    csrf = json._csrf.token || json._csrf;
  }
  if (typeof csrf === 'object' && csrf?.token) csrf = csrf.token;

  if (!csrf || typeof csrf !== 'string') {
    console.error('[poll] chkLogin.do failed:', status, text?.slice?.(0, 500));
    if (status === 200) {
      console.error('[poll] response headers (csrf hunt):');
      res.headers.forEach((val, key) => console.error(' ', key + ':', val.slice?.(0, 80)));
    }
    throw new Error('Could not get CSRF token (session expired or invalid JSESSIONID?)');
  }
  return csrf;
}

async function getDeviceList(csrf) {
  const q = encodeURIComponent(csrf);
  const { status, json } = await fetchJson(`${URL_DEVICE_LIST}?_csrf=${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  console.log('[poll] getDeviceList.do status=', status);
  console.log('[poll] getDeviceList full response:', JSON.stringify(json, null, 2));

  if (status === 404 || status === 401) {
    throw new Error(`Device list failed (${status}) — refresh JSESSIONID`);
  }
  if (!json || !Array.isArray(json.deviceList)) {
    return [];
  }
  return json.deviceList;
}

async function fetchLocationFromStf(csrf, device) {
  const dvceId = device.dvceID ?? device.dvceId;
  const usrId = device.usrId;
  if (!dvceId || usrId == null) {
    throw new Error('Device missing dvceID or usrId');
  }

  const q = encodeURIComponent(csrf);

  const updatePayload = {
    dvceId,
    operation: 'CHECK_CONNECTION_WITH_LOCATION',
    usrId,
  };

  const addRes = await fetchJson(`${URL_ADD_OP}?_csrf=${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updatePayload),
  });
  console.log('[poll] addOperation.do status=', addRes.status);
  console.log('[poll] addOperation response:', JSON.stringify(addRes.json, null, 2));

  const setPayload = {
    dvceId,
    removeDevice: [],
  };

  const locRes = await fetchJson(`${URL_SET_LAST}?_csrf=${q}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(setPayload),
  });
  console.log('[poll] setLastSelect.do status=', locRes.status);
  console.log('[poll] setLastSelect full response:', JSON.stringify(locRes.json, null, 2));

  const text = locRes.text || '';
  if (text === 'Logout' || locRes.status === 401) {
    throw new Error('Session invalid (Logout) — refresh JSESSIONID');
  }

  if (locRes.status !== 200 || !locRes.json || typeof locRes.json !== 'object') {
    return { location: null, ops: [] };
  }

  const data = locRes.json;
  const ops = data.operation || [];
  const allLocations = extractAllLocationsFromOps(ops);
  let loc = extractBestLocation(ops);
  if (!loc) {
    loc = deepFindLatLng(data);
    if (loc) console.log('[poll] used deep coordinate fallback');
  }

  return { location: loc, ops, allLocations };
}

async function runPollOnce() {
  const started = new Date().toISOString();
  console.log(`[poll ${started}] starting Samsung SmartThings Find poll`);

  if (!process.env.JSESSIONID?.trim()) {
    console.error('[poll] JSESSIONID is not set in .env');
    state = { ...state, pollStale: true, lastError: 'JSESSIONID missing in .env' };
    return;
  }

  try {
    const csrf = await getCsrfToken();
    const devices = await getDeviceList(csrf);
    if (devices.length === 0) {
      state = { ...state, pollStale: true, lastError: 'No devices in account' };
      console.warn('[poll] no devices returned');
      return;
    }

    const device = pickDevice(devices);
    if (!device) {
      state = { ...state, pollStale: true, lastError: 'Could not pick a device' };
      return;
    }

    console.log(
      `[poll] using device: ${device.modelName || '?'} (${device.dvceID || device.dvceId}) type=${device.deviceTypeCode}`
    );

    const { location, allLocations } = await fetchLocationFromStf(csrf, device);

    if (location && location.lat != null && location.lng != null) {
      // Show when Samsung last reported this fix (gpsUtcDt), not when we polled
      const locationTime = location.timestamp || new Date().toISOString();
      // Raw Samsung coords — map snaps to road in the browser via /api/snap (more reliable than only snapping here).
      state = {
        lat: location.lat,
        lng: location.lng,
        timestamp: locationTime,
        lastUpdated: locationTime,
        pollStale: false,
        lastError: null,
      };
      const toHist = allLocations.length > 0 ? allLocations : [{ lat: location.lat, lng: location.lng, timestamp: locationTime }];
      mergeHistoryPoints(toHist);
      console.log(
        `[poll ${started}] OK → lat=${state.lat} lng=${state.lng} locationTime=${state.lastUpdated} historyPts=${allLocations.length || 1}`
      );
    } else {
      state = { ...state, pollStale: true, lastError: 'No coordinates in API response (offline or encrypted?)' };
      console.warn(`[poll ${started}] no coordinates in operation list`);
    }
  } catch (err) {
    state = { ...state, pollStale: true, lastError: String(err.message || err) };
    console.error(`[poll ${started}] error:`, err.message || err);
  }
}

let pollChain = Promise.resolve();
function pollOnce() {
  const next = pollChain.then(() => runPollOnce());
  pollChain = next.catch(() => {});
  return next;
}

function getLocationPayload() {
  const hasCoords = state.lat != null && state.lng != null;
  const stale = state.pollStale || !hasCoords;
  return {
    lat: state.lat,
    lng: state.lng,
    timestamp: state.timestamp,
    lastUpdated: state.lastUpdated,
    stale,
    tagName: process.env.TAG_NAME || 'bobo',
    error: state.lastError,
  };
}

const app = express();

/** @type {Set<import('http').ServerResponse>} */
const sseViewerClients = new Set();

function sseWrite(res, payload) {
  res.write(payload);
  if (typeof res.flush === 'function') res.flush();
  else if (res.socket) res.socket.flush?.();
}

function broadcastViewerCount() {
  const data = `data: ${JSON.stringify({ count: sseViewerClients.size })}\n\n`;
  for (const client of sseViewerClients) {
    sseWrite(client, data);
  }
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/snap', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: 'Invalid lat or lng' });
  }
  if (!SNAP_TO_ROAD) {
    return res.json({ ok: false, lat, lng, snapped: false, reason: 'disabled' });
  }
  try {
    const snapped = await snapToRoad(lat, lng);
    if (snapped) {
      return res.json({
        ok: true,
        lat: snapped.lat,
        lng: snapped.lng,
        distanceM: snapped.distanceM,
        source: snapped.source,
        snapped: true,
      });
    }
  } catch (e) {
    console.error('[api/snap]', e);
  }
  return res.json({ ok: false, lat, lng, snapped: false });
});

/** Orlando center — matches client map ETA destination. */
const PROJECTION_DEST_LAT = 28.5383;
const PROJECTION_DEST_LNG = -81.3792;

/** Default: 6028 Broad Oak Dr, Davenport, FL (overridable via env). */
const PROJECTION_ORIGIN_ADDRESS =
  process.env.PROJECTION_ORIGIN_ADDRESS || '6028 Broad Oak Dr, Davenport, FL';

/** When Nominatim has no exact building, use Davenport, FL centroid. */
const PROJECTION_ORIGIN_FALLBACK = { lat: 28.1614046, lng: -81.6017417 };

/** Optional fixed origin (skips geocoding). Set both from Google Maps if OSM has no house number. */
const PROJECTION_ORIGIN_LAT_ENV = process.env.PROJECTION_ORIGIN_LAT;
const PROJECTION_ORIGIN_LNG_ENV = process.env.PROJECTION_ORIGIN_LNG;

/** @type {{ lat: number, lng: number, displayName: string, source: string } | null} */
let projectionOriginResolved = null;

/**
 * Geocode departure point for the projected “driving to Orlando” map (cached).
 * Tries full address first, then street + city.
 */
async function resolveProjectionOrigin() {
  if (projectionOriginResolved) return projectionOriginResolved;

  if (PROJECTION_ORIGIN_LAT_ENV != null && PROJECTION_ORIGIN_LNG_ENV != null) {
    const lat = parseFloat(PROJECTION_ORIGIN_LAT_ENV);
    const lng = parseFloat(PROJECTION_ORIGIN_LNG_ENV);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      projectionOriginResolved = {
        lat,
        lng,
        displayName: PROJECTION_ORIGIN_ADDRESS + ' (from env)',
        source: 'env',
      };
      console.log('[projection-origin] using PROJECTION_ORIGIN_LAT/LNG');
      return projectionOriginResolved;
    }
  }

  const queries = [
    `${PROJECTION_ORIGIN_ADDRESS}, United States`,
    'Broad Oak Dr, Davenport, FL, United States',
  ];

  for (const query of queries) {
    const q = encodeURIComponent(query);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'smarttag2/1.0 (where-is-bobo projection)',
        },
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data[0] && data[0].lat != null && data[0].lon != null) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          projectionOriginResolved = {
            lat,
            lng: lon,
            displayName: data[0].display_name || query,
            source: 'nominatim',
          };
          console.log('[projection-origin]', projectionOriginResolved.source, projectionOriginResolved.displayName);
          return projectionOriginResolved;
        }
      }
    } catch (e) {
      clearTimeout(t);
      console.warn('[projection-origin] geocode attempt failed:', e.message || e);
    }
  }

  projectionOriginResolved = {
    lat: PROJECTION_ORIGIN_FALLBACK.lat,
    lng: PROJECTION_ORIGIN_FALLBACK.lng,
    displayName: `${PROJECTION_ORIGIN_ADDRESS} (approximate — OSM had no exact match)`,
    source: 'fallback',
  };
  console.warn('[projection-origin] using fallback coordinates for Davenport, FL');
  return projectionOriginResolved;
}

app.get('/api/projection-origin', async (req, res) => {
  try {
    const o = await resolveProjectionOrigin();
    res.json({
      ok: true,
      lat: o.lat,
      lng: o.lng,
      displayName: o.displayName,
      source: o.source,
      destLat: PROJECTION_DEST_LAT,
      destLng: PROJECTION_DEST_LNG,
      destName: 'Orlando, FL',
    });
  } catch (err) {
    console.error('[api/projection-origin]', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get('/api/viewers', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (res.socket) res.socket.setNoDelay(true);
  res.flushHeaders();

  sseViewerClients.add(res);
  broadcastViewerCount();

  const heartbeat = setInterval(() => sseWrite(res, ': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseViewerClients.delete(res);
    broadcastViewerCount();
  });
});

app.get('/api/location', (req, res) => {
  res.json(getLocationPayload());
});

app.post('/api/refresh', async (req, res) => {
  try {
    await pollOnce();
    res.json(getLocationPayload());
  } catch (err) {
    console.error('[refresh]', err);
    res.status(500).json({ ...getLocationPayload(), refreshError: String(err.message || err) });
  }
});

app.get('/api/history', (req, res) => {
  res.json({ points: locationHistory, max: HISTORY_MAX });
});

app.post('/api/history/refresh', async (req, res) => {
  try {
    await pollOnce();
    res.json({ points: locationHistory, max: HISTORY_MAX });
  } catch (err) {
    console.error('[history/refresh]', err);
    res.status(500).json({ points: locationHistory, max: HISTORY_MAX, error: String(err.message || err) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

pollOnce();
setInterval(pollOnce, POLL_MS);

const server = app.listen(PORT, () => {
  console.log(`Where is bobo? listening on http://localhost:${PORT}`);
  console.log(`Polling SmartThings Find every ${POLL_MS / 1000}s`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different PORT in .env or stop the other process.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
