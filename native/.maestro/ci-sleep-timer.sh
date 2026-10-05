#!/usr/bin/env bash
# CI entrypoint for the BACKGROUND SLEEP-TIMER suite — a single line from
# reactivecircus/android-emulator-runner (it runs each inline script line in
# its own shell, so exports/cd don't survive across lines).
#
# WHY THIS EXISTS: "the sleep timer / end-of-chapter timer doesn't work". With
# the screen off Android stalls React Native's JS timers, so the store's 1s
# sleep interval stops ticking and the Media3 service's NATIVE enforcer is the
# only thing that pauses a pocketed phone. Jest can't exercise that, and the
# Maestro UI alone can't see it (the UI is asleep too) — so every verdict here
# comes from the REAL media session (`dumpsys media_session`: playback state,
# position, and the current chapter window's title), sampled every 2s while
# the device sits backgrounded / screen-off / in forced deep Doze.
#
# Fixture: "The Sleep Book" — one m4b, ten 180s chapters, each
# [40s tone][100s SILENCE][40s tone]. Skip silence is ON (setup.yaml), so a
# chapter plays in ~80s of wall time while its position covers 180s — the
# condition that pushed the old wall-clock end-of-chapter deadline more than a
# chapter past its target. (Run 1 used 60s chapters ≈ 20s of wall time, and
# Maestro's per-step latency let whole chapters play out before the device
# ever went to sleep.)
#
# Scenarios (one session, in order):
#   1. FIXED 1-minute timer, app backgrounded (HOME), screen on.
#   2. END OF CHAPTER, screen off + deep Doze.
#   3. END OF CHAPTER + a headset NEXT while the screen is off: the timer
#      follows the skip and pauses at the end of the chapter skipped INTO —
#      not at the old chapter's deadline, and not instantly after the skip.
#   4. STOP AFTER CHAPTER 9 (picked in Chapter 8), screen off + deep Doze.
#
# A chapter scenario only counts when the device was ALREADY asleep and
# playing at the first sample — a timer that fired in the foreground proves
# nothing about the background, so that is a failure ("void"), never a pass.
#
# EVIDENCE GOES TO STDOUT (the repro rig's lesson): the action kills the
# emulator the moment this script exits, so the samples and a filtered logcat
# print here while it is still alive.
set -uo pipefail

export PATH="$PATH:$HOME/.maestro/bin"
cd "$(dirname "$0")/.." # native/

SERVER_URL='http://10.0.2.2:13378'
SAMPLES="$HOME/sleep-samples.log"
ALL_SAMPLES="$HOME/sleep-samples-all.log"
: > "$ALL_SAMPLES"
rc=0

retry() {
  local n=0
  until "$@"; do
    n=$((n + 1))
    if [ "$n" -ge 3 ]; then
      echo "!! giving up after $n attempts: $*"
      return 1
    fi
    echo "!! retry $n: $*"
    sleep 5
  done
}

# One media-session snapshot: "<epoch>|<STATE>|<position ms>|<window title>".
# With the chapter-window presentation (ChapterForwardingPlayer) the session's
# position is CHAPTER-relative and its metadata title is the chapter — exactly
# the frame a "paused at the end of chapter N" verdict needs.
snap() {
  local out st pos desc
  out=$(adb shell dumpsys media_session 2>/dev/null)
  st=$(printf '%s\n' "$out" | grep -m1 -oE 'state=PlaybackState \{state=[A-Z_]+' | sed -E 's/.*state=//')
  pos=$(printf '%s\n' "$out" | grep -m1 -oE 'state=PlaybackState \{state=[A-Z_]+\([0-9]+\), position=-?[0-9]+' | sed -E 's/.*position=//')
  desc=$(printf '%s\n' "$out" | grep -m1 -oE 'metadata: size=[0-9]+, description=[^,]*' | sed -E 's/.*description=//')
  echo "$(date +%s)|${st:-?}|${pos:-?}|${desc:-?}"
}

# Sample the session every 2s for $1 seconds into $SAMPLES (and the run log).
# Optional: $2 = seconds into the window at which to run $3 (a command) once.
sample_for() {
  local secs="$1" at="${2:-}" cmd="${3:-}"
  local start now fired=0
  start=$(date +%s)
  : > "$SAMPLES"
  while true; do
    now=$(date +%s)
    [ $((now - start)) -ge "$secs" ] && break
    if [ -n "$at" ] && [ "$fired" -eq 0 ] && [ $((now - start)) -ge "$at" ]; then
      echo "== t+$((now - start))s: $cmd =="
      eval "$cmd"
      fired=1
    fi
    snap | tee -a "$SAMPLES" | sed 's/^/POS /'
    sleep 2
  done
  cat "$SAMPLES" >> "$ALL_SAMPLES"
}

# Screen off + forced deep Doze. deviceidle ships DISABLED on the runner's
# image and dumpsys exits 0 even when force-idle refuses — gate on the state
# READBACK (the only signal dumpsys can't fake), or the scenario is void.
sleep_device() {
  adb shell dumpsys battery unplug || true
  adb shell input keyevent KEYCODE_SLEEP || true
  adb shell dumpsys deviceidle enable all || true
  adb shell dumpsys deviceidle force-idle || true
  local deep
  deep=$(adb shell dumpsys deviceidle get deep | tr -d '[:space:]')
  echo "deviceidle deep state: $deep"
  if [ "$deep" != "IDLE" ]; then
    echo "::error::force-idle did not take (deep state: $deep) — the scenario would not prove anything"
    return 1
  fi
}

wake_device() {
  adb shell dumpsys deviceidle unforce || true
  adb shell dumpsys battery reset || true
  adb shell input keyevent KEYCODE_WAKEUP || true
  adb shell wm dismiss-keyguard || true
  sleep 2
}

field() { echo "$1" | cut -d'|' -f"$2"; }

CHAPTER_MS=180000
# "Chapter 7" -> "Chapter 8"
next_chapter() { echo "Chapter $(( ${1#Chapter } + 1 ))"; }

# The scenario is only meaningful if playback was still running when the
# device went to sleep (first sample PLAYING).
assert_started_asleep() {
  local name="$1" first st
  first=$(head -n 1 "$SAMPLES"); st=$(field "$first" 2)
  if [ "$st" != "PLAYING" ]; then
    echo "::error::[$name] VOID: already $st when the device went to sleep — the timer fired in the foreground, so this proves nothing about the background"
    rc=1
    return 1
  fi
}

# Verdict: playback is PAUSED at the end of chapter $2 — that chapter's window
# with the position inside its last 8s, or (overshoot tolerance) the very
# start of the next one — and it never PLAYED on into the next chapter (two or
# more PLAYING samples there ≈ seconds of it: the old wall-clock failure).
assert_paused_at_chapter_end() {
  local name="$1" chapter="$2" next last st pos desc played_on ok=1
  next=$(next_chapter "$chapter")
  last=$(tail -n 1 "$SAMPLES")
  st=$(field "$last" 2); pos=$(field "$last" 3); desc=$(field "$last" 4)
  played_on=$(grep -c "|PLAYING|[0-9-]*|${next}\$" "$SAMPLES" || true)
  echo "[$name] expected the end of '$chapter'; final: state=$st position=${pos}ms window='$desc' (PLAYING samples in '$next': $played_on)"
  [ "$st" = "PAUSED" ] || { echo "::error::[$name] expected PAUSED, got $st"; ok=0; }
  if [ "$desc" = "$chapter" ]; then
    [ "$pos" != "?" ] && [ "$pos" -ge $((CHAPTER_MS - 8000)) ] ||
      { echo "::error::[$name] paused in '$chapter' but at ${pos}ms — not at its end"; ok=0; }
  elif [ "$desc" = "$next" ]; then
    [ "$pos" != "?" ] && [ "$pos" -le 1500 ] ||
      { echo "::error::[$name] paused ${pos}ms into '$next' — played past the end of '$chapter'"; ok=0; }
  else
    echo "::error::[$name] paused in '$desc', expected the end of '$chapter'"
    ok=0
  fi
  [ "${played_on:-0}" -lt 2 ] ||
    { echo "::error::[$name] kept PLAYING into '$next' ($played_on samples)"; ok=0; }
  if [ "$ok" -eq 1 ]; then echo "[$name] PASS"; else rc=1; fi
}

# Verdict for the fixed timer: it pauses — and stays paused — within a minute
# of arming. The arm tap PRECEDES $2 (the flow's return) by Maestro's step
# latency, so the bound is "<= 62s after return", not "~60s".
assert_fixed_paused() {
  local name="$1" armed_at="$2" first_paused t elapsed last st
  first_paused=$(grep -m1 "|PAUSED|" "$SAMPLES" || true)
  last=$(tail -n 1 "$SAMPLES"); st=$(field "$last" 2)
  if [ -z "$first_paused" ]; then
    echo "::error::[$name] never paused (final state $st)"
    rc=1
    return
  fi
  t=$(field "$first_paused" 1)
  elapsed=$((t - armed_at))
  echo "[$name] paused ${elapsed}s after the arm flow returned; final state $st"
  if [ "$elapsed" -gt 62 ] || [ "$st" != "PAUSED" ]; then
    echo "::error::[$name] expected a pause within a minute of arming that stays paused (got ${elapsed}s, final $st)"
    rc=1
  elif [ "$(field "$(head -n 1 "$SAMPLES")" 2)" != "PLAYING" ]; then
    echo "::error::[$name] VOID: already paused when the app went to the background"
    rc=1
  else
    echo "[$name] PASS"
  fi
}

prepare() { # RESUME CHAPTER MODE TARGET
  maestro test .maestro/sleep/prepare.yaml \
    -e RESUME="$1" -e CHAPTER="$2" -e MODE="$3" -e TARGET="$4"
}

set -e
adb install android/app/build/outputs/apk/release/app-release.apk
retry maestro test .maestro/flows/10-login.yaml \
  -e SERVER_URL="$SERVER_URL" -e ABS_USER=root -e ABS_PASS=testpass
retry maestro test .maestro/sleep/setup.yaml
adb logcat -G 16M || true
adb logcat -c || true
set +e

echo "########## 1. fixed 1-minute timer, app backgrounded (HOME) ##########"
if maestro test .maestro/sleep/start.yaml && prepare 0 none fixed none; then
  armed_at=$(date +%s)
  adb shell input keyevent KEYCODE_HOME
  sample_for 90
  assert_fixed_paused "fixed-1min-background" "$armed_at"
else
  echo "::error::scenario 1 setup flow failed"
  rc=1
fi

echo "########## 2. end of chapter, screen off + deep Doze ##########"
wake_device
if prepare 1 "Chapter 3" eoc none; then
  if sleep_device; then
    # The chapter playing at the first (asleep) sample is the one armed;
    # at most ~80s of wall time to its end. 110s would carry the OLD
    # wall-clock deadline more than a chapter further.
    sample_for 110
    if assert_started_asleep "eoc-doze"; then
      assert_paused_at_chapter_end "eoc-doze" "$(field "$(head -n 1 "$SAMPLES")" 4)"
    fi
  else
    rc=1
  fi
else
  echo "::error::scenario 2 setup flow failed"
  rc=1
fi

echo "########## 3. end of chapter + headset NEXT with the screen off ##########"
wake_device
if prepare 1 "Chapter 5" eoc none; then
  if sleep_device; then
    # NEXT 8s in, dispatched to the media session like a headset button.
    # The timer must follow the skip to the END of the chapter skipped
    # into — not pause right after the skip (a target left behind at the
    # old chapter's end), and not run on to the old deadline.
    sample_for 120 8 "adb shell cmd media_session dispatch next || adb shell input keyevent KEYCODE_MEDIA_NEXT"
    if assert_started_asleep "eoc-remote-next"; then
      armed_in=$(field "$(head -n 1 "$SAMPLES")" 4)
      skipped_to=$(next_chapter "$armed_in")
      if grep -q "|${skipped_to}\$" "$SAMPLES"; then
        assert_paused_at_chapter_end "eoc-remote-next" "$skipped_to"
      else
        echo "::error::[eoc-remote-next] the NEXT key never moved playback off '$armed_in' — the scenario couldn't run"
        rc=1
      fi
    fi
  else
    rc=1
  fi
else
  echo "::error::scenario 3 setup flow failed"
  rc=1
fi

echo "########## 4. stop after Chapter 9 (picked in Chapter 8), screen off + deep Doze ##########"
wake_device
if prepare 1 "Chapter 8" until "Chapter 9"; then
  if sleep_device; then
    # Up to ~80s left of Chapter 8 plus ~80s of Chapter 9 — and the
    # Chapter 8 → 9 boundary on the way must NOT pause.
    sample_for 180
    if assert_started_asleep "stop-after-chapter"; then
      assert_paused_at_chapter_end "stop-after-chapter" "Chapter 9"
      if grep -q "|PAUSED|[0-9-]*|Chapter 8\$" "$SAMPLES"; then
        echo "::error::[stop-after-chapter] paused in Chapter 8 — the picked target is Chapter 9"
        rc=1
      fi
    fi
  else
    rc=1
  fi
else
  echo "::error::scenario 4 setup flow failed"
  rc=1
fi

wake_device
# The JS side mirrored the last native pause (chip gone, paused).
maestro test .maestro/sleep/verify-paused.yaml || rc=1

echo "==================== sleep-timer evidence (exit $rc) ===================="
echo "-------------------- all media-session samples --------------------"
cat "$ALL_SAMPLES"
echo "-------------------- logcat (filtered) ----------------------------"
timeout 60 adb logcat -d 2>/dev/null |
  grep -iE "sleep timer|ABS sleep|PlaybackStore|PlaybackService|deviceidle|AndroidRuntime|FATAL" |
  tail -200
echo "==================== end sleep-timer evidence ============================"
exit $rc
