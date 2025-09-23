# Playwright Testing for TomeSonic

This directory contains end-to-end tests for the TomeSonic Nuxt.js application using Playwright.

## Test Overview

The test suite covers the following areas:

### 📱 Core Application Tests (`app.spec.js`)
- Application loading and initialization
- Page title and basic structure
- Material 3 design system integration
- Responsive design across different viewports

### 🧭 Navigation Tests (`navigation.spec.js`)
- Navigation between main sections
- Page transition animations
- Side drawer/menu functionality
- Browser back navigation handling

### 🎵 Audio Player Tests (`audio-player.spec.js`)
- Audio player component presence and structure
- Player controls functionality
- Fullscreen player handling
- Volume controls and media session integration

### 📚 Bookshelf Interface Tests (`bookshelf.spec.js`)
- Bookshelf layout and component rendering
- Toolbar visibility and functionality
- Bottom navigation (when available)
- Library content display and empty states
- Search functionality
- View mode toggles (grid/list)
- Library selection

### 🚨 Error Handling Tests (`error-handling.spec.js`)
- Network disconnection handling
- Invalid route navigation
- Slow loading scenarios
- Console and JavaScript error detection
- Different screen size compatibility
- Performance and memory testing
- Basic accessibility requirements

## Running Tests

### Prerequisites
```bash
npm install
npx playwright install
```

### Basic Test Commands

```bash
# Run all tests
npm run test

# Run tests with visible browser
npm run test:headed

# Run tests with Playwright UI
npm run test:ui

# Debug tests step by step
npm run test:debug

# Show test report
npm run test:report
```

### Advanced Test Commands

```bash
# Run specific test file
npx playwright test app.spec.js

# Run tests in specific browser
npx playwright test --project=chromium

# Run tests on mobile viewport
npx playwright test --project="Mobile Chrome"

# Run tests with custom timeout
npx playwright test --timeout=60000
```

## Test Configuration

The tests are configured in `playwright.config.js` with the following settings:

- **Base URL**: `http://localhost:1337` (Nuxt dev server)
- **Browsers**: Chromium, Firefox, WebKit
- **Mobile**: Pixel 5, iPhone 12
- **Parallel execution**: Enabled for faster test runs
- **Automatic dev server**: Starts Nuxt dev server before tests

## CI/CD Integration

Tests run automatically on:
- Push to main/master/develop branches
- Pull requests
- Manual workflow dispatch

Results are uploaded as artifacts for review.

## Writing New Tests

### Test Structure
```javascript
const { test, expect } = require('@playwright/test');

test.describe('Feature Name Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should test specific functionality', async ({ page }) => {
    // Test implementation
    await expect(page).toHaveTitle('TomeSonic');
  });
});
```

### Best Practices

1. **Wait for elements**: Use `page.waitForSelector()` or `expect().toBeVisible()`
2. **Handle timeouts**: Set appropriate timeouts for slow operations
3. **Test multiple scenarios**: Cover both success and error cases
4. **Use data attributes**: Add `data-testid` attributes for reliable element selection
5. **Keep tests focused**: Each test should verify one specific behavior
6. **Clean up**: Use `beforeEach` and `afterEach` for test isolation

### Common Selectors

The tests use various selector strategies to find elements:
- **ID selectors**: `#bookshelf-wrapper`, `#content`
- **Class selectors**: `.audio-player`, `.bookshelf-nav`
- **Data attributes**: `[data-testid="element"]`
- **Semantic selectors**: `nav`, `main`, `button`
- **Text content**: `page.locator('text="Search"')`

## Debugging Tests

### Visual Debugging
```bash
# Run with headed browser to see what's happening
npm run test:headed

# Use Playwright UI for interactive debugging
npm run test:ui
```

### Console Output
Tests include detailed console logging to help understand:
- Which elements were found/not found
- Navigation state changes
- Performance metrics
- Error conditions

### Screenshots and Videos
Configure in `playwright.config.js` to capture:
- Screenshots on test failure
- Videos of test execution
- Traces for detailed debugging

## Maintenance

### Updating Tests
- Review tests when UI changes are made
- Update selectors if component structure changes
- Add new tests for new features
- Remove obsolete tests for removed features

### Performance Monitoring
- Monitor test execution time
- Update timeouts if app performance changes
- Add performance assertions for critical paths

## Troubleshooting

### Common Issues

1. **Element not found**: Check if selectors are correct and elements exist
2. **Timeouts**: Increase timeout values or improve waiting strategies
3. **Flaky tests**: Add better wait conditions and error handling
4. **Browser installation**: Run `npx playwright install` if browsers are missing

### Getting Help

- Check [Playwright documentation](https://playwright.dev/docs/intro)
- Review test output and error messages
- Use `--debug` flag for step-by-step debugging
- Check browser dev tools in headed mode