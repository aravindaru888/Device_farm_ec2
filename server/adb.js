// server/adb.js — ADB device management layer
const { execSync, exec, spawn } = require('child_process');
const { EventEmitter } = require('events');

class ADBManager extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // serial → DeviceInfo
    this._pollInterval = null;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  _run(cmd, opts = {}) {
    try {
      return execSync(`adb ${cmd}`, { encoding: 'utf8', timeout: 10000, ...opts }).trim();
    } catch (e) {
      return null;
    }
  }

  _runDevice(serial, cmd, opts = {}) {
    return this._run(`-s ${serial} ${cmd}`, opts);
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  listConnected() {
    const raw = this._run('devices -l');
    if (!raw) return [];

    return raw
      .split('\n')
      .slice(1) // skip "List of devices attached"
      .filter(l => l.includes('\t'))
      .map(line => {
        const parts = line.trim().split(/\s+/);
        const serial = parts[0];
        const state = parts[1]; // device | offline | unauthorized
        const props = {};
        parts.slice(2).forEach(kv => {
          const [k, v] = kv.split(':');
          if (k && v) props[k] = v;
        });
        return { serial, state, ...props };
      });
  }

  getDeviceInfo(serial) {
    const model = this._runDevice(serial, 'shell getprop ro.product.model') || 'Unknown';
    const brand = this._runDevice(serial, 'shell getprop ro.product.brand') || 'Unknown';
    const api   = this._runDevice(serial, 'shell getprop ro.build.version.sdk') || '?';
    const os    = this._runDevice(serial, 'shell getprop ro.build.version.release') || '?';
    const arch  = this._runDevice(serial, 'shell getprop ro.product.cpu.abi') || '?';
    const batRaw = this._runDevice(serial, 'shell dumpsys battery | grep level');
    const battery = batRaw ? parseInt(batRaw.match(/\d+/)?.[0] ?? '0') : null;

    return { serial, model, brand, api, os, arch, battery };
  }

  // ── device polling ────────────────────────────────────────────────────────

  startPolling(intervalMs = 3000) {
    this._pollInterval = setInterval(() => this._poll(), intervalMs);
    this._poll(); // immediate first pass
  }

  stopPolling() {
    if (this._pollInterval) clearInterval(this._pollInterval);
  }

  _poll() {
    const current = new Set();
    for (const { serial, state } of this.listConnected()) {
      current.add(serial);
      if (state !== 'device') continue; // not ready

      if (!this.devices.has(serial)) {
        const info = this.getDeviceInfo(serial);
        this.devices.set(serial, { ...info, status: 'idle', connectedAt: new Date() });
        this.emit('device:connect', this.devices.get(serial));
      }
    }

    // detect disconnections
    for (const [serial] of this.devices) {
      if (!current.has(serial)) {
        const info = this.devices.get(serial);
        this.devices.delete(serial);
        this.emit('device:disconnect', info);
      }
    }
  }

  // ── WiFi pairing ──────────────────────────────────────────────────────────

  connectWifi(ip, port = 5555) {
    const result = this._run(`connect ${ip}:${port}`);
    return result && result.includes('connected');
  }

  pairWifi(ip, port, code) {
    // Android 11+ wireless debugging pairing
    const result = this._run(`pair ${ip}:${port} ${code}`);
    return result && result.includes('Successfully paired');
  }

  // ── APK management ────────────────────────────────────────────────────────

  install(serial, apkPath, opts = {}) {
    const flags = [
      opts.replace ? '-r' : '',
      opts.grant   ? '-g' : '',
      opts.debug   ? '--debug' : '',
    ].filter(Boolean).join(' ');
    const result = this._runDevice(serial, `install ${flags} "${apkPath}"`, { timeout: 60000 });
    return result?.includes('Success') ?? false;
  }

  uninstall(serial, packageName) {
    const result = this._runDevice(serial, `uninstall ${packageName}`);
    return result?.includes('Success') ?? false;
  }

  listPackages(serial) {
    const raw = this._runDevice(serial, 'shell pm list packages -3') || '';
    return raw.split('\n').map(l => l.replace('package:', '').trim()).filter(Boolean);
  }

  // ── shell exec ────────────────────────────────────────────────────────────

  shell(serial, cmd) {
    return this._runDevice(serial, `shell ${cmd}`);
  }

  shellStream(serial, cmd) {
    return spawn('adb', ['-s', serial, 'shell', cmd]);
  }

  // ── screen capture ────────────────────────────────────────────────────────

  screenshot(serial, localPath) {
    this._runDevice(serial, 'shell screencap -p /sdcard/_farm_cap.png');
    this._runDevice(serial, `pull /sdcard/_farm_cap.png "${localPath}"`);
    this._runDevice(serial, 'shell rm /sdcard/_farm_cap.png');
    return localPath;
  }

  // ── logcat ────────────────────────────────────────────────────────────────

  logcatStream(serial, filter = '*:W') {
    return spawn('adb', ['-s', serial, 'logcat', '-v', 'time', filter]);
  }

  // ── atd (Android Test Daemon) ─────────────────────────────────────────────
  // Used to run instrumented tests without a host IDE

  runInstrumentedTest(serial, packageName, testRunner, opts = {}) {
    const cls = opts.class ? ` -e class ${opts.class}` : '';
    const extra = opts.extras ? Object.entries(opts.extras)
      .map(([k, v]) => `-e ${k} ${v}`).join(' ') : '';
    const cmd = `am instrument -w ${cls} ${extra} ${packageName}/${testRunner}`;
    return this._runDevice(serial, `shell ${cmd}`, { timeout: opts.timeout ?? 300000 });
  }

  // ── metrics helpers ───────────────────────────────────────────────────────

  getCpuUsage(serial, packageName) {
    const raw = this.shell(serial, `dumpsys cpuinfo | grep ${packageName}`);
    const match = raw?.match(/([\d.]+)%/);
    return match ? parseFloat(match[1]) : null;
  }

  getMemUsage(serial, packageName) {
    const raw = this.shell(serial, `dumpsys meminfo ${packageName} | grep TOTAL`);
    const nums = raw?.match(/\d+/g);
    return nums ? parseInt(nums[0]) : null; // kB
  }

  getFrameStats(serial, packageName) {
    const raw = this.shell(serial, `dumpsys gfxinfo ${packageName} framestats`);
    // Returns raw framestats — parsed by MetricsCollector
    return raw || '';
  }

  clearFrameStats(serial, packageName) {
    this.shell(serial, `dumpsys gfxinfo ${packageName} reset`);
  }
}

module.exports = new ADBManager();
