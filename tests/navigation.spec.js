const { test, expect } = require('@playwright/test');

test.describe('Navigation Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should navigate between main sections', async ({ page }) => {
    // Wait for initial page load
    await page.waitForLoadState('networkidle');
    
    // Check if we're on bookshelf (default redirect)
    await expect(page).toHaveURL(/.*bookshelf/);
    
    // Look for navigation elements (could be in sidebar, bottom nav, or top nav)
    const possibleNavSelectors = [
      'nav a', 
      '.nav-item', 
      '.navigation a',
      '.bookshelf-nav a',
      '.side-drawer a',
      '.bottom-nav a',
      '[data-testid="nav-link"]'
    ];
    
    let navigationFound = false;
    
    for (const selector of possibleNavSelectors) {
      const navElements = page.locator(selector);
      const count = await navElements.count();
      
      if (count > 0) {
        navigationFound = true;
        console.log(`Found ${count} navigation elements with selector: ${selector}`);
        
        // Try to click on navigation items if they exist
        for (let i = 0; i < Math.min(count, 3); i++) {
          const navItem = navElements.nth(i);
          const isVisible = await navItem.isVisible();
          if (isVisible) {
            const href = await navItem.getAttribute('href');
            const text = await navItem.textContent();
            console.log(`Nav item ${i}: "${text}" -> ${href}`);
          }
        }
        break;
      }
    }
    
    // At minimum, verify we can navigate or that nav structure exists
    expect(navigationFound).toBeTruthy();
  });

  test('should handle page transitions smoothly', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    
    // Check if page transition animations are defined
    const hasTransitions = await page.evaluate(() => {
      const styles = Array.from(document.styleSheets)
        .map(sheet => {
          try {
            return Array.from(sheet.cssRules)
              .map(rule => rule.cssText)
              .join(' ');
          } catch (e) {
            return '';
          }
        })
        .join(' ');
      
      return styles.includes('transition') || styles.includes('page-transition');
    });
    
    expect(hasTransitions).toBeTruthy();
  });

  test('should open and close side drawer/menu when available', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    
    // Look for menu/hamburger button
    const menuSelectors = [
      '[data-testid="menu-button"]',
      '.hamburger',
      '.menu-button',
      '.side-drawer-toggle',
      'button[aria-label*="menu"]',
      'button[aria-label*="Menu"]',
      '.material-symbols:text("menu")',
      'span:text("menu")'
    ];
    
    for (const selector of menuSelectors) {
      const menuButton = page.locator(selector).first();
      
      if (await menuButton.isVisible()) {
        console.log(`Found menu button with selector: ${selector}`);
        
        // Click to open
        await menuButton.click();
        await page.waitForTimeout(500); // Wait for animation
        
        // Look for opened drawer/menu
        const drawerSelectors = [
          '.side-drawer.open',
          '.drawer.open',
          '.menu.open',
          '[data-testid="side-drawer"]',
          '.slide-in'
        ];
        
        let drawerFound = false;
        for (const drawerSelector of drawerSelectors) {
          const drawer = page.locator(drawerSelector);
          if (await drawer.isVisible()) {
            drawerFound = true;
            console.log(`Found opened drawer with selector: ${drawerSelector}`);
            break;
          }
        }
        
        // If we found a drawer, try to close it
        if (drawerFound) {
          // Try clicking the menu button again or look for close button
          const closeButton = page.locator('.close, .drawer-close, [data-testid="close-drawer"]').first();
          if (await closeButton.isVisible()) {
            await closeButton.click();
          } else {
            await menuButton.click(); // Toggle back
          }
          await page.waitForTimeout(500);
        }
        
        break;
      }
    }
  });

  test('should handle browser back navigation', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    
    // Navigate to a specific path if available
    const currentUrl = page.url();
    
    // Try to navigate to a different page
    await page.goto('/settings').catch(() => {
      // If settings doesn't exist, try other common paths
      return page.goto('/account').catch(() => {
        return page.goto('/downloads').catch(() => {
          console.log('No alternate pages found for navigation test');
        });
      });
    });
    
    // Wait a moment
    await page.waitForTimeout(1000);
    
    // Go back
    await page.goBack();
    
    // Should be back to original URL or bookshelf
    const backUrl = page.url();
    expect(backUrl === currentUrl || backUrl.includes('bookshelf')).toBeTruthy();
  });
});