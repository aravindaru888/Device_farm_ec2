// server/db.js — SQLite persistence (jobs, results, device history)
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '../data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'farm.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS devices (
    serial       TEXT PRIMARY KEY,
    model        TEXT,
    brand        TEXT,
    api          TEXT,
    os           TEXT,
    arch         TEXT,
    first_seen   TEXT DEFAULT (datetime('now')),
    last_seen    TEXT DEFAULT (datetime('now')),
    tags         TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id           TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'queued',
    -- queued | running | passed | failed | cancelled
    device_serial TEXT,
    apk_path     TEXT,
    package_name TEXT,
    activity     TEXT,
    test_command TEXT,
    created_at   TEXT DEFAULT (datetime('now')),
    started_at   TEXT,
    finished_at  TEXT,
    error        TEXT,
    metadata     TEXT DEFAULT '{}'
    -- JSON blob: { name, branch, commit, env, ... }
  );

  CREATE TABLE IF NOT EXISTS results (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    metric_type  TEXT NOT NULL,
    -- native | flashlight | startup | logcat | screenshot
    payload      TEXT NOT NULL,
    -- JSON blob with all metric data
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS apks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    filename     TEXT NOT NULL,
    size_bytes   INTEGER,
    package_name TEXT,
    version_code TEXT,
    version_name TEXT,
    uploaded_at  TEXT DEFAULT (datetime('now')),
    path         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_jobs_status   ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_device   ON jobs(device_serial);
  CREATE INDEX IF NOT EXISTS idx_results_job   ON results(job_id);
`);

// ── Device helpers ────────────────────────────────────────────────────────────

const upsertDevice = db.prepare(`
  INSERT INTO devices (serial, model, brand, api, os, arch, last_seen)
  VALUES (@serial, @model, @brand, @api, @os, @arch, datetime('now'))
  ON CONFLICT(serial) DO UPDATE SET
    model     = excluded.model,
    brand     = excluded.brand,
    api       = excluded.api,
    os        = excluded.os,
    arch      = excluded.arch,
    last_seen = excluded.last_seen
`);

const getDevice    = db.prepare('SELECT * FROM devices WHERE serial = ?');
const listDevices  = db.prepare('SELECT * FROM devices ORDER BY last_seen DESC');

const setDeviceTags = db.prepare(
  'UPDATE devices SET tags = ? WHERE serial = ?'
);

// ── Job helpers ────────────────────────────────────────────────────────────────

const createJob = db.prepare(`
  INSERT INTO jobs (id, status, device_serial, apk_path, package_name, activity, test_command, metadata)
  VALUES (@id, 'queued', @device_serial, @apk_path, @package_name, @activity, @test_command, @metadata)
`);

const getJob        = db.prepare('SELECT * FROM jobs WHERE id = ?');
const listJobs      = db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?');
const listJobsByDevice = db.prepare(
  'SELECT * FROM jobs WHERE device_serial = ? ORDER BY created_at DESC LIMIT ?'
);

const updateJobStatus = db.prepare(`
  UPDATE jobs
  SET status = @status,
      started_at  = CASE WHEN @status = 'running'  THEN datetime('now') ELSE started_at  END,
      finished_at = CASE WHEN @status IN ('passed','failed','cancelled') THEN datetime('now') ELSE finished_at END,
      error = @error
  WHERE id = @id
`);

// ── Result helpers ──────────────────────────────────────────────────────────────

const addResult = db.prepare(`
  INSERT INTO results (job_id, metric_type, payload)
  VALUES (@job_id, @metric_type, @payload)
`);

const getResults = db.prepare('SELECT * FROM results WHERE job_id = ?');

// ── APK helpers ──────────────────────────────────────────────────────────────────

const addApk = db.prepare(`
  INSERT INTO apks (filename, size_bytes, package_name, version_code, version_name, path)
  VALUES (@filename, @size_bytes, @package_name, @version_code, @version_name, @path)
`);
const listApks = db.prepare('SELECT * FROM apks ORDER BY uploaded_at DESC');
const getApk   = db.prepare('SELECT * FROM apks WHERE id = ?');

// ── Stats query ───────────────────────────────────────────────────────────────

const getStats = () => db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM jobs)                     AS total_jobs,
    (SELECT COUNT(*) FROM jobs WHERE status='passed') AS passed,
    (SELECT COUNT(*) FROM jobs WHERE status='failed') AS failed,
    (SELECT COUNT(*) FROM jobs WHERE status='running') AS running,
    (SELECT COUNT(*) FROM devices)                  AS known_devices
`).get();

module.exports = {
  // raw db for advanced queries
  db,
  // devices
  upsertDevice: (d) => upsertDevice.run(d),
  getDevice:    (s) => getDevice.get(s),
  listDevices:  ()  => listDevices.all(),
  setDeviceTags:(s, tags) => setDeviceTags.run(JSON.stringify(tags), s),
  // jobs
  createJob:    (j) => createJob.run(j),
  getJob:       (id) => getJob.get(id),
  listJobs:     (limit = 50) => listJobs.all(limit),
  listJobsByDevice: (serial, limit = 50) => listJobsByDevice.all(serial, limit),
  updateJobStatus: (id, status, error = null) => updateJobStatus.run({ id, status, error }),
  // results
  addResult:    (r) => addResult.run(r),
  getResults:   (jobId) => getResults.all(jobId),
  // apks
  addApk:       (a) => addApk.run(a),
  listApks:     ()  => listApks.all(),
  getApk:       (id) => getApk.get(id),
  // stats
  getStats,
};
