// tests/sample-test.js
// Run from your LOCAL machine — connects to EC2 device farm
// Just like BrowserStack, but your own farm
//
// Prerequisites on local machine:
//   npm install webdriverio
//
// Run:
//   node tests/sample-test.js
//
// With custom farm URL:
//   FARM_URL=http://13.239.102.204:3000 APPIUM_URL=http://13.239.102.204:4723 node tests/sample-test.js

const { getDriver } = require('./farm-client');

const APP_PACKAGE  = 'io.appium.android.apis';
const APP_ACTIVITY = '.ApiDemos';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🚀 Device Farm Test');
  console.log('════════════════════════════════\n');

  // Get driver from farm — exactly like BrowserStack
  const { driver, device } = await getDriver({
    appPackage:  APP_PACKAGE,
    appActivity: APP_ACTIVITY,
    // apkPath: './apks/ApiDemos-debug.apk',  // uncomment to auto-upload + install
  });

  try {
    console.log('\n[test] Running test flow...');
    await sleep(2000);

    // Click "App"
    console.log('[test] Clicking App...');
    const appItem = await driver.$(
      'android=new UiScrollable(new UiSelector().scrollable(true))' +
      '.scrollIntoView(new UiSelector().text("App"))'
    );
    await appItem.click();
    await sleep(1500);

    // Click "Action Bar"
    console.log('[test] Clicking Action Bar...');
    const actionBar = await driver.$(
      'android=new UiScrollable(new UiSelector().scrollable(true))' +
      '.scrollIntoView(new UiSelector().text("Action Bar"))'
    );
    await actionBar.click();
    await sleep(1500);

    // Scroll
    console.log('[test] Scrolling...');
    for (let i = 0; i < 3; i++) {
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
      await sleep(500);
    }

    console.log('\n[test] ✅ Test passed!\n');

  } catch (err) {
    console.error('\n[test] ❌ Test failed:', err.message, '\n');
    throw err;
  } finally {
    await driver.deleteSession();
    console.log('[farm] Session closed');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
