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
# Fixture: "The Sleep Book" — one m4b, ten 60s chapters, each
# [10s tone][40s SILENCE][10s tone]. Skip silence is ON (setup.yaml), so a
# chapter plays in ~22s of wall time while its position covers 60s — the
# condition that pushed the old wall-clock end-of-chapter deadline deep into
# the following chapters.
#
# Scenarios (one session, in order):
#   1. FIXED 1-minute timer, app backgrounded (HOME), screen on.
#   2. END OF CHAPTER, screen off + deep Doze: pause at the end of Chapter 4.
#   3. END OF CHAPTER + a headset NEXT while the screen is off: the timer
#      follows the skip and pauses at the end of the chapter skipped INTO —
#      not at the old chapter's deadline, and not instantly after the skip.
#   4. STOP AFTER CHAPTER 9 (picked from Chapter 8), screen off + deep Doze.
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

# Verdict: playback is PAUSED at the end of chapter $2 — the chapter window is
# $2 with the position inside its last 8s, or (overshoot tolerance) the very
# start of $3 — and it never PLAYED on into $3 (two or more PLAYING samples in
# it ≈ seconds of the next chapter, the old wall-clock failure).
assert_paused_at_chapter_end() {
  local name="$1" chapter="$2" next="$3"
  local last st pos desc played_on
  last=$(tail -n 1 "$SAMPLES")
  st=$(field "$last" 2); pos=$(field "$last" 3); desc=$(field "$last" 4)
  played_on=$(grep -c "|PLAYING|[0-9-]*|${next}\$" "$SAMPLES" || true)
  echo "[$name] final: state=$st position=${pos}ms window='$desc' (PLAYING samples in '$next': $played_on)"
  local ok=1
  [ "$st" = "PAUSED" ] || { echo "::error::[$name] expected PAUSED, got $st"; ok=0; }
  if [ "$desc" = "$chapter" ]; then
    [ "$pos" != "?" ] && [ "$pos" -ge 52000 ] ||
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
  [ "$ok" -eq 1 ] && echo "[$name] PASS" || rc=1
}

# Verdict for the fixed timer: the first PAUSED sample lands ~60s after arming
# (the arm tap precedes $2 by the flow's collapse steps; sampling is 2s).
assert_fixed_paused() {
  local name="$1" armed_at="$2"
  local first_paused t elapsed last st
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
  if [ "$elapsed" -lt 40 ] || [ "$elapsed" -gt 80 ] || [ "$st" != "PAUSED" ]; then
    echo "::error::[$name] expected a pause ~60s after arming that stays paused (got ${elapsed}s, final $st)"
    rc=1
  else
    echo "[$name] PASS"
  fi
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
if maestro test .maestro/sleep/start.yaml && maestro test .maestro/sleep/arm-fixed.yaml; then
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
if maestro test .maestro/sleep/resume.yaml &&
  maestro test .maestro/sleep/jump.yaml -e CHAPTER="Chapter 4" &&
  maestro test .maestro/sleep/arm-eoc.yaml; then
  if sleep_device; then
    # ~22s of wall time to the chapter end; 70s would carry the OLD
    # wall-clock deadline (~59s) two chapters further.
    sample_for 70
    assert_paused_at_chapter_end "eoc-doze" "Chapter 4" "Chapter 5"
  else
    rc=1
  fi
else
  echo "::error::scenario 2 setup flow failed"
  rc=1
fi

echo "########## 3. end of chapter + headset NEXT with the screen off ##########"
wake_device
if maestro test .maestro/sleep/resume.yaml &&
  maestro test .maestro/sleep/jump.yaml -e CHAPTER="Chapter 6" &&
  maestro test .maestro/sleep/arm-eoc.yaml; then
  if sleep_device; then
    # NEXT 6s in: Chapter 6 → Chapter 7. The timer must follow it to the END
    # of Chapter 7 — not pause instantly after the skip (a target left behind
    # at Chapter 6's end), and not run on to the old deadline.
    sample_for 65 6 "adb shell input keyevent KEYCODE_MEDIA_NEXT"
    assert_paused_at_chapter_end "eoc-remote-next" "Chapter 7" "Chapter 8"
  else
    rc=1
  fi
else
  echo "::error::scenario 3 setup flow failed"
  rc=1
fi

echo "########## 4. stop after Chapter 9 (picked in Chapter 8), screen off + deep Doze ##########"
wake_device
if maestro test .maestro/sleep/resume.yaml &&
  maestro test .maestro/sleep/jump.yaml -e CHAPTER="Chapter 8" &&
  maestro test .maestro/sleep/arm-until.yaml -e TARGET="Chapter 9"; then
  if sleep_device; then
    # ~44s of wall time across two chapters — and the Chapter 8 → 9 boundary
    # on the way must NOT pause.
    sample_for 80
    assert_paused_at_chapter_end "stop-after-chapter" "Chapter 9" "Chapter 10"
    passed_8=$(grep -c "|PAUSED|[0-9-]*|Chapter 8\$" "$SAMPLES" || true)
    if [ "${passed_8:-0}" -gt 0 ]; then
      echo "::error::[stop-after-chapter] paused at the end of Chapter 8 — the picked target is Chapter 9"
      rc=1
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
maestro test .maestro/sleep/resume.yaml || rc=$?

echo "==================== sleep-timer evidence (exit $rc) ===================="
echo "-------------------- all media-session samples --------------------"
cat "$ALL_SAMPLES"
echo "-------------------- logcat (filtered) ----------------------------"
timeout 60 adb logcat -d 2>/dev/null |
  grep -iE "sleep timer|ABS sleep|PlaybackStore|PlaybackService|deviceidle|AndroidRuntime|FATAL" |
  tail -200
echo "==================== end sleep-timer evidence ============================"
exit $rc
