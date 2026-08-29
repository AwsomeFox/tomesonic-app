#!/usr/bin/env bash
# CI entrypoint for the chapter-pause REPRO — a single line from
# reactivecircus/android-emulator-runner, same constraint as ci-flows.sh
# (the action runs each inline script line in its own shell).
#
# Deliberately NOT part of ci-flows.sh: this is a diagnostic rig dispatched
# by hand while the bug is being pinned down, not a gate.
#
# Dimensions, in order:
#   0.  chapter-storm.yaml    — the reported book's shape (102-chapter m4b),
#                               streamed then downloaded, 1.5x + voice boost,
#                               skip storms. Green as of run 16.
#   0.5 chapter-throttle.yaml — the same shape STREAMED over a shaped slow
#                               link (adb emu network), cold source opens at
#                               every boundary. The unifying suspect: the
#                               reporter was unknowingly streaming.
#   1.  chapter-pause.yaml    — FOREGROUND boundary crossings, both queue
#                               shapes, downloaded. Green since run 4; the
#                               rig's regression floor.
#   2.  doze-boundary-*.yaml  — a boundary crossed while force-idled (the
#                               real listening condition), downloaded m4b.
#                               Maestro can't adb, so the doze sandwich
#                               lives here (ci-doze.sh's pattern).
#
# EVIDENCE GOES TO STDOUT, not artifacts: the action kills the emulator the
# moment this script exits non-zero (a post-step logcat reads an empty
# device), and artifact downloads are blocked from the diagnosing session's
# network. Everything needed to act on a failure prints here, INSIDE the
# step, while the emulator is still alive.
set -uo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

set -e
adb install android/app/build/outputs/apk/release/app-release.apk

# Login THROUGH the toxiproxy relay (13379 -> abs:80): transparent at full
# speed until the throttle leg turns its toxics on.
maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL=http://10.0.2.2:13379 -e ABS_USER=root -e ABS_PASS=testpass

# Match the reporting user's REAL settings: skip silence OFF (they confirmed
# it off and still failing — run 9 tested the on-state), voice boost ON.
maestro test .maestro/repro/enable-voice-boost.yaml

# Clean slate so the dump below holds ONLY the repro window — and a buffer
# big enough to actually hold it: the default 256K ring wrapped over run
# 14's 30 minutes and evicted the very moment the run existed to capture.
adb logcat -G 16M || true
adb logcat -c || true
set +e

rc=0

# POSITION TIMELINE: 2s samples of the media session's playback state while
# the flows run — the ground truth that separates a real transition stall
# from Maestro assert latency (it dissolved runs 1-6's "early flip" reading).
# dumpsys media_session prints the state=/position= pushed at each discrete
# player state change.
POS_LOG="$HOME/pos-samples.log"
: > "$POS_LOG"
(
  while true; do
    ts=$(date +%H:%M:%S)
    line=$(adb shell dumpsys media_session 2>/dev/null \
      | grep -E "state=PlaybackState" | head -1 | tr -s ' ')
    echo "POS $ts $line" | tee -a "$POS_LOG"
    sleep 2
  done
) &
SAMPLER_PID=$!

echo "########## dimension 0: the reported book's shape (102-chapter m4b) ##########"
maestro test .maestro/repro/chapter-storm.yaml || rc=$?

echo "########## dimension 0.5: streamed boundaries over a SLOW server ##########"
# The reported case is a big m4b streamed from a remote server. Every
# chapter transition cold-opens the HTTP source (each clipped item is its
# own ProgressiveMediaSource, no shared cache) and the fixture — like most
# real m4b rips — keeps moov at the END of the file, so a transition costs
# several round trips before audio. Run 18 proved `adb emu network` never
# shapes the 10.0.2.2 loopback path (8.0s transitions and 2.7s cold seeks
# under a supposed 62KB/s+0.65s link), so the slowness is server-side now:
# latency+bandwidth toxics on the toxiproxy relay the app is logged in
# through. The gate MEASURES a proxied request — a shaping that doesn't
# demonstrably bite must not no-op-pass.
docker exec toxiproxy /toxiproxy-cli toxic add -n slow_lat -t latency \
  -a latency=800 -a jitter=200 --downstream abs_slow || true
# rate=24, down from 64: run 20 sat exactly AT the preload break-even —
# the next clipped item costs ~510KB (tail moov ~400KB + 12s clip ~110KB)
# per 8s chapter window, and 64KB/s delivered it just in time, so natural
# boundaries stayed at a clean 8.0s while cold seeks paid 4-6s and the
# initial open 37s. At 24KB/s the preload needs ~21s per 8s window and
# CANNOT keep up, so every natural boundary must audibly stall (~13s) —
# the report, verbatim — while steady-state audio (74kbps x 1.5 =
# 13.9KB/s) still fits.
docker exec toxiproxy /toxiproxy-cli toxic add -n slow_bw -t bandwidth \
  -a rate=24 --downstream abs_slow || true
t=$(curl -o /dev/null -s -w '%{time_total}' --max-time 20 http://localhost:13379/status || echo 0)
echo "proxied /status with toxics on: ${t}s"
# Threshold sits BELOW the toxic's jitter floor (800-200=600ms): run 19's
# gate demanded 0.5s against a 600±200 toxic and a 0.492s draw killed an
# honestly-shaped leg by 8ms.
if awk -v t="$t" 'BEGIN{exit !(t >= 0.4)}'; then
  maestro test .maestro/repro/chapter-throttle.yaml || rc=$?

  if [ "$rc" -eq 0 ]; then
    echo "########## dimension 0.6: link flaps at a cold boundary open ##########"
    # Runs 20-21 proved the streamed transition machinery survives honest
    # slowness (the 256MB shared cache defuses the per-boundary moov cost).
    # The surviving suspect for "sometimes it won't play again until
    # killing the app" is what happens when the strained link DROPS: the
    # store's retry ladder is bounded (2s/10s/30s) and WiFi never flaps,
    # so nothing else ever re-fires. Flap A must self-recover (a rung
    # lands after the link returns); flap B outlasts the ladder and the
    # manual Play in the assert flow must bring playback back.
    maestro test .maestro/repro/throttle-flap-start.yaml || rc=$?
    if [ "$rc" -eq 0 ]; then
      echo "== flap A: 40s blackhole (ladder's last rung lands after restore) =="
      docker exec toxiproxy /toxiproxy-cli toxic add -n flap -t timeout \
        -a timeout=0 --downstream abs_slow || true
      sleep 40
      docker exec toxiproxy /toxiproxy-cli toxic remove -n flap abs_slow || true
      echo "== flap A over; waiting out the retry ladder =="
      sleep 60
      last=$(tail -n 1 "$POS_LOG")
      echo "post-flap-A session state: $last"
      if ! echo "$last" | grep -q "state=PLAYING"; then
        echo "::error::playback did NOT self-recover after a 40s flap the retry ladder should survive"
        rc=1
      else
        echo "== flap B: 100s blackhole (outlasts every retry rung) =="
        docker exec toxiproxy /toxiproxy-cli toxic add -n flap -t timeout \
          -a timeout=0 --downstream abs_slow || true
        sleep 100
        docker exec toxiproxy /toxiproxy-cli toxic remove -n flap abs_slow || true
        maestro test .maestro/repro/throttle-flap-assert.yaml || rc=$?
      fi
    fi
  fi
else
  echo "::error::toxics did not measurably slow the proxied request (${t}s) — the throttle leg cannot run honestly"
  rc=1
fi
# Toxics off whatever happened — the later dimensions download through the
# same relay and must get it at full speed.
docker exec toxiproxy /toxiproxy-cli toxic remove -n slow_lat abs_slow || true
docker exec toxiproxy /toxiproxy-cli toxic remove -n slow_bw abs_slow || true
echo "toxics removed; proxied /status: $(curl -o /dev/null -s -w '%{time_total}' --max-time 20 http://localhost:13379/status || echo '?')s"

echo "########## dimension 1: foreground boundary crossings ##########"
maestro test .maestro/repro/chapter-pause.yaml || rc=$?


if [ "$rc" -eq 0 ]; then
  echo "########## dimension 2: boundary crossed under doze ##########"
  maestro test .maestro/repro/doze-boundary-start.yaml || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "== entering doze across the 12s chapter boundaries =="
    adb shell dumpsys battery unplug || true      # deviceidle refuses while "charging"
    adb shell input keyevent KEYCODE_SLEEP || true # screen off, like a pocketed phone
    # deviceidle ships DISABLED on this emulator image: run 5's force-idle
    # answered "Unable to go deep idle; not enabled" — and because dumpsys
    # exits 0 even when it refuses, the leg green-passed without ever idling
    # (the uncaptured-failure hole Copilot flagged). Enable first, force, and
    # gate on the STATE READBACK — the only signal dumpsys can't fake.
    adb shell dumpsys deviceidle enable all || true
    adb shell dumpsys deviceidle force-idle || true
    deep=$(adb shell dumpsys deviceidle get deep | tr -d '[:space:]')
    echo "deviceidle deep state after force-idle: $deep"
    if [ "$deep" != "IDLE" ]; then
      echo "::error::doze sandwich never reached deep idle (state: $deep) — refusing to let the doze leg no-op-pass"
      rc=1
    else
      # The doze book is the 102-chapter Long Book now (run 18: the 75s
      # Chapter Book at the app-global 1.5x ran out DURING the assert phase
      # — a race run 16 happened to win). Its 12s chapters play in ~8s at
      # 1.5x, so this window crosses ~2 boundaries while idled, and the
      # book's end is minutes away from any resume point the earlier legs
      # can leave.
      sleep 15
      adb shell dumpsys deviceidle unforce || true
      echo "deviceidle deep state after unforce: $(adb shell dumpsys deviceidle get deep | tr -d '[:space:]')"
      adb shell dumpsys battery reset || true
      adb shell input keyevent KEYCODE_WAKEUP
      echo "== exited doze =="
      maestro test .maestro/repro/doze-boundary-assert.yaml || rc=$?
    fi
  fi
fi

# STOPPED-FINGERPRINT GATE (deterministic halted-at-boundary verdict): the
# session pushes NONE on a proper stop-and-close and PAUSED on a pause
# (run 15's timeline), so a STOPPED sample anywhere in the pipeline means
# the player halted at an item end — the reported symptom, or an unplanned
# queue end. Momentary Maestro asserts raced these windows (a failing
# extendedWaitUntil can give up 2.5s into a 15s timeout); this grep
# cannot. Covers everything now that the doze dimension runs on the
# 102-chapter book and can never legitimately reach its end (run 18: the
# 75s Chapter Book at the app-global 1.5x ran out mid-doze-assert).
if grep -q "state=STOPPED" "$POS_LOG"; then
  echo "::error::STOPPED sample during the pipeline — playback halted at an item boundary:"
  grep "state=STOPPED" "$POS_LOG" | head -5
  rc=1
fi

kill "$SAMPLER_PID" 2>/dev/null || true

echo "==================== repro evidence (exit $rc) ===================="
echo "-------------------- player logcat (filtered) ---------------------"
adb logcat -d 2>/dev/null \
  | grep -iE "ExoPlayer|TrackPlayer|CONSOLE|ReactNativeJS|AndroidRuntime|FATAL|PlaybackStore|deviceidle" \
  | tail -300
echo "-------------------- maestro debug files --------------------------"
find "$HOME/.maestro/tests" -type f 2>/dev/null | sort
latest=$(ls -td "$HOME"/.maestro/tests/*/ 2>/dev/null | head -1)
if [ -n "$latest" ]; then
  for f in "$latest"*.json "$latest"*.log; do
    [ -f "$f" ] || continue
    echo "---------- tail: $f ----------"
    tail -c 6000 "$f"
    echo
  done
  # The failure-step view hierarchies live one level down — the caption slot's
  # ACTUAL text at the moment an assert died is the answer to most "what did
  # the player show" questions, so extract just the caption-adjacent strings
  # instead of dumping whole trees.
  find "$latest" -path '*screen-hierarchy/*.json' -print | while read -r h; do
    echo "---------- caption region of: $h ----------"
    grep -oE '"(text|accessibilityText)"[[:space:]]*:[[:space:]]*"[^"]{0,120}"' "$h" \
      | grep -iE "chapter|pause|play|book|of [0-9]" | sort -u | head -40
  done
fi
echo "==================== end repro evidence ============================"
exit $rc
