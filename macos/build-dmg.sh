#!/bin/bash
set -euo pipefail

source_dir="$(cd "$(dirname "$0")" && pwd)"
project_dir="$(cd "$source_dir/.." && pwd)"
target="${1:-$project_dir/dist/Grooveprint.dmg}"
stage="$(mktemp -d "$source_dir/.package.XXXXXXXX")"
trap 'rm -rf "$stage"' EXIT

volume="$stage/volume"
app="$volume/Grooveprint.app"
contents="$app/Contents"
binary="$contents/MacOS/Grooveprint"
mkdir -p "$contents/MacOS" "$contents/Resources"

cp "$source_dir/Info.plist" "$contents/Info.plist"
cp "$source_dir/Grooveprint.icns" "$contents/Resources/Grooveprint.icns"
printf 'APPL????' > "$contents/PkgInfo"
node "$source_dir/../build.mjs" "$contents/Resources/Grooveprint.html"

for architecture in arm64 x86_64; do
    xcrun swiftc -swift-version 5 -O -target "$architecture-apple-macosx13.0" \
        "$source_dir/GrooveprintApp.swift" "$source_dir/Microphone.swift" \
        -o "$stage/Grooveprint-$architecture"
done
xcrun lipo -create "$stage/Grooveprint-arm64" "$stage/Grooveprint-x86_64" -output "$binary"
chmod +x "$binary"

codesign --force --sign - --timestamp=none --options runtime \
    --entitlements "$source_dir/Entitlements.plist" "$app"
codesign --verify --deep --strict "$app"
ln -s /Applications "$volume/Applications"

hdiutil create -volname Grooveprint -fs HFS+ -format UDZO -srcfolder "$volume" "$stage/Grooveprint.dmg"
hdiutil verify "$stage/Grooveprint.dmg"
mkdir -p "$(dirname "$target")"
mv "$stage/Grooveprint.dmg" "$target"
