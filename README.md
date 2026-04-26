# Device Farm

A self-hosted Android device farm for performance testing with Flashlight support. Run your own real devices, collect full low-level metrics, and get beautiful reports — no BrowserStack or AWS required.

## Why this exists

| | BrowserStack | AWS Device Farm | This |
|---|---|---|---|
| Flashlight (low-level metrics) | ✗ | ✗ | ✓ |
| Your own physical device | ✗ (USB blocked) | ✗ | ✓ |
| Cost | $$$ | $$$ | Free |
| gfxinfo / framestats | ✗ | Partial | ✓ |
| Startup time measurement | ✗ | ✗ | ✓ |

---

## Quick start

```bash
# 1. Clone and set up
git clone <this repo>
cd device-farm
bash scripts/setup.sh

# 2. Plug in your device (USB debugging enabled)
adb devices   # verify it shows up

# 3. Start the server
npm start

# 4. Open the dashboard
open http://localhost:3000

# 5. Run your first perf test
farm run -p com.myapp
```

---

## Device connection

### USB (simplest)
1. Settings → About Phone → tap **Build Number** 7×
2. Settings → Developer Options → **USB Debugging** on
3. Plug in — `adb devices` should show your serial

### WiFi (Android 11+, no USB needed)
1. Settings → Developer Options → **Wireless Debugging** → **Pair device with code**
2. Note the IP, pairing port, and 6-digit code shown
3. `farm pair 192.168.1.x 37441 123456`
4. After pairing: `farm connect 192.168.1.x`

### Multiple devices
Plug in as many devices as you want — the farm auto-discovers all of them and runs jobs concurrently, one job per device.

---

## Flashlight integration

Flashlight gives you deeper metrics than plain `dumpsys` — including accurate CPU threads, GPU rendering time, and a score-based perf report.

```bash
npm install -g @perf-tools/flashlight
```

Once installed the server detects it automatically. Jobs will include a Flashlight report alongside the native metrics.

---

## CLI reference

```bash
# List connected devices
farm devices

# Connect a WiFi device
farm connect 192.168.1.42
farm pair 192.168.1.42 37441 123456   # Android 11+ pairing

# Upload an APK
farm upload myapp.apk

# Run a job (various test command formats)
farm run -p com.myapp                                         # metrics only
farm run -p com.myapp --activity .MainActivity               # + startup time
farm run -p com.myapp -a myapp.apk                          # install + measure
farm run -p com.myapp -c 'local:maestro test flow.yaml'     # Maestro test
farm run -p com.myapp -c 'instrument:com.myapp.test/runner' # instrumented test
farm run -p com.myapp -c 'adb:am start com.myapp/.Main'     # raw adb command
farm run -p com.myapp -d SERIALXXX                          # specific device
farm run -p com.myapp --name "PR #42" --branch main --commit abc123

# View results
farm jobs
farm result <jobId>

# Live one-shot snapshot (no job)
farm perf SERIALXXX com.myapp
```

---

## REST API

### Devices
```
GET  /api/devices                    list all known devices + connection status
POST /api/devices/connect            { ip, port } — connect WiFi device
POST /api/devices/pair               { ip, port, code } — pair Android 11+
GET  /api/devices/:serial/screenshot live screenshot
GET  /api/devices/:serial/packages   installed packages
PUT  /api/devices/:serial/tags       { tags: ["pixel", "prod"] }
```

### Jobs
```
POST /api/jobs                       submit job
GET  /api/jobs?limit=50&device=xxx   list jobs
GET  /api/jobs/:id                   job detail + results
DELETE /api/jobs/:id/cancel          cancel queued job
```

### APKs
```
POST /api/apks    upload APK (multipart/form-data, field: apk)
GET  /api/apks    list uploaded APKs
```

### Perf
```
GET /api/perf/:serial/:package    one-shot metric snapshot
GET /api/stats                    farm-wide stats + queue status
```

### CI/CD example (GitHub Actions)

```yaml
- name: Start device farm
  run: npm start &
  
- name: Run perf test
  run: |
    farm run \
      -p com.myapp \
      -a app-release.apk \
      --activity .MainActivity \
      -c 'local:maestro test flows/smoke.yaml' \
      --name "CI build $GITHUB_RUN_NUMBER" \
      --branch "$GITHUB_REF_NAME" \
      --commit "$GITHUB_SHA"
```

---

## Metrics collected

### Native (always available)
- **FPS** — average frames per second from `gfxinfo framestats`
- **Jank rate** — % of frames over 16.67 ms
- **Frame percentiles** — P50, P90, P95, P99 frame render time
- **CPU** — per-process CPU % from `dumpsys cpuinfo`
- **Memory** — PSS from `dumpsys meminfo`

### Startup time
- **Cold start** — force-stop + cache drop + launch → TotalTime
- **Warm start** — force-stop + launch (page cache warm)

### Flashlight (when installed)
- GPU render time breakdown
- Accurate thread-level CPU
- Scroll smoothness score
- Full HTML report

---

## Architecture

```
Test runner (CI / Maestro / custom)
        ↓  REST API
Orchestration server (Node.js / Express + WebSocket)
        ↓  device lock per serial
ADB bridge (adb -s <serial> shell …)
        ↓
Physical device (USB or WiFi ADB)
        ↓
Flashlight agent  →  JSON report
        ↓
SQLite (jobs, results, device history)
        ↓
Web dashboard (http://localhost:3000)
```

### File layout
```
device-farm/
  server/
    index.js      Express + WebSocket server
    adb.js        ADB manager — device discovery, install, metrics
    metrics.js    Framestats parser, native sampling, Flashlight bridge
    queue.js      Job scheduler + executor
    db.js         SQLite persistence
  dashboard/
    index.html    Web dashboard
  cli/
    index.js      CLI tool
  scripts/
    setup.sh      One-command setup
  data/           Created at runtime
    farm.db       SQLite database
    uploads/      Uploaded APKs
    screenshots/  Before/after screenshots per job
    reports/      Flashlight JSON reports
```

---

## Extending

### Custom test runner

The `testCommand` field accepts any shell command via `local:` prefix. The device serial is available as `$DEVICE_SERIAL`:

```bash
farm run -p com.myapp -c 'local:appium --config appium.config.js --serial $DEVICE_SERIAL'
```

### Adding more metrics

Edit `server/metrics.js` → `snapshot()` to add any `adb shell dumpsys` output. Results are stored as JSON blobs in the `results` table — the dashboard and CLI render whatever keys you add.

### Webhook on job completion

Add to `server/queue.js` in the `_execute` finally block:
```js
await fetch(process.env.WEBHOOK_URL, {
  method: 'POST',
  body: JSON.stringify({ jobId, status, metrics: nativeReport }),
});
```
