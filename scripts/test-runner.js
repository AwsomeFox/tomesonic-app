#!/usr/bin/env node

/**
 * Smart test runner for TomeSonic Playwright tests
 * Handles browser installation issues and provides helpful error messages
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Check if browsers are installed
function checkBrowsersInstalled() {
  try {
    const result = execSync('npx playwright --version', { encoding: 'utf8' });
    console.log(`✅ Playwright installed: ${result.trim()}`);
    
    // Try to check if browsers are installed by looking for the cache directory
    const homeDir = require('os').homedir();
    const playwrightCache = path.join(homeDir, '.cache', 'ms-playwright');
    
    if (fs.existsSync(playwrightCache)) {
      const browsers = fs.readdirSync(playwrightCache).filter(dir => 
        dir.includes('chromium') || dir.includes('firefox') || dir.includes('webkit')
      );
      
      if (browsers.length > 0) {
        console.log(`✅ Found browsers: ${browsers.join(', ')}`);
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('❌ Playwright not installed or not working:', error.message);
    return false;
  }
}

// Install browsers with better error handling
async function installBrowsers() {
  console.log('🔄 Installing Playwright browsers...');
  
  return new Promise((resolve, reject) => {
    const installProcess = spawn('npx', ['playwright', 'install', 'chromium'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    installProcess.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data);
    });
    
    installProcess.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    // Timeout after 2 minutes
    const timeout = setTimeout(() => {
      installProcess.kill();
      reject(new Error('Browser installation timed out after 2 minutes'));
    }, 120000);
    
    installProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        console.log('✅ Browsers installed successfully');
        resolve();
      } else {
        reject(new Error(`Browser installation failed with code ${code}\nStderr: ${stderr}`));
      }
    });
    
    installProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// Run tests with proper error handling
async function runTests() {
  const args = process.argv.slice(2);
  const testCommand = args.length > 0 ? args : ['--project=chromium'];
  
  console.log('🧪 Running Playwright tests...');
  
  return new Promise((resolve, reject) => {
    const testProcess = spawn('npx', ['playwright', 'test', ...testCommand], {
      stdio: 'inherit'
    });
    
    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      testProcess.kill();
      reject(new Error('Tests timed out after 5 minutes'));
    }, 300000);
    
    testProcess.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code === 0) {
        console.log('✅ Tests completed successfully');
        resolve();
      } else {
        reject(new Error(`Tests failed with code ${code}`));
      }
    });
    
    testProcess.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

// Main execution
async function main() {
  try {
    console.log('🚀 TomeSonic Playwright Test Runner');
    console.log('=====================================');
    
    // Check if browsers are installed
    const browsersInstalled = checkBrowsersInstalled();
    
    if (!browsersInstalled) {
      console.log('⚠️  Browsers not found. Attempting to install...');
      
      try {
        await installBrowsers();
      } catch (error) {
        console.error('❌ Failed to install browsers:', error.message);
        console.log('\n💡 Manual installation options:');
        console.log('   1. Run: npm run test:install');
        console.log('   2. Run: npx playwright install chromium');
        console.log('   3. If behind firewall/proxy, check network settings');
        console.log('\n🔄 Alternative: Run basic tests without full browser:');
        console.log('   npx playwright test basic-functionality.spec.js');
        process.exit(1);
      }
    }
    
    // Run the tests
    await runTests();
    
  } catch (error) {
    console.error('❌ Test execution failed:', error.message);
    
    console.log('\n💡 Troubleshooting tips:');
    console.log('   • Check if dev server is running: npm run dev');
    console.log('   • Try running single test: npx playwright test basic-functionality.spec.js');
    console.log('   • Check browsers: npx playwright --version');
    console.log('   • View logs: npm run test:debug');
    
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { checkBrowsersInstalled, installBrowsers, runTests };