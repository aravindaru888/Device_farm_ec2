// server/queue.js — Job scheduler & executor
const { EventEmitter } = require('events');
const { v4: uuid } = require('uuid');
const path = require('path');
const fs   = require('fs');
const adb  = require('./adb');
const metrics = require('./metrics');
const db   = require('./db');

const REPORTS_DIR = path.join(__dirname, '../data/reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

const SCREENSHOTS_DIR = path.join(__dirname, '../data/screenshots');
fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

class JobQueue extends EventEmitter {
  constructor() {
    super();
    this._queue = [];      // pending job ids
    this._running = new Map(); // serial → jobId  (one job per device)
  }

  // ── Submit a new job ────────────────────────────────────────────────────────

  submit(opts) {
    const id = opts.id || uuid();
    db.createJob({
      id,
      device_serial: opts.deviceSerial || null,
      apk_path:      opts.apkPath      || null,
      package_name:  opts.packageName,
      activity:      opts.activity     || null,
      test_command:  opts.testCommand  || null,
      metadata:      JSON.stringify(opts.metadata || {}),
    });

    this._queue.push(id);
    this.emit('job:queued', { id });
    this._tick();
    return id;
  }

  cancel(jobId) {
    const idx = this._queue.indexOf(jobId);
    if (idx !== -1) {
      this._queue.splice(idx, 1);
      db.updateJobStatus(jobId, 'cancelled');
      this.emit('job:cancelled', { id: jobId });
      return true;
    }
    return false;
  }

  // ── Tick — try to dispatch pending jobs to free devices ───────────────────

  _tick() {
    const pending = this._queue.slice();
    for (const jobId of pending) {
      const job = db.getJob(jobId);
      if (!job) { this._queue = this._queue.filter(id => id !== jobId); continue; }

      // Find an available device
      const device = this._pickDevice(job.device_serial);
      if (!device) continue; // no free device yet

      this._queue = this._queue.filter(id => id !== jobId);
      this._running.set(device.serial, jobId);
      this._execute(job, device).finally(() => {
        this._running.delete(device.serial);
        this._tick();
      });
    }
  }

  _pickDevice(preferredSerial) {
    for (const [serial, info] of adb.devices) {
      if (this._running.has(serial)) continue;
      if (preferredSerial && serial !== preferredSerial) continue;
      return info;
    }
    return null;
  }

  // ── Execute a job ─────────────────────────────────────────────────────────

  async _execute(job, device) {
    const { id, apk_path, package_name, activity, test_command } = job;
    const serial = device.serial;

    try {
      db.updateJobStatus(id, 'running');
      this.emit('job:start', { id, serial });

      // 1. Install APK (if provided)
      if (apk_path && fs.existsSync(apk_path)) {
        this.emit('job:log', { id, msg: `Installing ${path.basename(apk_path)}...` });
        const ok = adb.install(serial, apk_path, { replace: true, grant: true });
        if (!ok) throw new Error('APK install failed');
      }

      // 2. Pre-test screenshot
      const screenshotBefore = path.join(SCREENSHOTS_DIR, `${id}_before.png`);
      adb.screenshot(serial, screenshotBefore);

      // 3. Clear previous frame stats
      if (package_name) adb.clearFrameStats(serial, package_name);

      // 4. Start metrics sampling
      const nativeSamples = package_name
        ? metrics.startNativeSampling(id, serial, package_name, 1500)
        : null;

      // 5. Run the test command
      let testOutput = null;
      if (test_command) {
        this.emit('job:log', { id, msg: `Running: ${test_command}` });
        testOutput = await this._runTestCommand(id, serial, test_command);
      }

      // 6. Stop metrics, gather results
      const nativeReport = nativeSamples ? metrics.stopNativeSampling(id) : null;

      // 7. Startup time (if activity provided)
      let startupReport = null;
      if (package_name && activity) {
        this.emit('job:log', { id, msg: 'Measuring startup time...' });
        startupReport = await metrics.measureStartupTime(serial, package_name, activity, 2);
      }

      // 8. Post-test screenshot
      const screenshotAfter = path.join(SCREENSHOTS_DIR, `${id}_after.png`);
      adb.screenshot(serial, screenshotAfter);

      // 9. Optionally run Flashlight for full report
      let flashlightReport = null;
      if (package_name && metrics._flashlightAvailable) {
        this.emit('job:log', { id, msg: 'Running Flashlight analysis...' });
        try {
          flashlightReport = await metrics.runFlashlight(serial, package_name, 20, REPORTS_DIR);
        } catch (e) {
          this.emit('job:log', { id, msg: `Flashlight skipped: ${e.message}` });
        }
      }

      // 10. Persist results
      if (nativeReport) {
        db.addResult({ job_id: id, metric_type: 'native', payload: JSON.stringify(nativeReport) });
      }
      if (startupReport) {
        db.addResult({ job_id: id, metric_type: 'startup', payload: JSON.stringify(startupReport) });
      }
      if (flashlightReport) {
        db.addResult({ job_id: id, metric_type: 'flashlight', payload: JSON.stringify(flashlightReport) });
      }
      if (testOutput !== null) {
        db.addResult({ job_id: id, metric_type: 'test_output', payload: JSON.stringify({ output: testOutput }) });
      }

      db.updateJobStatus(id, 'passed');
      this.emit('job:done', { id, status: 'passed', serial });

    } catch (err) {
      metrics.stopNativeSampling(id); // clean up if still running
      db.updateJobStatus(id, 'failed', err.message);
      this.emit('job:done', { id, status: 'failed', serial, error: err.message });
    }
  }

  // ── Run test command ───────────────────────────────────────────────────────
  // Supports three modes:
  //   adb:<shell command>        → runs on device via adb shell
  //   instrument:<pkg>/<runner>  → runs Android instrumented test
  //   local:<shell command>      → runs on the host machine (e.g. maestro test ...)

  _runTestCommand(jobId, serial, testCommand) {
    return new Promise((resolve, reject) => {
      let child;
      const output = [];

      if (testCommand.startsWith('adb:')) {
        const cmd = testCommand.slice(4);
        child = adb.shellStream(serial, cmd);
      } else if (testCommand.startsWith('instrument:')) {
        const [pkg, runner] = testCommand.slice(11).split('/');
        child = adb.shellStream(serial, `am instrument -w ${pkg}/${runner}`);
      } else if (testCommand.startsWith('local:')) {
        const { spawn } = require('child_process');
        const cmd = testCommand.slice(6);
        child = spawn('sh', ['-c', `DEVICE_SERIAL=${serial} ${cmd}`]);
      } else {
        return resolve(null);
      }

      child.stdout.on('data', d => {
        const s = d.toString();
        output.push(s);
        this.emit('job:log', { id: jobId, msg: s.trim() });
      });
      child.stderr.on('data', d => output.push(d.toString()));
      child.on('close', (code) => {
        const out = output.join('');
        if (code !== 0) {
          reject(new Error(`Test command exited with code ${code}:\n${out.slice(0, 500)}`));
        } else {
          resolve(out);
        }
      });
      child.on('error', reject);
    });
  }

  status() {
    return {
      queue:   this._queue.length,
      running: Object.fromEntries(this._running),
    };
  }
}

module.exports = new JobQueue();
