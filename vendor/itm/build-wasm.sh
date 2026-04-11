#!/usr/bin/env bash
# Build NTIA ITM C++ source to WebAssembly via Emscripten.
#
# Prerequisites:
#   1. Emscripten SDK installed and activated at /tmp/emsdk
#      git clone https://github.com/emscripten-core/emsdk.git /tmp/emsdk
#      cd /tmp/emsdk && ./emsdk install latest && ./emsdk activate latest
#
#   2. Patched NTIA ITM C++ source is in src/ and include/ (checked in).
#      Original: https://github.com/NTIA/itm
#      Patches: backslash includes → forward slashes,
#               DLLEXPORT → EMSCRIPTEN_KEEPALIVE under __EMSCRIPTEN__
#
# Output: vendor/itm/itm-glue.js + vendor/itm/itm-glue.wasm

set -euo pipefail

source /tmp/emsdk/emsdk_env.sh 2>/dev/null

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
INC_DIR="$SCRIPT_DIR/include"
OUT_DIR="$SCRIPT_DIR"

# Collect all C++ source files
SRCS=()
for f in "$SRC_DIR"/*.cpp; do
  SRCS+=("$f")
done

echo "Compiling ${#SRCS[@]} source files to WASM..."

emcc "${SRCS[@]}" \
  -I"$INC_DIR" \
  -O3 \
  -s WASM=1 \
  -s MODULARIZE=1 \
  -s EXPORT_NAME="createITMModule" \
  -s ENVIRONMENT='web,worker' \
  -s FILESYSTEM=0 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=16MB \
  -s EXPORTED_FUNCTIONS='["_ITM_P2P_TLS","_malloc","_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap","getValue","setValue","HEAPF64","HEAP32","HEAPU8"]' \
  -s NO_EXIT_RUNTIME=1 \
  -fno-exceptions \
  -o "$OUT_DIR/itm-glue.js"

echo ""
echo "Build complete."
ls -lh "$OUT_DIR/itm-glue.js" "$OUT_DIR/itm-glue.wasm"
