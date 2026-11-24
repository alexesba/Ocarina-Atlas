#!/usr/bin/env bash
set -euo pipefail

ZIP_PATH="release/OcarinaAtlas-MacOS.zip"
DMG_PATH="release/OcarinaAtlas-MacOS.dmg"
PORT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --zip)
      ZIP_PATH="$2"
      shift 2
      ;;
    --dmg)
      DMG_PATH="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--zip <path>] [--dmg <path>] [--port <port>]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ZIP_PATH" ]; then
  echo "ERROR: Missing macOS ZIP: $ZIP_PATH" >&2
  exit 1
fi

if [ -n "$DMG_PATH" ]; then
  if [ ! -f "$DMG_PATH" ]; then
    echo "ERROR: Missing macOS DMG: $DMG_PATH" >&2
    exit 1
  fi
  if command -v hdiutil >/dev/null 2>&1; then
    echo "Verifying DMG image metadata ($DMG_PATH) ..."
    hdiutil imageinfo "$DMG_PATH" >/dev/null
  fi
fi

ABS_ZIP_PATH="$(cd "$(dirname "$ZIP_PATH")" && pwd)/$(basename "$ZIP_PATH")"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ocarina-atlas-macos-smoke.XXXXXX")"

LAUNCHER_PID=""

cleanup() {
  if [ -n "$LAUNCHER_PID" ] && kill -0 "$LAUNCHER_PID" 2>/dev/null; then
    kill -TERM "$LAUNCHER_PID" 2>/dev/null || true
    wait "$LAUNCHER_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: node is required on PATH to run smoke test checks." >&2
  exit 1
fi

echo "Extracting $ABS_ZIP_PATH into $WORK_DIR ..."
if command -v ditto >/dev/null 2>&1; then
  ditto -xk "$ABS_ZIP_PATH" "$WORK_DIR"
else
  unzip -q "$ABS_ZIP_PATH" -d "$WORK_DIR"
fi

APP_BUNDLE="$(find "$WORK_DIR" -maxdepth 2 -name "*.app" -type d | head -n 1)"
if [ -z "$APP_BUNDLE" ] || [ ! -d "$APP_BUNDLE" ]; then
  echo "ERROR: No .app bundle found after extracting $ABS_ZIP_PATH" >&2
  exit 1
fi

RESOURCES_DIR="$APP_BUNDLE/Contents/Resources"
for req_file in \
  "$RESOURCES_DIR/app/standalone-server.mjs" \
  "$RESOURCES_DIR/app/dist/server/server.js" \
  "$RESOURCES_DIR/bin/longshot-rpc-bridge"; do
  if [ ! -f "$req_file" ]; then
    echo "ERROR: Missing expected file in .app resources: $req_file" >&2
    exit 1
  fi
done

if [ ! -d "$RESOURCES_DIR/app/dist/client" ]; then
  echo "ERROR: Missing expected directory in .app resources: $RESOURCES_DIR/app/dist/client" >&2
  exit 1
fi

BRIDGE_BIN="$RESOURCES_DIR/bin/longshot-rpc-bridge"
if [ ! -x "$BRIDGE_BIN" ]; then
  echo "ERROR: Expected executable permission on: $BRIDGE_BIN" >&2
  exit 1
fi

echo "Running longshot-rpc-bridge --self-test ..."
"$BRIDGE_BIN" --self-test

if command -v arch >/dev/null 2>&1; then
  if arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
    echo "Running longshot-rpc-bridge --self-test under x86_64 (Rosetta 2 / Intel) ..."
    arch -x86_64 "$BRIDGE_BIN" --self-test
  else
    echo "Skipping x86_64 --self-test (Rosetta 2 / x86_64 execution not available on this host)."
  fi
fi

APP_BIN="$APP_BUNDLE/Contents/MacOS/Ocarina Atlas"
if [ ! -x "$APP_BIN" ]; then
  echo "ERROR: Missing or non-executable app binary: $APP_BIN" >&2
  exit 1
fi

pick_free_port() {
  "$NODE_BIN" -e "
    const net = require('node:net');
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      console.log(addr.port);
      srv.close();
    });
  "
}

if [ -z "$PORT" ]; then
  PORT="$(pick_free_port)"
fi

echo "Starting $APP_BIN --port $PORT --no-browser ..."
"$APP_BIN" --port "$PORT" --no-browser >"$WORK_DIR/launcher.log" 2>&1 &
LAUNCHER_PID=$!

if ! "$NODE_BIN" - "$PORT" "$LAUNCHER_PID" <<'EOF'
const port = Number(process.argv[2]);
const pid = Number(process.argv[3]);
const deadline = Date.now() + 30000;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`OcarinaAtlas.app (PID ${pid}) exited prematurely`);
    }
    try {
      const [rootRes, apiRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/`),
        fetch(`http://127.0.0.1:${port}/api/lichii/state`),
      ]);
      if (rootRes.status === 200 && apiRes.status === 200) {
        const data = await apiRes.json();
        for (const key of ['connected', 'emulatorRunning', 'source']) {
          if (!(key in data)) {
            throw new Error(`Missing telemetry key '${key}' in ${JSON.stringify(data)}`);
          }
        }
        console.log(`HTTP 200 OK; telemetry source=${data.source} connected=${data.connected}`);
        return;
      }
      lastErr = new Error(`Unexpected status codes: / -> ${rootRes.status}, api -> ${apiRes.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(300);
  }
  throw new Error(`Timed out waiting for HTTP server on port ${port}: ${lastErr}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
EOF
then
  cat "$WORK_DIR/launcher.log" >&2 || true
  exit 1
fi

echo "Sending SIGTERM to OcarinaAtlas.app (PID $LAUNCHER_PID) ..."
kill -TERM "$LAUNCHER_PID" 2>/dev/null || true
wait "$LAUNCHER_PID" 2>/dev/null || true
LAUNCHER_PID=""

# Verify port closed cleanly (no orphan node server)
"$NODE_BIN" - "$PORT" <<'EOF'
const net = require('node:net');
const port = Number(process.argv[2]);

function isOpen() {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, '127.0.0.1');
  });
}

(async () => {
  for (let i = 0; i < 20; i++) {
    if (!(await isOpen())) {
      console.log(`Port ${port} closed cleanly after SIGTERM.`);
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  console.error(`ERROR: Port ${port} remained open after SIGTERM (orphan process).`);
  process.exit(1);
})();
EOF

echo "macOS smoke test completed successfully."
