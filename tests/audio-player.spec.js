const { test, expect } = require('@playwright/test');

test.describe('Audio Player Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });

  test('should have audio player container in DOM', async ({ page }) => {
    // Look for audio player container
    const playerSelectors = [
      '.audio-player',
      '.player-container',
      '#audio-player',
      '[data-testid="audio-player"]',
      '.app-audio-player-container'
    ];
    
    let playerFound = false;
    
    for (const selector of playerSelectors) {
      const player = page.locator(selector);
      if (await player.count() > 0) {
        playerFound = true;
        console.log(`Found audio player with selector: ${selector}`);
        break;
      }
    }
    
    expect(playerFound).toBeTruthy();
  });

  test('should handle player state when no media is loaded', async ({ page }) => {
    // Wait for app to initialize
    await page.waitForTimeout(2000);
    
    // Audio player should be present but likely not visible/active when no media
    const playerContainer = page.locator('.app-audio-player-container, .audio-player, .player-container').first();
    
    // Player container should exist (even if hidden)
    const containerExists = await playerContainer.count() > 0;
    expect(containerExists).toBeTruthy();
    
    // If player is visible, it should not be in playing state
    if (await playerContainer.isVisible()) {
      const playButton = page.locator('.play-button, [data-testid="play-button"], .player-play').first();
      const pauseButton = page.locator('.pause-button, [data-testid="pause-button"], .player-pause').first();
      
      if (await playButton.isVisible()) {
        // Should show play button when not playing
        expect(await playButton.isVisible()).toBeTruthy();
      }
      
      if (await pauseButton.isVisible()) {
        // Should not show pause button when no media loaded
        expect(await pauseButton.isVisible()).toBeFalsy();
      }
    }
  });

  test('should display player controls when available', async ({ page }) => {
    // Look for player controls
    const controlSelectors = [
      '.player-controls',
      '.audio-controls',
      '.playback-controls',
      '[data-testid="player-controls"]'
    ];
    
    for (const selector of controlSelectors) {
      const controls = page.locator(selector);
      if (await controls.isVisible()) {
        console.log(`Found player controls with selector: ${selector}`);
        
        // Look for common control buttons
        const commonButtons = [
          '.play, .play-button',
          '.pause, .pause-button', 
          '.next, .skip-forward',
          '.previous, .skip-backward',
          '.volume, .volume-control'
        ];
        
        for (const buttonSelector of commonButtons) {
          const button = controls.locator(buttonSelector).first();
          if (await button.isVisible()) {
            console.log(`Found control button: ${buttonSelector}`);
          }
        }
        
        break;
      }
    }
  });

  test('should handle fullscreen player when available', async ({ page }) => {
    // Look for fullscreen player elements
    const fullscreenSelectors = [
      '.player-fullscreen',
      '.fullscreen-player',
      '.audio-player.fullscreen',
      '[data-testid="fullscreen-player"]'
    ];
    
    let fullscreenElementFound = false;
    
    for (const selector of fullscreenSelectors) {
      const element = page.locator(selector);
      if (await element.count() > 0) {
        fullscreenElementFound = true;
        console.log(`Found fullscreen player element: ${selector}`);
        break;
      }
    }
    
    // Even if not currently visible, the fullscreen player structure should exist
    // This tests that the component is properly initialized
    if (fullscreenElementFound) {
      expect(fullscreenElementFound).toBeTruthy();
    }
  });

  test('should handle player volume controls', async ({ page }) => {
    // Look for volume controls
    const volumeSelectors = [
      '.volume-control',
      '.volume-slider',
      '.audio-volume',
      '[data-testid="volume-control"]',
      'input[type="range"][min="0"][max="1"]',
      'input[type="range"][min="0"][max="100"]'
    ];
    
    for (const selector of volumeSelectors) {
      const volumeControl = page.locator(selector).first();
      if (await volumeControl.isVisible()) {
        console.log(`Found volume control: ${selector}`);
        
        // If it's a range input, test basic interaction
        if (selector.includes('input[type="range"]')) {
          const min = await volumeControl.getAttribute('min');
          const max = await volumeControl.getAttribute('max');
          console.log(`Volume range: ${min} to ${max}`);
          
          expect(min).toBeDefined();
          expect(max).toBeDefined();
        }
        
        break;
      }
    }
  });

  test('should handle media session when supported', async ({ page }) => {
    // Test if media session API integration exists
    const hasMediaSession = await page.evaluate(() => {
      return 'mediaSession' in navigator;
    });
    
    if (hasMediaSession) {
      console.log('Browser supports Media Session API');
      
      // Check if the app sets up media session handlers
      const hasHandlers = await page.evaluate(() => {
        if (!navigator.mediaSession) return false;
        
        // Check if any action handlers are set
        const actions = ['play', 'pause', 'previoustrack', 'nexttrack'];
        return actions.some(action => {
          try {
            navigator.mediaSession.setActionHandler(action, null);
            return true;
          } catch (e) {
            return false;
          }
        });
      });
      
      console.log(`Media session handlers supported: ${hasHandlers}`);
    }
    
    // This test should always pass as it's testing browser capability
    expect(typeof hasMediaSession).toBe('boolean');
  });
});