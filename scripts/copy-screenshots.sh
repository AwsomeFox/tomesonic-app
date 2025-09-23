#!/bin/bash

# Script to copy and organize TomeSonic app screenshots
# Run this script to copy screenshots from Downloads to the project

DOWNLOADS_DIR="/Users/anthonyanderson/Downloads/AppMockUp Screenshots"
SCREENSHOTS_DIR="./screenshots"

echo "🔄 Copying TomeSonic app screenshots..."

# Create screenshots directory if it doesn't exist
mkdir -p "$SCREENSHOTS_DIR"

# Check if source directory exists
if [ ! -d "$DOWNLOADS_DIR" ]; then
    echo "❌ Source directory not found: $DOWNLOADS_DIR"
    echo "Please ensure the AppMockUp Screenshots folder is in your Downloads directory"
    exit 1
fi

# Copy all images from Downloads to screenshots directory
echo "📁 Copying screenshots from: $DOWNLOADS_DIR"
echo "📁 To: $SCREENSHOTS_DIR"

# Copy all image files
cp "$DOWNLOADS_DIR"/*.png "$SCREENSHOTS_DIR/" 2>/dev/null || true
cp "$DOWNLOADS_DIR"/*.jpg "$SCREENSHOTS_DIR/" 2>/dev/null || true
cp "$DOWNLOADS_DIR"/*.jpeg "$SCREENSHOTS_DIR/" 2>/dev/null || true

# List what was copied
echo "✅ Screenshots copied:"
ls -la "$SCREENSHOTS_DIR"/ | grep -E '\.(png|jpg|jpeg)$' | wc -l | xargs echo "   Total image files:"

# Create a combined showcase image if multiple screenshots exist
if [ $(ls "$SCREENSHOTS_DIR"/*.png 2>/dev/null | wc -l) -gt 1 ]; then
    echo "💡 Consider creating a combined showcase image named 'tomesonic-app-showcase.png'"
    echo "   This will be used as the main screenshot in the README"
fi

echo "🎉 Screenshot setup complete!"
echo ""
echo "Next steps:"
echo "1. Review the copied screenshots in the screenshots/ directory"
echo "2. Optionally create a combined showcase image named 'tomesonic-app-showcase.png'"
echo "3. Update the README if needed to reference specific screenshot files"
echo "4. Commit the new screenshots to git"