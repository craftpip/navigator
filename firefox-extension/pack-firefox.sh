#!/usr/bin/env bash
# Package the Navigator Browser Relay — Firefox extension for manual install.
#
# The generated .xpi is a standard zip; install via:
#   * web-ext:        npx web-ext build                          (already bundles)
#   * Firefox desktop: about:debugging#/runtime/this-firefox -> Load Temporary Add-on
#   * Manual zip:     this script, then File -> Add-ons -> gear -> Install Add-on From File
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$SCRIPT_DIR"

[ -f "$EXT_DIR/manifest.json" ] || { echo "extension not found: $EXT_DIR" >&2; exit 1; }

VERSION=$(grep -oP '"version":\s*"\K[0-9.]+' "$EXT_DIR/manifest.json")
ROOT_DIST="$(cd "$EXT_DIR/.." && pwd)/dist"
mkdir -p "$ROOT_DIST"
OUT="$ROOT_DIST/navigator-firefox-${VERSION}.zip"

# Standardized root dist only — same ZIP format for Chrome and Firefox
# Use python for reproducibility when available, else try zip/tar
if command -v python3 >/dev/null 2>&1; then
  python3 -c "
import zipfile, pathlib
p = pathlib.Path('.')
out = pathlib.Path('$OUT')
files = ['manifest.json','background.html','background.js','popup.html','popup.js','utils','core','cdp','features','icons']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for name in files:
        pt = p / name
        if pt.is_dir():
            for f in sorted(pt.rglob('*')):
                if f.is_file() and 'test' not in f.parts and 'dist' not in f.parts and not f.name.endswith('.pem'):
                    info = zipfile.ZipInfo(str(f.relative_to(p)), date_time=(2025,1,1,0,0,0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    z.writestr(info, f.read_bytes())
        elif pt.is_file():
            info = zipfile.ZipInfo(name, date_time=(2025,1,1,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, pt.read_bytes())
print(f'Built: {out} {out.stat().st_size} bytes')
"
elif command -v zip >/dev/null 2>&1; then
  cd "$EXT_DIR"
  FILES=(manifest.json background.js popup.html popup.js utils core cdp features icons)
  zip -r "$OUT" "${FILES[@]}" -x 'test/*'
  echo "Built: $OUT"
else
  # Fallback via docker python (when host has no python3/zip, e.g. this container host)
  docker exec navigator python3 -c "
import zipfile, pathlib
p = pathlib.Path('/app/firefox-extension')
out = pathlib.Path('/app/dist/navigator-firefox-${VERSION}.zip')
files = ['manifest.json','background.html','background.js','popup.html','popup.js','utils','core','cdp','features','icons']
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for name in files:
        pt = p / name
        if pt.is_dir():
            for f in sorted(pt.rglob('*')):
                if f.is_file() and 'test' not in f.parts and 'dist' not in f.parts and not f.name.endswith('.pem'):
                    info = zipfile.ZipInfo(str(f.relative_to(p)), date_time=(2025,1,1,0,0,0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    info.external_attr = 0o644 << 16
                    z.writestr(info, f.read_bytes())
        elif pt.is_file():
            info = zipfile.ZipInfo(name, date_time=(2025,1,1,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, pt.read_bytes())
print(f'Built: {out} {out.stat().st_size} bytes')
"
fi
echo "Standardized root dist: $OUT"
echo "Unpacked dev source remains at $EXT_DIR (load via about:debugging)."