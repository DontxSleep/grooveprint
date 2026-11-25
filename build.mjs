import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';

const read = file => readFile(new URL(file, import.meta.url), 'utf8');
const [shell, styles, app, audioModule, midiModule, transcriptionModule, backdrop, macBridge, appearance] = await Promise.all([
  read('index.html'), read('style.css'), read('app.js'),
  read('modules/audio.mjs'), read('modules/midi.mjs'),
  read('modules/transcribe.mjs'),
  readFile(new URL('cyberpunk.webp', import.meta.url)),
  read('macos/bridge.js'), read('modules/appearance.js'),
]);
const inline = code => code.replace(/^export /gm, '');
const scope = (code, names) => `const {${names}} = (() => {\n${inline(code)}\nreturn {${names}};\n})();\n`;
const transcribeWorker = `'use strict';\n${inline(transcriptionModule)}
self.onmessage = ({data: {samples, sampleRate}}) => {
  try {
    self.postMessage({result: transcribe(samples, sampleRate)});
  } catch (error) {
    self.postMessage({error: error.message});
  }
};\n`;
const script = `'use strict';\n(() => {\n` +
  scope(audioModule, 'Capture, audioContext, decodeAudio, monoSamples, scheduleAudio, scheduleMidi') +
  scope(midiModule, 'encodeMidi') +
  scope(transcriptionModule, 'transcribe') + macBridge + '\n' + appearance + '\n' + app + '\n})();';

const html = shell
  .replace('/* STYLE */', () => '\n' + styles.replace('/* BACKDROP */',
    () => 'url("data:image/webp;base64,' + backdrop.toString('base64') + '")'))
  .replace('/* WORKER */', () => '\n' + transcribeWorker)
  .replace('/* APP */', () => '\n' + script);
const target = resolve(process.argv[2] || 'dist/Grooveprint.html');
await mkdir(dirname(target), {recursive: true});
await writeFile(target, html);
