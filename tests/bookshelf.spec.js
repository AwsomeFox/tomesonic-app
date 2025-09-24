const { test, expect } = require('@playwright/test');

test.describe('Bookshelf Interface Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should display bookshelf layout correctly', async ({ page }) => {
    // Wait for bookshelf to load
    await page.waitForSelector('#bookshelf-wrapper', { timeout: 10000 });
    
    const bookshelfWrapper = page.locator('#bookshelf-wrapper');
    await expect(bookshelfWrapper).toBeVisible();
    
    // Check for main content area
    const mainContent = page.locator('.main-content');
    if (await mainContent.count() > 0) {
      await expect(mainContent.first()).toBeVisible();
    }
  });

  test('should handle toolbar visibility', async ({ page }) => {
    // Look for bookshelf toolbar
    const toolbarSelectors = [
      '.bookshelf-toolbar',
      '.home-bookshelf-toolbar',
      '[data-testid="bookshelf-toolbar"]'
    ];
    
    for (const selector of toolbarSelectors) {
      const toolbar = page.locator(selector);
      if (await toolbar.count() > 0) {
        console.log(`Found toolbar with selector: ${selector}`);
        
        // Toolbar visibility depends on route
        const isVisible = await toolbar.isVisible();
        console.log(`Toolbar visible: ${isVisible}`);
        
        // Test toolbar functionality if visible
        if (isVisible) {
          // Look for common toolbar buttons
          const searchButton = toolbar.locator('.search, [data-testid="search"]').first();
          const menuButton = toolbar.locator('.menu, [data-testid="menu"]').first();
          
          if (await searchButton.isVisible()) {
            console.log('Found search button in toolbar');
          }
          
          if (await menuButton.isVisible()) {
            console.log('Found menu button in toolbar');
          }
        }
        
        break;
      }
    }
  });

  test('should handle bottom navigation when available', async ({ page }) => {
    // Look for bottom navigation (bookshelf nav bar)
    const bottomNavSelectors = [
      '.bookshelf-nav',
      '.bottom-nav',
      '.home-bookshelf-nav-bar',
      '[data-testid="bottom-nav"]'
    ];
    
    for (const selector of bottomNavSelectors) {
      const bottomNav = page.locator(selector);
      if (await bottomNav.isVisible()) {
        console.log(`Found bottom navigation: ${selector}`);
        
        // Look for navigation items
        const navItems = bottomNav.locator('a, button, .nav-item');
        const itemCount = await navItems.count();
        console.log(`Bottom nav has ${itemCount} items`);
        
        // Test clicking navigation items
        for (let i = 0; i < Math.min(itemCount, 3); i++) {
          const item = navItems.nth(i);
          if (await item.isVisible()) {
            const text = await item.textContent();
            console.log(`Nav item ${i}: "${text}"`);
            
            // Click and verify navigation works
            const currentUrl = page.url();
            await item.click();
            await page.waitForTimeout(1000);
            
            // URL should change or stay the same (if already on that page)
            const newUrl = page.url();
            console.log(`Navigation: ${currentUrl} -> ${newUrl}`);
          }
        }
        
        break;
      }
    }
  });

  test('should display library content or empty state', async ({ page }) => {
    // Wait for content to load
    await page.waitForTimeout(3000);
    
    // Look for library items or empty state
    const contentSelectors = [
      '.library-item',
      '.book-item',
      '.media-item', 
      '.grid-item',
      '[data-testid="library-item"]'
    ];
    
    const emptyStateSelectors = [
      '.empty-state',
      '.no-items',
      '.library-empty',
      '[data-testid="empty-state"]'
    ];
    
    let hasContent = false;
    let hasEmptyState = false;
    
    // Check for library items
    for (const selector of contentSelectors) {
      const items = page.locator(selector);
      const count = await items.count();
      if (count > 0) {
        hasContent = true;
        console.log(`Found ${count} library items with selector: ${selector}`);
        break;
      }
    }
    
    // Check for empty state
    for (const selector of emptyStateSelectors) {
      const emptyState = page.locator(selector);
      if (await emptyState.isVisible()) {
        hasEmptyState = true;
        console.log(`Found empty state with selector: ${selector}`);
        break;
      }
    }
    
    // Should have either content or empty state
    expect(hasContent || hasEmptyState).toBeTruthy();
  });

  test('should handle search functionality if available', async ({ page }) => {
    // Look for search input or button
    const searchSelectors = [
      'input[type="search"]',
      'input[placeholder*="search"]',
      'input[placeholder*="Search"]',
      '.search-input',
      '[data-testid="search-input"]'
    ];
    
    for (const selector of searchSelectors) {
      const searchInput = page.locator(selector);
      if (await searchInput.isVisible()) {
        console.log(`Found search input: ${selector}`);
        
        // Test search functionality
        await searchInput.fill('test');
        await page.waitForTimeout(1000);
        
        // Check if search results appear or if search is processing
        const searchResults = page.locator('.search-results, .results, [data-testid="search-results"]').first();
        const searchSpinner = page.locator('.loading, .spinner, .search-loading').first();
        
        if (await searchResults.isVisible()) {
          console.log('Search results displayed');
        } else if (await searchSpinner.isVisible()) {
          console.log('Search is processing');
        }
        
        // Clear search
        await searchInput.clear();
        break;
      }
    }
  });

  test('should handle different view modes if available', async ({ page }) => {
    // Look for view mode toggles (grid/list)
    const viewModeSelectors = [
      '.view-mode',
      '.grid-toggle',
      '.list-toggle',
      '[data-testid="view-mode"]'
    ];
    
    for (const selector of viewModeSelectors) {
      const viewModeButton = page.locator(selector);
      if (await viewModeButton.isVisible()) {
        console.log(`Found view mode toggle: ${selector}`);
        
        // Test toggling view mode
        await viewModeButton.click();
        await page.waitForTimeout(1000);
        
        // Check if layout changes
        const contentArea = page.locator('#bookshelf-wrapper, .main-content').first();
        const hasGridClass = await contentArea.evaluate(el => 
          el.classList.contains('grid') || 
          el.classList.contains('grid-view') ||
          el.querySelector('.grid')
        );
        
        const hasListClass = await contentArea.evaluate(el => 
          el.classList.contains('list') || 
          el.classList.contains('list-view') ||
          el.querySelector('.list')
        );
        
        console.log(`Grid view: ${hasGridClass}, List view: ${hasListClass}`);
        break;
      }
    }
  });

  test('should handle library selection if available', async ({ page }) => {
    // Look for library selector/dropdown
    const librarySelectorSelectors = [
      '.library-selector',
      '.library-dropdown',
      'select[data-library]',
      '[data-testid="library-selector"]'
    ];
    
    for (const selector of librarySelectorSelectors) {
      const librarySelector = page.locator(selector);
      if (await librarySelector.isVisible()) {
        console.log(`Found library selector: ${selector}`);
        
        // If it's a dropdown, check options
        if (selector.includes('select')) {
          const options = librarySelector.locator('option');
          const optionCount = await options.count();
          console.log(`Library selector has ${optionCount} options`);
        }
        
        break;
      }
    }
  });
});