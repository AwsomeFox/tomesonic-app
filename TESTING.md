# Playwright Testing Setup for TomeSonic

This document provides instructions for setting up and running Playwright tests for the TomeSonic Nuxt.js application.

## Installation

### 1. Install Playwright package
```bash
npm install --save-dev @playwright/test playwright
```

### 2. Install Playwright browsers
```bash
npx playwright install
```

If you encounter issues with browser installation, try:
```bash
# Install system dependencies first
npx playwright install-deps

# Then install browsers
npx playwright install chromium firefox webkit
```

### 3. For CI/CD environments
In GitHub Actions or other CI environments, use:
```bash
npx playwright install --with-deps
```

## Project Structure

```
tests/
├── README.md                 # Testing documentation
├── app.spec.js              # Core application tests
├── navigation.spec.js       # Navigation and routing tests  
├── audio-player.spec.js     # Audio player component tests
├── bookshelf.spec.js        # Bookshelf interface tests
└── error-handling.spec.js   # Error handling and edge cases
playwright.config.js         # Playwright configuration
.github/workflows/playwright.yml  # CI workflow
```

## Configuration

The `playwright.config.js` file configures:
- Test directory: `./tests`
- Base URL: `http://localhost:1337` (Nuxt dev server)
- Multiple browser projects (Chromium, Firefox, WebKit)
- Mobile viewports (Pixel 5, iPhone 12)
- Automatic dev server startup
- Test reporting and artifacts

## Running Tests

### Development
```bash
# Run all tests (headless)
npm run test

# Run with visible browser
npm run test:headed

# Interactive test runner
npm run test:ui

# Debug mode (step through tests)
npm run test:debug

# Show test report
npm run test:report
```

### Advanced Usage
```bash
# Run specific test file
npx playwright test app.spec.js

# Run specific browser
npx playwright test --project=chromium

# Run mobile tests only
npx playwright test --project="Mobile Chrome"

# Run with custom grep pattern
npx playwright test --grep "navigation"

# Run tests in parallel
npx playwright test --workers=4
```

## Test Categories

### 🧪 Core Application Tests
- Application startup and initialization
- Page title and basic structure verification
- Material 3 design system integration
- Responsive behavior across viewports

### 🧭 Navigation Tests
- Inter-page navigation functionality
- Page transition animations
- Side drawer/menu interactions
- Browser history handling

### 🎵 Audio Player Tests
- Player component structure and visibility
- Control button functionality
- Volume controls and media session API
- Fullscreen player behavior

### 📚 Bookshelf Interface Tests
- Layout rendering and component visibility
- Toolbar and navigation behavior
- Library content display
- Search and filtering capabilities
- View mode toggles (grid/list)

### 🚨 Error Handling Tests
- Network disconnection scenarios
- Invalid route handling
- Performance under load
- Console error detection
- Accessibility compliance
- Cross-device compatibility

## Customization

### Adding New Tests
1. Create a new `.spec.js` file in the `tests/` directory
2. Follow the existing pattern:
   ```javascript
   const { test, expect } = require('@playwright/test');
   
   test.describe('Feature Tests', () => {
     test.beforeEach(async ({ page }) => {
       await page.goto('/');
     });
     
     test('should test feature', async ({ page }) => {
       // Test implementation
     });
   });
   ```

### Modifying Configuration
Edit `playwright.config.js` to:
- Change base URL or port
- Add/remove browser projects
- Adjust timeouts and retries
- Configure reporters and artifacts

### Adding Test Data Attributes
For more reliable element selection, add `data-testid` attributes to components:
```vue
<template>
  <button data-testid="play-button" @click="play">
    Play
  </button>
</template>
```

## Continuous Integration

The included GitHub Actions workflow (`.github/workflows/playwright.yml`) automatically:
- Runs tests on push/PR to main branches
- Installs dependencies and browsers
- Executes full test suite
- Uploads test reports as artifacts

### Customizing CI
- Adjust trigger branches in the workflow file
- Add environment-specific test commands
- Configure test result notifications
- Set up test result reporting integrations

## Troubleshooting

### Common Issues

**Browser installation fails:**
```bash
# Clear npm cache and reinstall
npm cache clean --force
npm install
npx playwright install --force
```

**Tests timeout:**
- Increase timeout in `playwright.config.js`
- Add explicit waits: `await page.waitForSelector()`
- Use `page.waitForLoadState('networkidle')`

**Element not found:**
- Use multiple selector strategies
- Add `data-testid` attributes
- Wait for elements with proper timeout

**Flaky tests:**
- Add better wait conditions
- Use `expect().toBeVisible()` instead of existence checks
- Implement retry logic for unstable operations

### Debugging Tips

1. **Visual debugging:** Use `--headed` flag to see browser
2. **Screenshots:** Add `await page.screenshot()` in tests
3. **Console logs:** Check browser console with `page.on('console')`
4. **Network monitoring:** Use `page.on('request')` and `page.on('response')`
5. **Step-by-step:** Use `--debug` flag for interactive debugging

### Performance Optimization

- Run tests in parallel with `--workers=N`
- Use `--shard=M/N` for distributed testing
- Skip expensive operations in non-critical tests
- Use `page.waitForLoadState('domcontentloaded')` instead of `networkidle` when appropriate

## Best Practices

1. **Test Structure:** Keep tests focused and independent
2. **Wait Strategies:** Always wait for elements before interaction
3. **Error Handling:** Include proper error handling and cleanup
4. **Assertions:** Use meaningful assertions with good error messages
5. **Test Data:** Use realistic test data that matches production scenarios
6. **Page Objects:** Consider page object pattern for complex applications
7. **Accessibility:** Include accessibility checks in critical user journeys

## Resources

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Nuxt.js Testing Guide](https://nuxtjs.org/docs/get-started/testing)
- [Material 3 Testing Patterns](https://m3.material.io/foundations/interaction/testing)
- [GitHub Actions for Playwright](https://playwright.dev/docs/ci-intro)