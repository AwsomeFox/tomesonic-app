const { test, expect } = require('@playwright/test');

test.describe('TomeSonic Application Tests', () => {
  test.beforeEach(async ({ page }) => {
    // Go to the starting URL before each test
    await page.goto('/');
  });

  test('should load the main application', async ({ page }) => {
    // Check that the page title is correct
    await expect(page).toHaveTitle('TomeSonic');
  });

  test('should redirect to bookshelf from root', async ({ page }) => {
    // The root page should redirect to /bookshelf
    await expect(page).toHaveURL(/.*bookshelf/);
  });

  test('should display the app bar', async ({ page }) => {
    // Wait for app to load and check for app bar component
    await page.waitForSelector('[data-testid="app-bar"], .app-appbar, nav', { timeout: 10000 });
    
    // Check for common app bar elements
    const appBar = page.locator('nav, .app-appbar, [data-testid="app-bar"]').first();
    await expect(appBar).toBeVisible();
  });

  test('should display the bookshelf interface', async ({ page }) => {
    // Wait for bookshelf content to load
    await page.waitForSelector('#bookshelf-wrapper, .bookshelf, [data-testid="bookshelf"]', { timeout: 10000 });
    
    // Check that bookshelf wrapper is visible
    const bookshelfWrapper = page.locator('#bookshelf-wrapper');
    await expect(bookshelfWrapper).toBeVisible();
  });

  test('should have proper Material 3 styling', async ({ page }) => {
    // Check for Material 3 design tokens in CSS variables
    const htmlElement = page.locator('html');
    
    // Wait for the page to load
    await page.waitForLoadState('networkidle');
    
    // Check that the page has Material 3 design tokens
    const computedStyle = await htmlElement.evaluate((el) => {
      const style = getComputedStyle(el);
      // Check for common Material 3 CSS variables
      return {
        hasSurfaceColor: style.getPropertyValue('--md-sys-color-surface').trim() !== '',
        hasOnSurfaceColor: style.getPropertyValue('--md-sys-color-on-surface').trim() !== '',
        hasPrimaryColor: style.getPropertyValue('--md-sys-color-primary').trim() !== '',
      };
    });
    
    // At least one Material 3 design token should be present
    expect(
      computedStyle.hasSurfaceColor || 
      computedStyle.hasOnSurfaceColor || 
      computedStyle.hasPrimaryColor
    ).toBeTruthy();
  });

  test('should handle responsive design on mobile viewport', async ({ page, isMobile }) => {
    if (isMobile) {
      // Wait for page to load
      await page.waitForLoadState('networkidle');
      
      // Check that the viewport is mobile-sized
      const viewport = page.viewportSize();
      expect(viewport.width).toBeLessThanOrEqual(768);
      
      // Verify that content adapts to mobile
      const content = page.locator('#content, .main-content').first();
      await expect(content).toBeVisible();
    }
  });
});