// server/index.js — Main server entry point
const express  = require('express');
const http     = require('http');
const ws       = require('ws');
const path     = require('path');
const fs       = require('fs');
const multer   = require('multer');
const { v4: uuid } = require('uuid');

const adb     = require('./adb');
const db      = require('./db');
const queue   = require('./queue');
const metrics = require('./metrics');

const PORT      = process.env.PORT || 3000;
const UPLOADS   = path.join(__dirname, '../data/uploads');
fs.mkdirSync(UPLOADS, { recursive: true });

const app    = express();
const server = http.createServer(app);
const wss    = new ws.WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));
app.use('/screenshots', express.static(path.join(__dirname, '../data/screenshots')));
app.use('/reports',     express.static(path.join(__dirname, '../data/reports')));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.endsWith('.apk'));
  },
});

// ── WebSocket broadcast ───────────────────────────────────────────────────────

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === ws.OPEN) client.send(msg);
  }
}

wss.on('connection', (socket) => {
  // Send current state on connect
  socket.send(JSON.stringify({
    type: 'init',
    data: {
      devices: [...adb.devices.values()],
      jobs:    db.listJobs(20),
      stats:   db.getStats(),
      queue:   queue.status(),
      flashlightAvailable: metrics._flashlightAvailable,
    },
  }));
});

// Wire queue + adb events → WebSocket
adb.on('device:connect',    d  => broadcast('device:connect', d));
adb.on('device:disconnect', d  => broadcast('device:disconnect', d));
queue.on('job:queued',  e => broadcast('job:queued',  e));
queue.on('job:start',   e => broadcast('job:start',   e));
queue.on('job:log',     e => broadcast('job:log',     e));
queue.on('job:done',    e => { broadcast('job:done', e); broadcast('stats', db.getStats()); });
queue.on('job:cancelled', e => broadcast('job:cancelled', e));

// ── API: Devices ──────────────────────────────────────────────────────────────

// GET /api/devices — list all known + currently connected devices
app.get('/api/devices', (req, res) => {
  const known     = db.listDevices();
  const connected = new Set([...adb.devices.keys()]);
  const result = known.map(d => ({
    ...d,
    tags:      JSON.parse(d.tags || '[]'),
    connected: connected.has(d.serial),
    status:    queue._running.has(d.serial) ? 'busy' : (connected.has(d.serial) ? 'idle' : 'offline'),
    battery:   adb.devices.get(d.serial)?.battery ?? null,
  }));
  res.json(result);
});

// POST /api/devices/connect — connect a device over WiFi
app.post('/api/devices/connect', (req, res) => {
  const { ip, port = 5555 } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  const ok = adb.connectWifi(ip, port);
  res.json({ success: ok });
});

// POST /api/devices/pair — pair Android 11+ wireless debugging
app.post('/api/devices/pair', (req, res) => {
  const { ip, port, code } = req.body;
  if (!ip || !port || !code) return res.status(400).json({ error: 'ip, port, code required' });
  const ok = adb.pairWifi(ip, port, code);
  res.json({ success: ok });
});

// PUT /api/devices/:serial/tags
app.put('/api/devices/:serial/tags', (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be array' });
  db.setDeviceTags(req.params.serial, tags);
  res.json({ ok: true });
});

// GET /api/devices/:serial/screenshot
app.get('/api/devices/:serial/screenshot', (req, res) => {
  const { serial } = req.params;
  if (!adb.devices.has(serial)) return res.status(404).json({ error: 'device not connected' });
  const outPath = path.join(__dirname, '../data/screenshots', `live_${serial}.png`);
  adb.screenshot(serial, outPath);
  res.sendFile(outPath);
});

// GET /api/devices/:serial/packages
app.get('/api/devices/:serial/packages', (req, res) => {
  const { serial } = req.params;
  if (!adb.devices.has(serial)) return res.status(404).json({ error: 'device not connected' });
  res.json(adb.listPackages(serial));
});

// ── API: APKs ──────────────────────────────────────────────────────────────────

// POST /api/apks — upload an APK
app.post('/api/apks', upload.single('apk'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No APK file uploaded' });

  const apkPath = req.file.path;
  // Rename to keep .apk extension
  const finalPath = apkPath + '.apk';
  fs.renameSync(apkPath, finalPath);

  // Try to extract package name via aapt (optional)
  let packageName = null, versionCode = null, versionName = null;
  try {
    const { execSync } = require('child_process');
    const raw = execSync(`aapt dump badging "${finalPath}" 2>/dev/null | head -5`, { encoding: 'utf8' });
    packageName  = raw.match(/name='([^']+)'/)?.[1] ?? null;
    versionCode  = raw.match(/versionCode='([^']+)'/)?.[1] ?? null;
    versionName  = raw.match(/versionName='([^']+)'/)?.[1] ?? null;
  } catch { /* aapt not available */ }

  const record = db.addApk({
    filename:     req.file.originalname,
    size_bytes:   req.file.size,
    package_name: packageName || req.body.packageName || null,
    version_code: versionCode,
    version_name: versionName,
    path:         finalPath,
  });

  res.json({ id: record.lastInsertRowid, packageName, versionCode, versionName });
});

// GET /api/apks
app.get('/api/apks', (req, res) => res.json(db.listApks()));

// ── API: Jobs ──────────────────────────────────────────────────────────────────

// POST /api/jobs — submit a new job
app.post('/api/jobs', (req, res) => {
  const {
    deviceSerial,   // optional — auto-picks if omitted
    apkId,          // optional — APK from uploads
    apkPath,        // optional — direct path (for CI use)
    packageName,    // required
    activity,       // optional — for startup time measurement
    testCommand,    // optional — adb:, instrument:, or local:
    metadata,       // optional — { name, branch, commit }
  } = req.body;

  if (!packageName) return res.status(400).json({ error: 'packageName required' });

  let resolvedApkPath = apkPath || null;
  if (apkId) {
    const apk = db.getApk(apkId);
    if (!apk) return res.status(404).json({ error: 'APK not found' });
    resolvedApkPath = apk.path;
  }

  const jobId = queue.submit({
    deviceSerial,
    apkPath:     resolvedApkPath,
    packageName,
    activity,
    testCommand,
    metadata:    metadata || {},
  });

  res.status(202).json({ id: jobId });
});

// GET /api/jobs — list recent jobs
app.get('/api/jobs', (req, res) => {
  const limit  = parseInt(req.query.limit) || 50;
  const serial = req.query.device;
  const jobs   = serial ? db.listJobsByDevice(serial, limit) : db.listJobs(limit);
  res.json(jobs.map(j => ({ ...j, metadata: JSON.parse(j.metadata || '{}') })));
});

// GET /api/jobs/:id — job detail
app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'not found' });
  const results = db.getResults(job.id).map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
  }));
  res.json({ ...job, metadata: JSON.parse(job.metadata || '{}'), results });
});

// DELETE /api/jobs/:id/cancel
app.delete('/api/jobs/:id/cancel', (req, res) => {
  const ok = queue.cancel(req.params.id);
  res.json({ cancelled: ok });
});

// ── API: Quick perf snapshot (no job) ─────────────────────────────────────────

// GET /api/perf/:serial/:package — live one-shot metrics
app.get('/api/perf/:serial/:package', async (req, res) => {
  const { serial, package: pkg } = req.params;
  if (!adb.devices.has(serial)) return res.status(404).json({ error: 'device not connected' });
  try {
    const snap = await metrics.snapshot(serial, pkg);
    res.json(snap);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Stats ─────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => res.json({ ...db.getStats(), queue: queue.status() }));

// ── Start ──────────────────────────────────────────────────────────────────────

adb.startPolling(3000);

server.listen(PORT, () => {
  console.log(`\n🚀 Device Farm running at http://localhost:${PORT}`);
  console.log(`📱 Flashlight: ${metrics._flashlightAvailable ? '✓ available' : '✗ not found (install with: npm i -g @perf-tools/flashlight)'}`);
  console.log(`\nConnected devices:`);
  const devs = adb.listConnected();
  if (devs.length === 0) console.log('  (none — plug in a device or run: node cli/index.js connect <ip>)');
  else devs.forEach(d => console.log(`  ${d.serial}  ${d.state}`));
  console.log();
});
