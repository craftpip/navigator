#!/usr/bin/env bash
# Pack the Navigator Browser Relay extension into a .crx using the navigator container's Chromium.
#
# No absolute paths — the extension is simply the chrome-extension folder this script
# lives in (resolved relative to the script, so it works from any working directory).
# Run:  ./chrome-extension/pack.sh
#
# IMPORTANT: the .pem private key (chrome-extension-key.pem, next to this script) defines
# the extension's identity — the ID is derived from its public key. Keep it (gitignored,
# chmod 600): reusing it lets updates install cleanly over a previously packed version.
# Never lose it. It must live OUTSIDE the staged extension during packing (Chromium
# refuses to pack with the key inside), so we stage it separately in the container.
set -euo pipefail
cd "$(dirname "$0")"          # the chrome-extension folder

OUT_FILE=dist/navigator-browser-relay.crx
KEY_FILE=chrome-extension-key.pem

echo ">> Staging extension (current directory) into container"
docker exec navigator sh -c 'rm -rf /tmp/ext /tmp/ext.crx /tmp/ext-key.pem'
docker cp . navigator:/tmp/ext
docker exec navigator sh -c 'mv /tmp/ext/chrome-extension-key.pem /tmp/ext-key.pem && rm -rf /tmp/ext/dist'

echo ">> Packing with Chromium"
docker exec navigator sh -c \
  "chromium --no-sandbox --disable-gpu --pack-extension=/tmp/ext --pack-extension-key=/tmp/ext-key.pem 2>&1 | tail -3"

VERSION=$(grep -oP '"version":\s*"\K[0-9.]+' manifest.json)
ROOT_DIST="$(cd .. && pwd)/dist"
mkdir -p "$ROOT_DIST"
OUT_FILE="$ROOT_DIST/navigator-chrome-${VERSION}.crx"

echo ">> Retrieving artifact to $OUT_FILE"
docker cp navigator:/tmp/ext.crx "$OUT_FILE"
chmod 644 "$OUT_FILE" 2>/dev/null || true
chown "$(id -u):$(id -g)" "$OUT_FILE" 2>/dev/null || true

head -c 4 "$OUT_FILE" | grep -q "Cr24" && echo ">> OK: $OUT_FILE ($(stat -c%s "$OUT_FILE") bytes, ID stable)" || { echo ">> FAILED: $OUT_FILE is not a valid CRX"; exit 1; }

# Standardized ZIP in root dist only — same ZIP format for Chrome and Firefox
docker exec navigator python3 -c "
import zipfile, pathlib, os
p = pathlib.Path('/app/chrome-extension')
out = pathlib.Path('/app/dist/navigator-chrome-${VERSION}.zip')
out.parent.mkdir(parents=True, exist_ok=True)
include = ['manifest.json','background.js','popup.html','popup.js','utils','core','cdp','features','icons']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for name in include:
        path = p / name
        if path.is_dir():
            for f in sorted(path.rglob('*')):
                if f.is_file() and 'test' not in f.parts and 'dist' not in f.parts and not f.name.endswith('.pem'):
                    info = zipfile.ZipInfo(str(f.relative_to(p)), date_time=(2025,1,1,0,0,0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    z.writestr(info, f.read_bytes())
        elif path.is_file():
            info = zipfile.ZipInfo(name, date_time=(2025,1,1,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, path.read_bytes())
print(f'ZIP {out} {os.path.getsize(out)} bytes')
"
echo ">> Standardized root dist: $ROOT_DIST/navigator-chrome-${VERSION}.zip + .crx"