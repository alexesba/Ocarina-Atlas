#!/usr/bin/env bash
set -euo pipefail

ZIP_PATH=""
DMG_PATH=""
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

HOST_UNAME="$(uname -m)"
if [ "$HOST_UNAME" = "arm64" ] || [ "$HOST_UNAME" = "aarch64" ]; then
  HOST_ARCH="arm64"
else
  HOST_ARCH="x64"
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

run_headless_app_smoke() {
  local app_bin="$1"
  local smoke_port="$PORT"
  if [ -z "$smoke_port" ]; then
    smoke_port="$(pick_free_port)"
  fi

  echo "Starting $app_bin --port $smoke_port --no-browser ..."
  "$app_bin" --port "$smoke_port" --no-browser >"$WORK_DIR/launcher.log" 2>&1 &
  LAUNCHER_PID=$!

  if ! "$NODE_BIN" - "$smoke_port" "$LAUNCHER_PID" <<'EOF'
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
  "$NODE_BIN" - "$smoke_port" <<'EOF'
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
}

verify_bundle() {
  local zip_file="$1"
  local dmg_file="$2"
  local arch_label="$3"
  local run_app_smoke="$4"

  if [ ! -f "$zip_file" ]; then
    echo "ERROR: Missing macOS ZIP: $zip_file" >&2
    exit 1
  fi

  if [ -n "$dmg_file" ]; then
    if [ ! -f "$dmg_file" ]; then
      echo "ERROR: Missing macOS DMG: $dmg_file" >&2
      exit 1
    fi
    if command -v hdiutil >/dev/null 2>&1; then
      echo "Verifying DMG image metadata ($dmg_file) ..."
      hdiutil imageinfo "$dmg_file" >/dev/null
    fi
  fi

  local abs_zip
  abs_zip="$(cd "$(dirname "$zip_file")" && pwd)/$(basename "$zip_file")"
  local extract_dir="$WORK_DIR/extract-${arch_label}"
  mkdir -p "$extract_dir"

  echo "Extracting $abs_zip into $extract_dir ..."
  if command -v ditto >/dev/null 2>&1; then
    ditto -xk "$abs_zip" "$extract_dir"
  else
    unzip -q "$abs_zip" -d "$extract_dir"
  fi

  local app_bundle
  app_bundle="$(find "$extract_dir" -maxdepth 2 -name "*.app" -type d | head -n 1)"
  if [ -z "$app_bundle" ] || [ ! -d "$app_bundle" ]; then
    echo "ERROR: No .app bundle found after extracting $abs_zip" >&2
    exit 1
  fi

  local resources_dir="$app_bundle/Contents/Resources"
  for req_file in \
    "$resources_dir/app/standalone-server.mjs" \
    "$resources_dir/app/dist/server/server.js" \
    "$resources_dir/bin/longshot-rpc-bridge"; do
    if [ ! -f "$req_file" ]; then
      echo "ERROR: Missing expected file in .app resources ($arch_label): $req_file" >&2
      exit 1
    fi
  done

  if [ ! -d "$resources_dir/app/dist/client" ]; then
    echo "ERROR: Missing expected directory in .app resources ($arch_label): $resources_dir/app/dist/client" >&2
    exit 1
  fi

  local bridge_bin="$resources_dir/bin/longshot-rpc-bridge"
  if [ ! -x "$bridge_bin" ]; then
    echo "ERROR: Expected executable permission on: $bridge_bin" >&2
    exit 1
  fi

  local app_bin="$app_bundle/Contents/MacOS/Ocarina Atlas"
  if [ ! -x "$app_bin" ]; then
    echo "ERROR: Missing or non-executable app binary ($arch_label): $app_bin" >&2
    exit 1
  fi

  if [ "$arch_label" = "$HOST_ARCH" ] || [ "$arch_label" = "custom" ]; then
    echo "Running longshot-rpc-bridge --self-test ($arch_label) ..."
    "$bridge_bin" --self-test
  elif [ "$arch_label" = "x64" ]; then
    if command -v arch >/dev/null 2>&1 && arch -x86_64 /usr/bin/true >/dev/null 2>&1; then
      echo "Running longshot-rpc-bridge --self-test under x86_64 (Rosetta 2) ..."
      arch -x86_64 "$bridge_bin" --self-test
    else
      echo "Skipping x64 longshot-rpc-bridge --self-test (Rosetta 2 / x86_64 execution not available on this host)."
    fi
  fi

  if [ "$run_app_smoke" = "true" ]; then
    run_headless_app_smoke "$app_bin"
  fi
}

if [ -n "$ZIP_PATH" ] || [ -n "$DMG_PATH" ]; then
  if [ -z "$ZIP_PATH" ]; then
    echo "ERROR: --zip is required when --dmg is specified." >&2
    exit 1
  fi
  verify_bundle "$ZIP_PATH" "$DMG_PATH" "custom" "true"
else
  verified_any=false
  ran_host_smoke=false
  for arch in arm64 x64; do
    arch_zip="release/OcarinaAtlas-MacOS-${arch}.zip"
    arch_dmg="release/OcarinaAtlas-MacOS-${arch}.dmg"
    if [ -f "$arch_zip" ] || [ -f "$arch_dmg" ]; then
      verified_any=true
      run_smoke="false"
      if [ "$arch" = "$HOST_ARCH" ]; then
        run_smoke="true"
        ran_host_smoke=true
      fi
      verify_bundle "$arch_zip" "$arch_dmg" "$arch" "$run_smoke"
    fi
  done

  if [ "$verified_any" = "false" ]; then
    echo "ERROR: No macOS release bundles found (expected release/OcarinaAtlas-MacOS-arm64.{dmg,zip} and/or release/OcarinaAtlas-MacOS-x64.{dmg,zip})." >&2
    exit 1
  fi

  if [ "$ran_host_smoke" = "false" ]; then
    echo "WARN: Host arch is $HOST_ARCH, which was not present in release/; skipped headless .app launch."
  fi
fi

echo "macOS smoke test completed successfully."
