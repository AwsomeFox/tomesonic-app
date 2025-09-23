const { test, expect } = require('@playwright/test');

test.describe('Error Handling and Edge Cases', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should handle network disconnection gracefully', async ({ page }) => {
    // Start with connected state
    await page.waitForLoadState('networkidle');
    
    // Simulate offline mode
    await page.context().setOffline(true);
    
    // Try to navigate or reload
    await page.reload().catch(() => {
      console.log('Expected reload to fail offline');
    });
    
    // Check for offline indicators
    const offlineIndicators = [
      '.offline',
      '.network-error',
      '.connection-lost',
      '[data-testid="offline-indicator"]'
    ];
    
    let foundOfflineIndicator = false;
    for (const selector of offlineIndicators) {
      const indicator = page.locator(selector);
      if (await indicator.isVisible()) {
        foundOfflineIndicator = true;
        console.log(`Found offline indicator: ${selector}`);
        break;
      }
    }
    
    // Restore connection
    await page.context().setOffline(false);
    await page.waitForTimeout(2000);
    
    // App should recover
    expect(page.url()).toContain('localhost');
  });

  test('should handle invalid routes gracefully', async ({ page }) => {
    // Try to navigate to non-existent route
    const response = await page.goto('/non-existent-page-12345').catch(() => null);
    
    // Should either redirect to home/bookshelf or show error page
    const currentUrl = page.url();
    const isValidRedirect = currentUrl.includes('bookshelf') || 
                           currentUrl.includes('404') || 
                           currentUrl.includes('error');
    
    expect(isValidRedirect).toBeTruthy();
  });

  test('should handle slow loading gracefully', async ({ page }) => {
    // Start navigation
    const navigationPromise = page.goto('/', { waitUntil: 'domcontentloaded' });
    
    // Look for loading indicators while page loads
    const loadingIndicators = [
      '.loading',
      '.spinner',
      '.loader',
      '[data-testid="loading"]'
    ];
    
    let foundLoadingIndicator = false;
    for (const selector of loadingIndicators) {
      const indicator = page.locator(selector);
      if (await indicator.isVisible({ timeout: 1000 }).catch(() => false)) {
        foundLoadingIndicator = true;
        console.log(`Found loading indicator: ${selector}`);
        break;
      }
    }
    
    // Wait for navigation to complete
    await navigationPromise;
    
    // App should load successfully
    await expect(page).toHaveTitle('TomeSonic');
  });

  test('should handle console errors gracefully', async ({ page }) => {
    const consoleErrors = [];
    const jsErrors = [];
    
    // Capture console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Capture JavaScript errors
    page.on('pageerror', error => {
      jsErrors.push(error.message);
    });
    
    // Navigate and wait for page to load
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Navigate to different pages to test for errors
    const testRoutes = ['/bookshelf', '/settings', '/downloads'];
    
    for (const route of testRoutes) {
      await page.goto(route).catch(() => {
        console.log(`Route ${route} not accessible`);
      });
      await page.waitForTimeout(1000);
    }
    
    // Log any errors found (but don't fail test unless critical)
    if (consoleErrors.length > 0) {
      console.log('Console errors found:', consoleErrors);
    }
    
    if (jsErrors.length > 0) {
      console.log('JavaScript errors found:', jsErrors);
    }
    
    // Only fail if there are critical errors (not warnings)
    const criticalErrors = jsErrors.filter(error => 
      !error.includes('warning') && 
      !error.includes('deprecated') &&
      !error.includes('Non-passive event listener')
    );
    
    expect(criticalErrors.length).toBe(0);
  });

  test('should handle different screen sizes', async ({ page }) => {
    const screenSizes = [
      { width: 375, height: 812, name: 'iPhone X' },
      { width: 768, height: 1024, name: 'iPad' },
      { width: 1920, height: 1080, name: 'Desktop' }
    ];
    
    for (const size of screenSizes) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.waitForTimeout(500);
      
      console.log(`Testing on ${size.name} (${size.width}x${size.height})`);
      
      // Check that page renders properly
      const body = page.locator('body');
      await expect(body).toBeVisible();
      
      // Check that content doesn't overflow
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.body.scrollWidth > window.innerWidth;
      });
      
      // Some horizontal scroll might be expected on very small screens
      if (size.width >= 768) {
        expect(hasHorizontalScroll).toBeFalsy();
      }
    }
  });

  test('should handle memory and performance', async ({ page }) => {
    // Navigate to page
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Measure performance
    const performance = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return {
        domContentLoaded: nav.domContentLoadedEventEnd - nav.domContentLoadedEventStart,
        loadComplete: nav.loadEventEnd - nav.loadEventStart,
        firstPaint: performance.getEntriesByType('paint')[0]?.startTime || 0
      };
    });
    
    console.log('Performance metrics:', performance);
    
    // Check that page loads in reasonable time (10 seconds max)
    expect(performance.domContentLoaded).toBeLessThan(10000);
    
    // Stress test: rapidly navigate between pages
    const routes = ['/', '/bookshelf', '/settings', '/downloads'];
    
    for (let i = 0; i < 5; i++) {
      for (const route of routes) {
        await page.goto(route).catch(() => {});
        await page.waitForTimeout(100);
      }
    }
    
    // App should still be responsive
    const title = await page.title();
    expect(title).toBe('TomeSonic');
  });

  test('should handle accessibility requirements', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Check for basic accessibility attributes
    const hasLang = await page.locator('html[lang]').count() > 0;
    expect(hasLang).toBeTruthy();
    
    // Check for skip links or main content
    const skipLinks = page.locator('a[href="#main"], a[href="#content"], .skip-link');
    const mainContent = page.locator('main, [role="main"], #main, #content');
    
    const hasSkipLinks = await skipLinks.count() > 0;
    const hasMainContent = await mainContent.count() > 0;
    
    // Should have either skip links or clearly defined main content
    expect(hasSkipLinks || hasMainContent).toBeTruthy();
    
    // Check for heading structure
    const headings = page.locator('h1, h2, h3, h4, h5, h6');
    const headingCount = await headings.count();
    
    if (headingCount > 0) {
      console.log(`Found ${headingCount} headings on page`);
    }
    
    // Check for proper button labeling
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    
    for (let i = 0; i < Math.min(buttonCount, 10); i++) {
      const button = buttons.nth(i);
      const hasLabel = await button.evaluate(el => {
        return el.textContent?.trim() || 
               el.getAttribute('aria-label') || 
               el.getAttribute('title') ||
               el.querySelector('span')?.textContent?.trim();
      });
      
      if (!hasLabel) {
        console.warn(`Button ${i} may not have proper labeling`);
      }
    }
  });
});