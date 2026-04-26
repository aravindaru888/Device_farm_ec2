// Screen 3: Action Bar screen
const { remote } = require('webdriverio');
const http = require('http');

const PACKAGE  = 'io.appium.android.apis';
const ACTIVITY = '.ApiDemos';
const FARM_URL = process.env.FARM_URL || 'http://localhost:3000';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getDevice() {
  return new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/devices', FARM_URL), { method: 'GET' }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(JSON.parse(data).find(d => d.connected)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const device = await getDevice();
  if (!device) throw new Error('No connected device found');

  const driver = await remote({
    hostname: '127.0.0.1', port: 4723, logLevel: 'warn',
    capabilities: {
      platformName: 'Android',
      'appium:udid': device.serial,
      'appium:appPackage': PACKAGE,
      'appium:appActivity': ACTIVITY,
      'appium:automationName': 'UiAutomator2',
      'appium:noReset': true,
      'appium:skipUnlock': true,
      'appium:ignoreHiddenApiPolicyError': true,
      'appium:skipDeviceInitialization': true,
    },
  });

  try {
    await sleep(1000);
    // Navigate: Home → App → Action Bar
    const appItem = await driver.$('android=new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("App"))');
    await appItem.click();
    await sleep(1000);

    const actionBarItem = await driver.$('android=new UiScrollable(new UiSelector().scrollable(true)).scrollIntoView(new UiSelector().text("Action Bar"))');
    await actionBarItem.click();
    await sleep(1500);

    // Scroll the Action Bar screen — Flashlight measures this screen
    for (let i = 0; i < 5; i++) {
      await driver.performActions([{
        type: 'pointer', id: 'finger1',
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
  } finally {
    await driver.deleteSession();
  }
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
