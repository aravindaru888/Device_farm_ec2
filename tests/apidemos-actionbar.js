// tests/apidemos-actionbar.js
// Just drives the UI — Flashlight handles all measurement externally.
// Run with: flashlight test --bundleId io.appium.android.apis --testCommand "node tests/apidemos-actionbar.js" --duration 10000 --resultsFilePath data/reports/results.json

const { remote } = require('webdriverio');
const http = require('http');

const PACKAGE  = 'io.appium.android.apis';
const ACTIVITY = '.ApiDemos';
const FARM_URL = process.env.FARM_URL || 'http://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function log(msg)  { console.log(`[${new Date().toTimeString().slice(0,8)}] ${msg}`); }

function farmApi(method, urlPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, FARM_URL);
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  // Get device serial from farm
  const devices = await farmApi('GET', '/api/devices');
  const device  = devices.find(d => d.connected);
  if (!device) throw new Error('No connected device found. Is npm start running?');
  log(`Device: ${device.serial} (${device.brand} ${device.model} · Android ${device.os})`);

  // Connect to Appium
  log('Connecting to Appium...');
  const driver = await remote({
    hostname: '127.0.0.1',
    port:     4723,
    logLevel: 'warn',
    capabilities: {
      platformName:                    'Android',
      'appium:deviceName':             device.serial,
      'appium:udid':                   device.serial,
      'appium:appPackage':             PACKAGE,
      'appium:appActivity':            ACTIVITY,
      'appium:automationName':         'UiAutomator2',
      'appium:noReset':                true,
      'appium:newCommandTimeout':      60,
      'appium:relaxedSecurity':        true,
      'appium:skipUnlock':             true,
      'appium:ignoreHiddenApiPolicyError': true,
      'appium:skipDeviceInitialization':   true,
    },
  });
  log('Appium connected — app launched');
  await sleep(2000);

  try {
    // Click "App"
    log('Clicking "App"...');
    const appItem = await driver.$(
      'android=new UiScrollable(new UiSelector().scrollable(true))' +
      '.scrollIntoView(new UiSelector().text("App"))'
    );
    await appItem.click();
    await sleep(1500);

    // Click "Action Bar"
    log('Clicking "Action Bar"...');
    const actionBarItem = await driver.$(
      'android=new UiScrollable(new UiSelector().scrollable(true))' +
      '.scrollIntoView(new UiSelector().text("Action Bar"))'
    );
    await actionBarItem.click();
    await sleep(1500);

    // Scroll to generate frame data for Flashlight to measure
    log('Scrolling...');
    for (let i = 0; i < 5; i++) {
      await driver.performActions([{
        type:       'pointer',
        id:         'finger1',
        parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0,   origin: 'viewport', x: 400, y: 800 },
          { type: 'pointerDown', button: 0 },
          { type: 'pause',       duration: 50 },
          { type: 'pointerMove', duration: 500, origin: 'viewport', x: 400, y: 200 },
          { type: 'pointerUp',   button: 0 },
        ],
      }]);
      await driver.releaseActions();
      await sleep(600);
    }

    await sleep(1000);
    log('Flow complete');

  } finally {
    await driver.deleteSession();
  }
}

main().catch(err => {
  console.error('\n❌', err.message);
  if (err.message.includes('4723')) console.error('Appium not running → npx appium --relaxed-security');
  if (err.message.includes('3000')) console.error('Farm server not running → npm start');
  process.exit(1);
});
