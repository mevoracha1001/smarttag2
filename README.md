# Where is bobo? (SmartTag viewer)

A minimal full-stack viewer for your Samsung SmartTag 2 last known location. The backend talks to the **same** SmartThings Find web APIs as [smartthingsfind.samsung.com](https://smartthingsfind.samsung.com) (CSRF + device list + location operations), using **your** `JSESSIONID` cookie. It does **not** use `api.smartthings.com/v1/find/...` (those URLs are not valid for this flow).

## How to get `JSESSIONID`

1. Open [https://smartthingsfind.samsung.com](https://smartthingsfind.samsung.com) in Chrome or Edge.
2. Sign in with your Samsung account.
3. Open **Developer Tools** (F12 or right-click → Inspect).
4. Go to the **Application** tab (Chrome) or **Storage** (Firefox).
5. Under **Cookies**, select `https://smartthingsfind.samsung.com`.
6. Find the cookie named **`JSESSIONID`** and copy its **Value** only.

Paste that value into your `.env` file as `JSESSIONID=...`.

**Security:** This cookie is effectively a session key to your Find account. Do not commit `.env` or share the value publicly.

## Install and run

```bash
npm install
node server.js
```

Or:

```bash
npm start
```

Create a `.env` file in the project root (you can copy `.env.example`):

```env
JSESSIONID=your_cookie_here
TAG_NAME=My SmartTag 2
# Optional: lock to one Samsung Find device by id (see server log after "using device:")
# DEVICE_ID=abc123
PORT=3000
```

- **`TAG_NAME`**: Display name on the map; also used to **pick** a device when you have several — it matches a substring of Samsung’s device name (`modelName`) from the device list. If unset or no match, the first **SmartTag** (`TAG`) is used, otherwise the first device.
- **`DEVICE_ID`**: Set this to the device’s `dvceID` (printed in the server log) to force a specific tag.

Then open `http://localhost:3000` (or the port you set).

## Session expiry

Samsung session cookies expire after some time. When polls start failing or the map goes stale, log in to SmartThings Find again, copy a fresh `JSESSIONID`, update `.env`, and restart the server.

## Deploy (Railway or Render)

1. Push this folder to a Git repository (optional but typical).
2. Create a new **Web Service** and connect the repo, or deploy from the dashboard with **Root directory** set to this project.
3. **Build command:** `npm install` (or leave default).
4. **Start command:** `node server.js` or `npm start`.
5. Set **environment variables** in the dashboard:
   - `JSESSIONID` — your cookie value
   - `TAG_NAME` — optional label / device picker hint
   - `DEVICE_ID` — optional, force a specific `dvceID`
   - `PORT` — usually set automatically by the platform; use the port they inject if required (often `PORT` is already provided).

Redeploy after you refresh the cookie.

## API

- `GET /api/location` — JSON: `lat`, `lng`, `timestamp`, `lastUpdated`, `stale`, `tagName`, and `error` (when the last poll failed, e.g. expired session).

The server polls every **2 minutes** and logs full API responses to the console (`chkLogin`, `getDeviceList`, `addOperation`, `setLastSelect`) so you can inspect payloads if something looks wrong.

## Legal / terms

Use only with devices you own and in line with Samsung’s terms of service. This tool is unofficial and not affiliated with Samsung.
