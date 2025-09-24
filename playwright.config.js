// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: false, // Reduced to avoid resource conflicts
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 1 : 0, // Reduced retries
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : 2, // Limited workers to prevent hanging
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: process.env.CI ? 'github' : 'html',
  /* Global timeout for entire test run */
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : 5 * 60 * 1000, // 5-10 minutes max
  /* Timeout per test */
  timeout: 30 * 1000, // 30 seconds per test
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: 'http://localhost:1337',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
    /* Action timeout */
    actionTimeout: 10 * 1000, // 10 seconds for actions
    /* Navigation timeout */
    navigationTimeout: 15 * 1000, // 15 seconds for navigation
  },

  /* Configure projects for major browsers - start with just chromium to avoid hanging */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // Only enable other browsers if PLAYWRIGHT_ALL_BROWSERS is set
    ...(process.env.PLAYWRIGHT_ALL_BROWSERS ? [
      {
        name: 'firefox',
        use: { ...devices['Desktop Firefox'] },
      },
      {
        name: 'webkit', 
        use: { ...devices['Desktop Safari'] },
      },
      {
        name: 'Mobile Chrome',
        use: { ...devices['Pixel 5'] },
      },
      {
        name: 'Mobile Safari',
        use: { ...devices['iPhone 12'] },
      },
    ] : []),
  ],

  /* Run your local dev server before starting the tests */
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:1337',
    reuseExistingServer: !process.env.CI,
    timeout: 60 * 1000, // Reduced timeout to 60 seconds
    stderr: 'pipe', // Capture server errors
    stdout: 'pipe', // Capture server output
  },
});