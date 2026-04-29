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