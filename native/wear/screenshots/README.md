# Wear screenshot rig

`.github/workflows/wear-screenshots.yml` boots a round Wear OS emulator on CI,
serves demo data from `mock_abs.py` (stdlib Python, endpoints and field names
matched to `data/Models.kt`), installs the wear DEBUG apk, and drives
`capture.sh` through the `DebugLaunch` intent extras (debuggable builds only —
release builds ignore them). Captures land in `screenshots/wear/` at the repo
root via a bot commit whose message carries the skip-ci marker, and the run's
artifact carries the same shots plus `logcat.txt`.

Triggers: any push touching this directory or the workflow file, plus manual
dispatch once the workflow exists on the default branch. A 454x454 round
capture satisfies Play's minimum wear screenshot size, so good runs double as
store-listing candidates.

Local sanity check for the mock server (no Android needed):

    cd native/wear/screenshots
    ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 600 -b:a 32k silence.mp3
    python3 mock_abs.py &
    curl -sS localhost:3333/api/libraries
