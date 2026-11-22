#!/usr/bin/env bash
# Writes the AUR PKGBUILD for a release: render.sh <repo> <tag> <out dir>. Needs gh and curl.
set -euo pipefail
REPO=$1; TAG=$2; OUT=$3; V="${TAG#v}"
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
gh release download "$TAG" -R "$REPO" -D "$tmp" -p "*_amd64.deb" -p "*_arm64.deb"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$TAG/LICENSE" -o "$tmp/LICENSE"
sha() { sha256sum "$1" | cut -d' ' -f1; }
# What the binary links (checked with objdump + pacman -Qo on Arch), plus the tray library and ffmpeg it loads at run time.
DEPS="'webkit2gtk-4.1' 'gtk3' 'gdk-pixbuf2' 'cairo' 'glib2' 'libsoup3' 'libx11' 'libxcb' 'wayland' 'alsa-lib' 'dbus' 'libayatana-appindicator' 'ffmpeg'"
mkdir -p "$OUT"
sed -e "s|@V@|$V|g" -e "s|@REPO@|$REPO|g" -e "s|@DEPENDS@|$DEPS|" \
    -e "s|@SHA_LICENSE@|$(sha "$tmp/LICENSE")|" -e "s|@SHA_X64@|$(sha "$tmp"/*_amd64.deb)|" -e "s|@SHA_ARM@|$(sha "$tmp"/*_arm64.deb)|" \
    "$here/PKGBUILD.in" > "$OUT/PKGBUILD"
echo "wrote $OUT/PKGBUILD for $V"
