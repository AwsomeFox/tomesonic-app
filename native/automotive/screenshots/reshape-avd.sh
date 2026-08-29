#!/usr/bin/env bash
# Reshape the freshly-created AVD's framebuffer before the emulator launches.
#
# A real file, not inline workflow lines, for the same reason capture.sh is:
# the emulator-runner action executes each inline script LINE in its own shell,
# so a multi-line `if` block dies as a syntax error — which is exactly how the
# first reshaped run failed its step while the capture itself sailed through.
#
# Usage: reshape-avd.sh [WxH]
#   empty/absent arg -> no-op (the landscape leg)
#   "800x1280"       -> Play's AAOS portrait floor (the portrait leg)
#
# Why config.ini and not a portrait device id: this runner's avdmanager has no
# automotive_portrait definition (run 1: `Error: No device found matching
# --device automotive_portrait`), and deterministic ini keys beat gambling on a
# user devices.xml schema. skin.name=WxH is the emulator's frameless-resolution
# form; the hw.lcd.* keys keep the framework's DisplayMetrics in agreement.
# Density stays the landscape device's own, so both legs render at one scale.
set -euo pipefail

reshape="${1:-}"
[ -z "$reshape" ] && exit 0

cfg="$HOME/.android/avd/test.avd/config.ini"
if [ ! -f "$cfg" ]; then
  echo "::error::reshape-avd.sh: $cfg not found — did the action's AVD name change from 'test'?"
  exit 1
fi

w="${reshape%x*}"
h="${reshape#*x}"
sed -i '/^skin\.name=/d;/^skin\.path=/d;/^hw\.lcd\.width=/d;/^hw\.lcd\.height=/d' "$cfg"
printf 'skin.name=%sx%s\nhw.lcd.width=%s\nhw.lcd.height=%s\n' "$w" "$h" "$w" "$h" >> "$cfg"
echo "reshaped $cfg to ${w}x${h}:"
grep -E '^(skin\.name|hw\.lcd\.)' "$cfg"
