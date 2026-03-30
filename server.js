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
 * Port of HA SmartThings Find location extraction (latest LOCATION / LASTLOC / OFFLINE_LOC).
 * @returns {{ lat: number, lng: number, timestamp: string } | null}
 */
function extractBestLocation(ops) {
  if (!ops || !ops.length) return null;

  let best = null;
  let bestDate = null;

  for (const op of ops) {
    if (!['LOCATION', 'LASTLOC', 'OFFLINE_LOC'].includes(op.oprnType)) continue;

    if (op.encLocation && op.encLocation.encrypted) continue;

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

    if (lat == null || lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;

    const utcDate = utcStr ? parseStfDate(utcStr) : null;
    if (!utcDate) continue;

    const t = Date.parse(utcDate);
    if (!bestDate || t > Date.parse(bestDate)) {
      bestDate = utcDate;
      best = { lat, lng, timestamp: utcDate };
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
  let loc = extractBestLocation(ops);
  if (!loc) {
    loc = deepFindLatLng(data);
    if (loc) console.log('[poll] used deep coordinate fallback');
  }

  return { location: loc, ops };
}

async function pollOnce() {
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

    const { location } = await fetchLocationFromStf(csrf, device);

    if (location && location.lat != null && location.lng != null) {
      // Show when Samsung last reported this fix (gpsUtcDt), not when we polled
      const locationTime = location.timestamp || new Date().toISOString();
      state = {
        lat: location.lat,
        lng: location.lng,
        timestamp: locationTime,
        lastUpdated: locationTime,
        pollStale: false,
        lastError: null,
      };
      console.log(`[poll ${started}] OK → lat=${state.lat} lng=${state.lng} locationTime=${state.lastUpdated}`);
    } else {
      state = { ...state, pollStale: true, lastError: 'No coordinates in API response (offline or encrypted?)' };
      console.warn(`[poll ${started}] no coordinates in operation list`);
    }
  } catch (err) {
    state = { ...state, pollStale: true, lastError: String(err.message || err) };
    console.error(`[poll ${started}] error:`, err.message || err);
  }
}

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/location', (req, res) => {
  const hasCoords = state.lat != null && state.lng != null;
  const stale = state.pollStale || !hasCoords;

  res.json({
    lat: state.lat,
    lng: state.lng,
    timestamp: state.timestamp,
    lastUpdated: state.lastUpdated,
    stale,
    tagName: process.env.TAG_NAME || 'bobo',
    error: state.lastError,
  });
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
