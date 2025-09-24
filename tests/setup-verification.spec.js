const { test, expect } = require('@playwright/test');

test.describe('Playwright Setup Verification', () => {
  test('should verify basic Playwright functionality', async ({ page }) => {
    // This is a simple test to verify Playwright is working
    // It tests basic JavaScript execution without needing complex UI
    
    const result = await page.evaluate(() => {
      return {
        userAgent: navigator.userAgent,
        windowExists: typeof window !== 'undefined',
        documentExists: typeof document !== 'undefined',
        currentTime: Date.now()
      };
    });
    
    expect(result.userAgent).toContain('HeadlessChrome');
    expect(result.windowExists).toBe(true);
    expect(result.documentExists).toBe(true);
    expect(typeof result.currentTime).toBe('number');
  });
  
  test('should handle basic page navigation', async ({ page }) => {
    // Test basic navigation to a simple HTML page
    await page.setContent(`
      <!DOCTYPE html>
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Test Content</h1>
          <button id="test-button">Click Me</button>
          <div id="result"></div>
          <script>
            document.getElementById('test-button').addEventListener('click', function() {
              document.getElementById('result').textContent = 'Button clicked!';
            });
          </script>
        </body>
      </html>
    `);
    
    await expect(page).toHaveTitle('Test Page');
    await expect(page.locator('h1')).toHaveText('Test Content');
    
    // Test interaction
    await page.click('#test-button');
    await expect(page.locator('#result')).toHaveText('Button clicked!');
  });
  
  test('should verify configuration values', async ({ page }) => {
    // Verify our Playwright configuration is loaded correctly
    const config = require('../playwright.config.js');
    
    expect(config.testDir).toBe('./tests');
    expect(config.use.baseURL).toBe('http://localhost:1337');
    expect(config.projects).toBeDefined();
    expect(config.projects.length).toBeGreaterThan(0);
    
    // Test that we can access the config in the test
    const hasChromium = config.projects.some(p => p.name === 'chromium');
    expect(hasChromium).toBe(true);
  });
});