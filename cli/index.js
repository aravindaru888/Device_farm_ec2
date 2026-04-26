#!/usr/bin/env node
// cli/index.js — device-farm CLI
const { Command } = require('commander');
const chalk = require('chalk');
const path  = require('path');
const fs    = require('fs');
const http  = require('http');

const BASE = process.env.FARM_URL || 'http://localhost:3000';

// ── HTTP helper ───────────────────────────────────────────────────────────

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url = new URL(urlPath, BASE);
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function uploadFile(filePath, urlPath) {
  return new Promise((resolve, reject) => {
    const filename  = path.basename(filePath);
    const boundary  = '----FormBoundary' + Math.random().toString(36).slice(2);
    const fileData  = fs.readFileSync(filePath);
    const header    = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total  = header.length + fileData.length + footer.length;

    const url  = new URL(urlPath, BASE);
    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': total,
      },
    };
    const req = http.request(url, opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.write(header);
    req.write(fileData);
    req.write(footer);
    req.end();
  });
}

// ── CLI ────────────────────────────────────────────────────────────────────

const program = new Command();
program.name('farm').description('Device Farm CLI').version('1.0.0');

// ── devices ───────────────────────────────────────────────────────────────

program
  .command('devices')
  .description('List connected devices')
  .action(async () => {
    const devs = await api('GET', '/api/devices');
    if (!devs.length) { console.log(chalk.gray('No devices found')); return; }
    console.log(chalk.bold('\nDevices:\n'));
    for (const d of devs) {
      const statusColor = d.status === 'idle' ? chalk.green : d.status === 'busy' ? chalk.yellow : chalk.gray;
      console.log(
        `  ${chalk.cyan(d.serial.padEnd(20))}` +
        `${(d.brand + ' ' + d.model).padEnd(24)}` +
        `API ${d.api.padEnd(4)}` +
        statusColor(`[${d.status}]`) +
        (d.battery != null ? chalk.gray(` 🔋${d.battery}%`) : '')
      );
    }
    console.log();
  });

program
  .command('connect <ip> [port]')
  .description('Connect a device over WiFi ADB (default port 5555)')
  .action(async (ip, port = 5555) => {
    console.log(`Connecting to ${ip}:${port}…`);
    const res = await api('POST', '/api/devices/connect', { ip, port: Number(port) });
    console.log(res.success ? chalk.green('✓ Connected') : chalk.red('✗ Failed to connect'));
  });

program
  .command('pair <ip> <port> <code>')
  .description('Pair Android 11+ wireless debugging (use the code shown on device)')
  .action(async (ip, port, code) => {
    console.log(`Pairing ${ip}:${port}…`);
    const res = await api('POST', '/api/devices/pair', { ip, port: Number(port), code });
    console.log(res.success ? chalk.green('✓ Paired') : chalk.red('✗ Failed to pair'));
  });

// ── APKs ─────────────────────────────────────────────────────────────────

program
  .command('upload <apk>')
  .description('Upload an APK to the farm')
  .action(async (apkPath) => {
    if (!fs.existsSync(apkPath)) { console.error(chalk.red('File not found: ' + apkPath)); process.exit(1); }
    console.log(`Uploading ${path.basename(apkPath)}…`);
    const res = await uploadFile(apkPath, '/api/apks');
    console.log(chalk.green(`✓ Uploaded  id=${res.id}  package=${res.packageName || '?'}`));
  });

// ── Jobs ──────────────────────────────────────────────────────────────────

program
  .command('run')
  .description('Submit a performance test job')
  .requiredOption('-p, --package <name>',  'App package name (e.g. com.myapp)')
  .option('-a, --apk <path>',              'APK file to install before testing')
  .option('--apk-id <id>',                 'APK id from a previous upload')
  .option('-d, --device <serial>',         'Target specific device serial')
  .option('-c, --cmd <command>',           'Test command (adb:|instrument:|local:)')
  .option('--activity <name>',             'Activity name for startup time measurement')
  .option('--name <label>',               'Human-readable job name')
  .option('--branch <branch>',            'Git branch (metadata)')
  .option('--commit <sha>',               'Git commit SHA (metadata)')
  .action(async (opts) => {
    let apkId = opts.apkId ? Number(opts.apkId) : undefined;

    // Auto-upload APK if a path is given
    if (opts.apk && !apkId) {
      if (!fs.existsSync(opts.apk)) { console.error(chalk.red('APK not found: ' + opts.apk)); process.exit(1); }
      process.stdout.write(`Uploading APK… `);
      const uploaded = await uploadFile(opts.apk, '/api/apks');
      apkId = uploaded.id;
      console.log(chalk.green(`✓ id=${apkId}`));
    }

    const res = await api('POST', '/api/jobs', {
      packageName:  opts.package,
      deviceSerial: opts.device,
      apkId,
      activity:     opts.activity,
      testCommand:  opts.cmd,
      metadata: {
        name:   opts.name,
        branch: opts.branch,
        commit: opts.commit,
      },
    });

    if (res.id) {
      console.log(chalk.green(`\n✓ Job submitted: ${res.id}`));
      console.log(chalk.gray(`  Watch: ${BASE}/api/jobs/${res.id}`));
      console.log(chalk.gray(`  Dashboard: ${BASE}\n`));
    } else {
      console.error(chalk.red('Error:'), res);
    }
  });

program
  .command('jobs')
  .description('List recent jobs')
  .option('-n, --limit <n>', 'Max jobs to show', '20')
  .option('-d, --device <serial>', 'Filter by device')
  .action(async (opts) => {
    const qs  = new URLSearchParams({ limit: opts.limit, ...(opts.device ? { device: opts.device } : {}) });
    const jobs = await api('GET', `/api/jobs?${qs}`);
    if (!jobs.length) { console.log(chalk.gray('No jobs')); return; }

    console.log(chalk.bold('\nJobs:\n'));
    for (const j of jobs) {
      const statusFn = {
        passed:    chalk.green,
        failed:    chalk.red,
        running:   chalk.yellow,
        queued:    chalk.gray,
        cancelled: chalk.gray,
      }[j.status] || chalk.white;

      const name = (j.metadata?.name || j.id.slice(0, 12)).padEnd(20);
      console.log(
        `  ${chalk.cyan(name)}` +
        `${(j.package_name || '').padEnd(32)}` +
        statusFn(j.status.padEnd(12)) +
        chalk.gray(j.started_at?.slice(11, 19) || '—')
      );
    }
    console.log();
  });

program
  .command('result <jobId>')
  .description('Show performance results for a job')
  .action(async (jobId) => {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (job.error) { console.error(chalk.red(job.error)); return; }

    console.log(chalk.bold(`\nJob ${job.id.slice(0, 12)} — ${job.package_name}`));
    console.log(`Status: ${job.status}  Device: ${job.device_serial || '—'}`);

    for (const r of job.results || []) {
      console.log(chalk.bold(`\n── ${r.metric_type.toUpperCase()} ──`));
      const p = r.payload;
      if (r.metric_type === 'native') {
        console.log(`  Avg FPS    : ${p.avgFps ?? '—'}`);
        console.log(`  Jank rate  : ${p.avgJankyPct ?? '—'}%`);
        console.log(`  P99 frame  : ${p.p99Avg ?? '—'} ms`);
        console.log(`  Avg CPU    : ${p.avgCpu ?? '—'}%`);
        console.log(`  Avg memory : ${p.avgMemMb ?? '—'} MB`);
        console.log(`  Samples    : ${p.sampleCount}`);
      } else if (r.metric_type === 'startup') {
        console.log(`  Cold start : ${p.cold?.avg ?? '—'} ms  (${p.cold?.runs?.join(', ')} ms)`);
        console.log(`  Warm start : ${p.warm?.avg ?? '—'} ms`);
      } else if (r.metric_type === 'flashlight') {
        console.log(`  Report: ${p.reportPath}`);
      } else {
        console.log(JSON.stringify(p, null, 2));
      }
    }
    console.log();
  });

program
  .command('perf <serial> <package>')
  .description('Live one-shot performance snapshot (no job)')
  .action(async (serial, pkg) => {
    console.log(`Sampling ${pkg} on ${serial}…`);
    const snap = await api('GET', `/api/perf/${serial}/${pkg}`);
    console.log(`  FPS      : ${snap.fps ?? '—'}`);
    console.log(`  Jank     : ${snap.jankyPct ?? '—'}%`);
    console.log(`  P99      : ${snap.p99 ?? '—'} ms`);
    console.log(`  CPU      : ${snap.cpu ?? '—'}%`);
    console.log(`  Memory   : ${snap.memMb ?? '—'} MB`);
  });

program.parse(process.argv);
