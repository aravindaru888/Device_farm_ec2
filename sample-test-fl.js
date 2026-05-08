// tests/sample-test.js
// Run from EC2 (where Flashlight + Appium + ADB all live)
// Reports saved to EC2, then download to local
//
// On EC2:
//   npm install @perf-profiler/e2e @bam.tech/appium-helper
//   npx appium --relaxed-security &
//   node tests/sample-test.js
//
// Get reports to local:
//   scp -i DeviceFarm.pem ubuntu@13.239.102.204:~/device-farm/data/reports/*.json ./reports/
//   flashlight report ./reports/results.json

const { measurePerformance } = require('@perf-profiler/e2e');
const { getDriver }           = require('./farm-client');

const APP_PACKAGE  = 'io.appium.android.apis';
const APP_ACTIVITY = '.ApiDemos';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('\n🚀 Device Farm + Flashlight Test');
  console.log('════════════════════════════════\n');

  // Get WebdriverIO driver from farm
  const { driver, device } = await getDriver({
    appPackage:  APP_PACKAGE,
    appActivity: APP_ACTIVITY,
  });

  console.log(`[farm] Running on: ${device.serial} (${device.brand} ${device.model})\n`);
  
  try {
    // Define the Flashlight test case
    const testCase = {
      // beforeTest runs before measurement starts
      beforeTest: async () => {
        console.log('[flashlight] beforeTest — resetting app state...');
        await driver.terminateApp(APP_PACKAGE);
        await sleep(1000);
        await driver.activateApp(APP_PACKAGE);
        await sleep(2000);
      },

      // run is where Flashlight measures performance
      run: async () => {
        console.log('[test] Clicking App...');
        const appItem = await driver.$(
          'android=new UiScrollable(new UiSelector().scrollable(true))' +
          '.scrollIntoView(new UiSelector().text("App"))'
        );
        await appItem.click();
        await sleep(1500);

        console.log('[test] Clicking Action Bar...');
        const actionBar = await driver.$(
          'android=new UiScrollable(new UiSelector().scrollable(true))' +
          '.scrollIntoView(new UiSelector().text("Action Bar"))'
        );
        await actionBar.click();
        await sleep(1500);

        console.log('[test] Scrolling...');
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
          await sleep(500);
        }
      },

      // Duration ensures consistent measurement window
      duration: 15000,
    };

    // Run Flashlight measurement — captures CPU, FPS, jank, memory
    console.log('[flashlight] Starting performance measurement...');
    process.env.ANDROID_SERIAL = device.serial;

    const { writeResults } = await measurePerformance(APP_PACKAGE, testCase ,{
  serial: device.serial,
  iterationCount: 2, 
});

    // Save results to farm reports directory
    const reportPath = `${__dirname}/../data/reports/results_${Date.now()}.json`;
    writeResults(reportPath);

    console.log('\n════════════════════════════════');
    console.log('✅ Test complete!');
    console.log(`📊 Report saved to: /home/ubuntu/device-farm/`);
    console.log('\nTo view report:');
    console.log(`  1. Download from EC2:`);
    console.log(`     scp -i DeviceFarm.pem ubuntu@13.239.102.204:/home/ubuntu/device-farm/ ./report.json`);
    console.log(`  2. Open on your laptop:`);
    console.log(`     flashlight report ./report.json`);
    console.log('════════════════════════════════\n');

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
