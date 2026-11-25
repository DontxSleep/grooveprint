# Grooveprint

Sing or hum one melody and turn it into a MIDI clip. Grooveprint preserves the timing, rests, note lengths, and relative dynamics it detects in your take. Audio stays on your device.

[Download site](https://dontxsleep.github.io/grooveprint/) · [Releases](https://github.com/DontxSleep/grooveprint/releases)

## Install

- **macOS 13 and later, Apple silicon or Intel:** Open the DMG and drag Grooveprint into Applications. The build is ad-hoc signed and has no Apple notarization.
- **Windows, x64:** Run the setup file and follow the installer. This release uses an unsigned Windows installer.

## Make a MIDI clip

1. Click **Record** and sing or hum one note at a time. Allow microphone access when your operating system prompts you. You can also **Import audio** from a solo vocal recording.
2. Stop recording to see the notes on the piano roll. Switch between **Voice** and **MIDI** to check the timing.
3. Set the BPM to match your DAW. Use **Trim silence before first note** if you want the first note to start at time zero.
4. Save the MIDI clip and drag it onto a MIDI track in Ableton Live or another DAW.

Open **Appearance** to mix and match nine skins and nine backgrounds. The app remembers your choices on this device.

Grooveprint transcribes one pitched voice at a time. Accompaniment, simultaneous pitches, and noisy audio can make notes ambiguous.

## Build from source

The offline interface and transcription are shared between desktop builds. The Mac app uses the system web view and native audio capture. The Windows app bundles Electron.

- **Browser development:** With Node.js 22, run `node build.mjs`, then open `dist/Grooveprint.html` in Chrome.
- **macOS disk image:** On macOS with the Xcode Command Line Tools and Node.js, run `./macos/build-dmg.sh`. The result is `dist/Grooveprint.dmg`.
- **Windows installer:** On Windows with Node.js 22, run `npm --prefix desktop ci` and `npm --prefix desktop run build:windows`. The installer is in `desktop/dist`. GitHub Actions also builds the installer and tests MIDI export with synthetic microphone input.

The download site is in `docs/`.
