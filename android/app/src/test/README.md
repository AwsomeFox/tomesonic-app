# Android Testing Framework

This directory contains comprehensive tests for the TomeSonic Android app components.

## Test Structure

### Unit Tests (`src/test/`)
- **MediaBrowserManagerTest.kt**: Tests media browsing functionality, Android Auto integration, and content organization
- **MediaManagerTest.kt**: Tests media management, caching, progress tracking, and server communication
- **PlayerNotificationServiceTest.kt**: Tests player service functionality, media sessions, and notifications
- **DataModelsTest.kt**: Tests data models and their relationships (Books, Podcasts, Libraries, etc.)

### Integration Tests (`src/androidTest/`)
- **TomesonicIntegrationTest.kt**: Integration tests that run on actual Android devices/emulators

### Test Utilities (`src/test/testutils/`)
- **TestDataFactory.kt**: Factory methods for creating test data objects

## Running Tests

### Local Development
```bash
# Run unit tests
./android/gradlew test

# Run instrumented tests (requires emulator/device)
./android/gradlew connectedAndroidTest

# Run specific test class
./android/gradlew test --tests="com.tomesonic.app.player.MediaBrowserManagerTest"

# Run with coverage
./android/gradlew testDebugUnitTestCoverage
```

### CI/CD
Tests are automatically run on pull requests via GitHub Actions (`.github/workflows/android-tests.yml`).

### Network Dependencies
**Note**: The tests require access to Google's Maven repositories (dl.google.com) for Android dependencies. In restricted network environments, tests may fail during the build phase. The GitHub Actions workflow is configured to handle this gracefully and will work in standard CI environments.

## Test Coverage Areas

### Media Browser Manager
- ✅ Android Auto client validation
- ✅ Browse tree initialization
- ✅ Book browsability logic (chapters required)
- ✅ Time formatting utilities
- ✅ Local content handling

### Media Manager
- ✅ Library management and caching
- ✅ Progress tracking and synchronization
- ✅ Collections and author management
- ✅ Server communication interfaces
- ✅ Android Auto data loading

### Player Service
- ✅ Service lifecycle management
- ✅ Media session handling
- ✅ Notification management
- ✅ Chapter navigation
- ✅ Custom action support

### Data Models
- ✅ Library items (books, podcasts)
- ✅ Media progress tracking
- ✅ Collections and authors
- ✅ Local content models
- ✅ User preferences

## Test Data Factory

The `TestDataFactory` provides convenient methods for creating test objects:

```kotlin
// Create test book with chapters
val book = TestDataFactory.createTestBook(numChapters = 5)

// Create test library item
val item = TestDataFactory.createTestLibraryItem(mediaType = "book")

// Create comprehensive test data for Android Auto
val (libraries, items, collections) = TestDataFactory.createAndroidAutoTestData()
```

## Mock Framework

Tests use Mockito for mocking dependencies:
- API handlers and network requests
- Device managers and storage
- Service dependencies
- External libraries

## Best Practices

1. **Use TestDataFactory**: Always use the factory for creating test objects
2. **Mock External Dependencies**: Mock API calls, file system, and device-specific functionality
3. **Test Edge Cases**: Include tests for empty states, error conditions, and boundary values
4. **Readable Test Names**: Use descriptive test method names with backticks
5. **Arrange-Act-Assert**: Follow the AAA pattern for clear test structure

## Adding New Tests

1. Create test class in appropriate package under `src/test/`
2. Use `@RunWith(RobolectricTestRunner::class)` for Android-dependent unit tests
3. Use `@RunWith(AndroidJUnit4::class)` for instrumented tests
4. Mock dependencies using `@Mock` annotations
5. Add test data factory methods for new models

## Troubleshooting

### Build Issues
If tests fail to build due to network restrictions:

1. **Environment Issue**: The build requires access to `dl.google.com` for Android dependencies
2. **CI Environment**: Tests will work normally in GitHub Actions and standard CI environments
3. **Local Workaround**: Ensure you have internet access and try running `./gradlew build` first
4. **Offline Mode**: Use `--offline` flag if dependencies are already cached

### Test Validation
Even without running tests, you can validate the test framework:

```bash
# Check test files exist and have content
find android/app/src/test -name "*.kt" -type f -exec wc -l {} +

# Verify test structure
grep -r "@Test" android/app/src/test --include="*.kt" | wc -l
```

## Continuous Integration

The GitHub Actions workflow:
- Runs on every PR affecting Android code
- Executes both unit and instrumented tests
- Generates test reports and uploads artifacts
- Runs Android Lint for code quality
- Caches dependencies for faster builds
- Handles network dependency issues gracefully

Tests help ensure:
- Media playback functionality works correctly
- Android Auto integration remains stable
- Data models handle edge cases properly
- Network and offline scenarios are covered
- UI components respond appropriately to state changes