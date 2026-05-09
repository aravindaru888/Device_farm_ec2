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
const wss           = new ws.WebSocketServer({ noServer: true });
const wssTestRunner = new ws.WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/test-runner') {
    wssTestRunner.handleUpgrade(req, socket, head, client =>
      wssTestRunner.emit('connection', client, req)
    );
  } else {
    wss.handleUpgrade(req, socket, head, client =>
      wss.emit('connection', client, req)
    );
  }
});
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));
app.use('/screenshots', express.static(path.join(__dirname, '../data/screenshots')));
//app.use('/reports',     express.static(path.join(__dirname, '../data/reports')));

const upload = multer({
  dest: UPLOADS,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.originalname.endsWith('.apk'));
  },
});


// ── Helpers ──────────────────────────────────────────────────────────────────

// Filter out duplicate/mDNS devices
function isValidSerial(serial) {
  return serial && !serial.includes('_adb-tls-connect');
}

// Merge DB + ADB devices
function getMergedDevices() {
  const known = db.listDevices();
  const adbMap = adb.devices;

  const serials = new Set([
    ...known.map(d => d.serial),
    ...[...adbMap.keys()].filter(isValidSerial),
  ]);

  return [...serials].map(serial => {
    const dbDevice = known.find(d => d.serial === serial) || {};
    const adbDevice = adbMap.get(serial) || {};
    return {
      serial,
      model: dbDevice.model || adbDevice.model || 'Unknown',
      brand: dbDevice.brand || adbDevice.brand || 'Unknown',
      api: dbDevice.api || adbDevice.api || '?',
      os: dbDevice.os || adbDevice.os || '?',
      arch: dbDevice.arch || adbDevice.arch || '?',
      tags: JSON.parse(dbDevice.tags || '[]'),
      connected: adbMap.has(serial),
      status: queue._running.has(serial)
        ? 'busy'
        : (adbMap.has(serial) ? 'idle' : 'offline'),
      battery: adbDevice.battery ?? null,
    };
  });
}


// ── WebSocket broadcast ───────────────────────────────────────────────────────

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wss.clients) {
    if (client.readyState === ws.OPEN) client.send(msg);
  }
}

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'init',
    data: {
      devices: getMergedDevices(),
      jobs:    db.listJobs(20),
      stats:   db.getStats(),
      queue:   queue.status(),
      flashlightAvailable: metrics._flashlightAvailable,
    },
  }));
});


// ── ADB events ────────────────────────────────────────────────────────────────

adb.on('device:connect', d => {
  if (!isValidSerial(d.serial)) return;

  const exists = db.listDevices().find(dev => dev.serial === d.serial);
  if (!exists) {
    db.upsertDevice({
      serial: d.serial,
      model: d.model || 'Unknown',
      brand: d.brand || 'Unknown',
      api: d.api || '?',
      os: d.os || '?',
      arch: d.arch || '?',
    });
  }

  broadcast('device:connect', {
    serial: d.serial,
    battery: d.battery ?? null,
  });
});

adb.on('device:disconnect', d => {
  if (!isValidSerial(d.serial)) return;
  broadcast('device:disconnect', d);
});

queue.on('job:queued',  e => broadcast('job:queued',  e));
queue.on('job:start',   e => broadcast('job:start',   e));
queue.on('job:log',     e => broadcast('job:log',     e));
queue.on('job:done',    e => { broadcast('job:done', e); broadcast('stats', db.getStats()); });
queue.on('job:cancelled', e => broadcast('job:cancelled', e));


// ── API: Devices ──────────────────────────────────────────────────────────────

app.get('/api/devices', (req, res) => {
  res.json(getMergedDevices());
});

app.post('/api/devices/connect', (req, res) => {
  const { ip, port = 5555 } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });
  const ok = adb.connectWifi(ip, port);
  res.json({ success: ok });
});

app.post('/api/devices/pair', (req, res) => {
  const { ip, port, code } = req.body;
  if (!ip || !port || !code) return res.status(400).json({ error: 'ip, port, code required' });
  const ok = adb.pairWifi(ip, port, code);
  res.json({ success: ok });
});

app.put('/api/devices/:serial/tags', (req, res) => {
  const { tags } = req.body;
  if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be array' });
  db.setDeviceTags(req.params.serial, tags);
  res.json({ ok: true });
});

app.get('/api/devices/:serial/screenshot', (req, res) => {
  const { serial } = req.params;
  if (!adb.devices.has(serial)) return res.status(404).json({ error: 'device not connected' });
  const outPath = path.join(__dirname, '../data/screenshots', `live_${serial}.png`);
  adb.screenshot(serial, outPath);
  res.sendFile(outPath);
});

app.get('/api/devices/:serial/packages', (req, res) => {
  const { serial } = req.params;
  if (!adb.devices.has(serial)) return res.status(404).json({ error: 'device not connected' });
  res.json(adb.listPackages(serial));
});


// ── API: Stats ────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => res.json({ ...db.getStats(), queue: queue.status() }));


// ── Start ─────────────────────────────────────────────────────────────────────

const ALLOWED_TESTS = ['sample-test-fl.js', 'sample-test.js'];
const FARM_DIR      = path.join(__dirname, '..');   // ~/device-farm

// ── API: Deploy test file ─────────────────────────────────────────────────────
app.post('/api/deploy', express.json({ limit: '10mb' }), (req, res) => {
  const { filename, content } = req.body || {};

  if (!filename || !ALLOWED_TESTS.includes(filename))
    return res.status(400).json({ error: `Not allowed. Permitted: ${ALLOWED_TESTS.join(', ')}` });
  if (typeof content !== 'string')
    return res.status(400).json({ error: 'Missing content' });

  try {
    fs.writeFileSync(path.join(FARM_DIR, filename), content, 'utf8');
    console.log(`[deploy] Wrote ${filename}`);
    res.json({ ok: true, filename });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: List reports ─────────────────────────────────────────────────────────
app.get('/api/reports', (req, res) => {
  try {
    const reports = fs.readdirSync(FARM_DIR)
      .filter(f => f.startsWith('results_') && f.endsWith('.json'))
      .sort().reverse();
    res.json({ reports });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: Download a report ────────────────────────────────────────────────────
app.get('/api/reports/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!filename.startsWith('results_') || !filename.endsWith('.json'))
    return res.status(400).json({ error: 'Invalid filename' });

  const filePath = path.join(FARM_DIR, filename);
  if (!fs.existsSync(filePath))
    return res.status(404).json({ error: 'Not found' });

  res.download(filePath);
});

// ── API: Delete all reports ───────────────────────────────────────────────────
app.delete('/api/reports', (req, res) => {
  try {
    const files = fs.readdirSync(FARM_DIR)
      .filter(f => f.startsWith('results_') && f.endsWith('.json'));
    files.forEach(f => fs.unlinkSync(path.join(FARM_DIR, f)));
    console.log(`[reports] Deleted ${files.length} report(s)`);
    res.json({ ok: true, deleted: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket: /test-runner ───────────────────────────────────────────────────
// client → { run: 'sample-test-fl.js' }
// server → { type: 'log',   line: '...' }
// server → { type: 'done',  exitCode: 0 }
// server → { type: 'error', message: '...' }
const { exec } = require('child_process');

wssTestRunner.on('connection', (socket) => {
  console.log('[test-runner] Client connected');

  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send({ type: 'error', message: 'Invalid JSON' }); }

    const testFile = msg.run;
    if (!testFile || !ALLOWED_TESTS.includes(testFile))
      return send({ type: 'error', message: `Not allowed: ${testFile}` });

    const filePath = path.join(FARM_DIR, testFile);
    if (!fs.existsSync(filePath))
      return send({ type: 'error', message: `File not found: ${testFile}` });

    console.log(`[test-runner] Starting: node ${testFile}`);

    function send(obj) {
      if (socket.readyState === ws.OPEN)
        socket.send(JSON.stringify(obj));
    }

    const proc = exec(`node ${testFile}`, { cwd: FARM_DIR });

    proc.stdout.on('data', data =>
      data.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'log', line }))
    );
    proc.stderr.on('data', data =>
      data.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'log', line }))
    );
    proc.on('close', exitCode => {
      console.log(`[test-runner] Done. Exit: ${exitCode}`);
      send({ type: 'done', exitCode });
      socket.close(1000);
    });
    proc.on('error', e => {
      console.error('[test-runner] Error:', e.message);
      send({ type: 'error', message: e.message });
      socket.close(1000);
    });
  });

  socket.on('close', () => console.log('[test-runner] Client disconnected'));
});

adb.startPolling(3000);

server.listen(PORT, () => {
  console.log(`\n🚀 Device Farm running at http://localhost:${PORT}`);
  console.log(`📱 Flashlight: ${metrics._flashlightAvailable ? '✓ available' : '✗ not found'}`);

  console.log(`\nConnected devices:`);
  const devs = adb.listConnected();
  if (devs.length === 0) console.log('  (none)');
  else devs.forEach(d => console.log(`  ${d.serial}  ${d.state}`));
  console.log();
});