// farm-client.js
// Drop-in helper to connect your WebdriverIO tests to the device farm
// Works exactly like BrowserStack's client — getDriver() returns a ready session
//
// Usage:
//   const { getDriver, uploadApk } = require('./farm-client');
//   const driver = await getDriver({ appPackage: 'com.myapp', appActivity: '.Main' });

const { remote } = require('webdriverio');
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./farm.config');

// ── Farm API ───────────────────────────────────────────────────────────────────

function farmApi(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const url = new URL(urlPath, config.farmUrl);
    const req = http.request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Upload APK ─────────────────────────────────────────────────────────────────

function uploadApk(apkPath) {
  return new Promise((resolve, reject) => {
    const filename  = path.basename(apkPath);
    const boundary  = '----FarmBoundary' + Math.random().toString(36).slice(2);
    const fileData  = fs.readFileSync(apkPath);
    const header    = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="apk"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const total  = header.length + fileData.length + footer.length;

    const url = new URL('/api/apks', config.farmUrl);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': total,
      },
    }, res => {
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

// ── Get device from farm ───────────────────────────────────────────────────────

async function getDevice(preferredSerial) {
  const devices = await farmApi('GET', '/api/devices');
  const device  = devices.find(d => d.connected && (!preferredSerial || d.serial === preferredSerial));
  if (!device) throw new Error(`No connected device found on farm at ${config.farmUrl}`);
  return device;
}

// ── Get WebdriverIO driver ─────────────────────────────────────────────────────
// This is the main function — works like BrowserStack's getDriver()
//
// opts:
//   appPackage   — required
//   appActivity  — required
//   apkPath      — optional, auto-uploads and installs before test
//   deviceSerial — optional, auto-picks if omitted

async function getDriver(opts = {}) {
  // Validate required options
  if (!opts.appPackage || !opts.appActivity) {
    throw new Error(
      'getDriver() requires opts.appPackage and opts.appActivity\n' +
      'Example:\n' +
      '  await getDriver({\n' +
      '    appPackage: "io.appium.android.apis",\n' +
      '    appActivity: ".ApiDemos"\n' +
      '  })'
    );
  }

  console.log(`[farm] Connecting to ${config.farmUrl}...`);

  // Get device
  const device = await getDevice(opts.deviceSerial);
  console.log(`[farm] Device: ${device.serial} (${device.brand} ${device.model} · Android ${device.os})`);

  // Upload APK if provided
  if (opts.apkPath) {
    console.log(`[farm] Uploading APK: ${path.basename(opts.apkPath)}...`);
    const uploaded = await uploadApk(opts.apkPath);
    console.log(`[farm] APK uploaded: id=${uploaded.id}`);

    // Submit install job
    await farmApi('POST', '/api/jobs', {
      packageName:  opts.appPackage,
      deviceSerial: device.serial,
      apkId:        uploaded.id,
      metadata:     { name: `Install ${path.basename(opts.apkPath)}` },
    });
    // Wait for install to complete
    await new Promise(r => setTimeout(r, 5000));
    console.log(`[farm] APK installed`);
  }

  // Build Appium URL — points to EC2 Appium
  const appiumUrl = new URL(config.appiumUrl);

  // Create WebdriverIO session
  console.log(`[farm] Starting Appium session...`);
  const driver = await remote({
    hostname: appiumUrl.hostname,
    port:     parseInt(appiumUrl.port) || 4723,
    logLevel: 'warn',
    capabilities: {
      ...config.capabilities,
      'appium:deviceName':  device.serial,
      'appium:udid':        device.serial,
      'appium:appPackage':  opts.appPackage,
      'appium:appActivity': opts.appActivity,
      ...opts.capabilities,
    },
  });

  console.log(`[farm] Session ready ✓`);
  return { driver, device };
}

// ── Submit perf job ────────────────────────────────────────────────────────────

async function submitPerfJob(opts) {
  return farmApi('POST', '/api/jobs', {
    packageName:  opts.appPackage,
    deviceSerial: opts.deviceSerial,
    activity:     opts.appActivity,
    testCommand:  opts.testCommand,
    metadata:     opts.metadata || {},
  });
}

module.exports = { getDriver, uploadApk, getDevice, submitPerfJob, farmApi };
