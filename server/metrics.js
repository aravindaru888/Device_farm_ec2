// server/metrics.js — Performance metrics collection
// Supports two modes:
//   1. Native mode: adb gfxinfo + dumpsys (no deps, works everywhere)
//   2. Flashlight mode: shells out to `flashlight measure` for full reports
//
const { execSync, spawn } = require('child_process');
const adb = require('./adb');

const VSYNC_NS = 16_666_667; // 16.67ms per frame at 60fps

class MetricsCollector {
  constructor() {
    this._flashlightAvailable = this._checkFlashlight();
    this._sessions = new Map(); // jobId → SessionState
  }

  _checkFlashlight() {
    try {
      execSync('flashlight --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  // ── Framestats parser ──────────────────────────────────────────────────────
  // Parses output of `adb shell dumpsys gfxinfo <pkg> framestats`
  // Returns { fps, jankyFrames, p50, p90, p95, p99 } (all in ms)

  parseFramestats(raw) {
    const lines = raw.split('\n');
    const frameSection = lines.findIndex(l => l.includes('---PROFILEDATA---'));
    if (frameSection === -1) return null;

    const data = lines.slice(frameSection + 2)
      .filter(l => l.includes(','))
      .map(l => l.split(',').map(Number))
      .filter(cols => cols.length >= 13 && cols[0] !== 0);

    if (!data.length) return null;

    // Column 13 = frame duration (INTENDED_VSYNC to FRAME_COMPLETED) in nanoseconds
    const durations = data.map(cols => (cols[12] - cols[1]) / 1_000_000); // → ms
    const sorted = [...durations].sort((a, b) => a - b);
    const janky = durations.filter(d => d > 16.67).length;

    const pct = (p) => sorted[Math.floor(sorted.length * p / 100)] ?? 0;

    return {
      frameCount: durations.length,
      fps: Math.round(1000 / (durations.reduce((s, d) => s + d, 0) / durations.length)),
      jankyFrames: janky,
      jankyPct: Math.round(janky / durations.length * 100),
      p50: Math.round(pct(50) * 10) / 10,
      p90: Math.round(pct(90) * 10) / 10,
      p95: Math.round(pct(95) * 10) / 10,
      p99: Math.round(pct(99) * 10) / 10,
    };
  }

  // ── Native metric snapshot ─────────────────────────────────────────────────

  async snapshot(serial, packageName) {
    const cpu    = adb.getCpuUsage(serial, packageName);
    const memKb  = adb.getMemUsage(serial, packageName);
    const fsRaw  = adb.getFrameStats(serial, packageName);
    const frames = this.parseFramestats(fsRaw);

    return {
      timestamp: Date.now(),
      cpu,
      memMb: memKb ? Math.round(memKb / 1024) : null,
      ...frames,
    };
  }

  // ── Continuous native sampling ─────────────────────────────────────────────

  startNativeSampling(jobId, serial, packageName, intervalMs = 1000) {
    const samples = [];
    const timer = setInterval(async () => {
      const snap = await this.snapshot(serial, packageName);
      samples.push(snap);
    }, intervalMs);
    this._sessions.set(jobId, { timer, samples, mode: 'native' });
    return samples; // live reference — callers see updates
  }

  stopNativeSampling(jobId) {
    const session = this._sessions.get(jobId);
    if (!session) return null;
    clearInterval(session.timer);
    this._sessions.delete(jobId);
    return this._aggregateNative(session.samples);
  }

  _aggregateNative(samples) {
    if (!samples.length) return {};
    const avg = (key) => {
      const vals = samples.map(s => s[key]).filter(v => v !== null && v !== undefined);
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length * 10) / 10 : null;
    };
    return {
      sampleCount: samples.length,
      avgCpu:      avg('cpu'),
      avgMemMb:    avg('memMb'),
      avgFps:      avg('fps'),
      avgJankyPct: avg('jankyPct'),
      p99Avg:      avg('p99'),
      samples,
    };
  }

  // ── Flashlight integration ─────────────────────────────────────────────────
  // Requires: npm i -g @perf-tools/flashlight (or local install)
  // Flashlight can access /dev/perf and /proc fs that dumpsys can't fully surface
  //
  // Usage:
  //   flashlight measure --packageName <pkg> --duration <secs> --serial <serial>
  //
  // This is the mode that gives you:
  //   - Accurate CPU threads breakdown
  //   - GPU rendering time
  //   - Startup time (cold/warm)
  //   - Scroll/animation smoothness score

  runFlashlight(serial, packageName, durationSecs = 30, outputDir = '/tmp') {
    if (!this._flashlightAvailable) {
      throw new Error(
        'Flashlight not found. Install with: npm install -g @perf-tools/flashlight'
      );
    }

    const outPath = `${outputDir}/flashlight_${serial}_${Date.now()}.json`;

    return new Promise((resolve, reject) => {
      const proc = spawn('flashlight', [
        'measure',
        '--packageName', packageName,
        '--serial',      serial,
        '--duration',    String(durationSecs),
        '--output',      outPath,
        '--format',      'json',
      ]);

      const logs = [];
      proc.stdout.on('data', d => logs.push(d.toString()));
      proc.stderr.on('data', d => logs.push(d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Flashlight exited ${code}:\n${logs.join('')}`));
        }
        try {
          const report = JSON.parse(require('fs').readFileSync(outPath, 'utf8'));
          resolve({ reportPath: outPath, report, logs: logs.join('') });
        } catch (e) {
          reject(new Error(`Failed to parse flashlight output: ${e.message}`));
        }
      });
    });
  }

  // ── Startup time measurement ───────────────────────────────────────────────
  // Measures cold and warm start time by force-stopping then launching the app
  // Returns ms values

  async measureStartupTime(serial, packageName, activityName, runs = 3) {
    const results = { cold: [], warm: [] };

    for (let i = 0; i < runs; i++) {
      // Cold start: force stop → clear memory → launch
      adb.shell(serial, `am force-stop ${packageName}`);
      adb.shell(serial, 'sync && echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true');
      await sleep(500);

      const coldRaw = adb.shell(serial,
        `am start-activity -W -n ${packageName}/${activityName} | grep TotalTime`);
      const coldMs = parseInt(coldRaw?.match(/TotalTime:\s*(\d+)/)?.[1] ?? '0');
      if (coldMs) results.cold.push(coldMs);

      await sleep(1000);

      // Warm start: just force-stop + restart (page cache warm)
      adb.shell(serial, `am force-stop ${packageName}`);
      await sleep(300);

      const warmRaw = adb.shell(serial,
        `am start-activity -W -n ${packageName}/${activityName} | grep TotalTime`);
      const warmMs = parseInt(warmRaw?.match(/TotalTime:\s*(\d+)/)?.[1] ?? '0');
      if (warmMs) results.warm.push(warmMs);
    }

    const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    return {
      cold: { runs: results.cold, avg: avg(results.cold), unit: 'ms' },
      warm: { runs: results.warm, avg: avg(results.warm), unit: 'ms' },
    };
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = new MetricsCollector();
