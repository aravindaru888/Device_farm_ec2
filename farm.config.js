// farm.config.js
// Works exactly like BrowserStack config — just point to your farm URL
// BrowserStack: user/key + hub URL
// Device Farm:  just the farm URL
//
// Usage:
//   FARM_URL=http://13.239.102.204:3000 node tests/run.js

module.exports = {
  // Your EC2 device farm URL
  farmUrl: process.env.FARM_URL || 'http://13.239.102.204:3000',

  // Appium server running on EC2
  appiumUrl: process.env.APPIUM_URL || 'http://13.239.102.204:4723',

  // Default capabilities — device is auto-picked from farm
  capabilities: {
    platformName: 'Android',
    'appium:automationName':           'UiAutomator2',
    'appium:noReset':                  true,
    'appium:skipUnlock':               true,
    'appium:ignoreHiddenApiPolicyError': true,
    'appium:skipDeviceInitialization': true,
    'appium:newCommandTimeout':        60,
    'appium:mjpegServerPort': 9100,
'appium:systemPort': 8201,
  },
};
