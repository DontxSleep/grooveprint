const byId = id => document.getElementById(id);
const ui = Object.fromEntries([
  'capture-time', 'meter', 'record', 'record-label', 'import', 'file', 'status',
  'tempo', 'trim', 'take-meta', 'demo', 'export', 'roll', 'roll-empty', 'play', 'play-time',
].map(id => [id, byId(id)]));
const previewTabs = [...document.querySelectorAll('[data-source]')];
const meterBars = Array.from({length: 40}, () => document.createElement('i'));
ui.meter.replaceChildren(...meterBars);

const RECORD_LIMIT = 300;
const capture = macBridge ? new MacCapture() : new Capture();
if (macBridge) ui.export.lastChild.textContent = ' Save MIDI';
const scratch = document.createElement('canvas');
const trackCanvas = scratch.getContext('2d');
const rollCanvas = ui.roll.getContext('2d');
const styles = getComputedStyle(document.documentElement);
const color = name => styles.getPropertyValue('--' + name).trim();
const graphColorNames = [
  'deck', 'graph', 'graph-alt', 'graph-label', 'graph-line', 'graph-major',
  'wave', 'note', 'white',
];
let graphColors = Object.fromEntries(graphColorNames.map(name => [name, color(name)]));
const pitchNames = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

let phase = 'ready';
let take = null;
let clip = {notes: [], offset: 0, duration: 0};
let bpm = 140;
let previewSource = 'midi';
let playback = null;
let playbackAttempt = 0;
let recordingAt = 0;
let meterFrame = 0;
let recordingTimer = 0;
let rollSize = {width: 0, height: 0, scale: 1, left: 0, end: 1};

function formatTime(seconds) {
  const tenths = Math.max(0, Math.floor(seconds * 10));
  const wholeSeconds = Math.floor(tenths / 10);
  return Math.floor(wholeSeconds / 60) + ':' + String(wholeSeconds % 60).padStart(2, '0') + '.' + tenths % 10;
}

function setStatus(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

function updateControls() {
  const ready = phase === 'ready';
  const recording = phase === 'recording';
  ui.record.disabled = !ready && !recording;
  ui.record.classList.toggle('active', recording);
  ui['record-label'].textContent = {
    ready: 'Record', requesting: 'Starting…', recording: 'Stop recording', processing: 'Working…',
  }[phase];
  ui.import.disabled = !ready;
  ui.demo.disabled = !ready;
  ui.export.disabled = !ready || !clip.notes.length;
  ui.play.disabled = !ready || !take;
  for (const tab of previewTabs) tab.disabled = !ready || !take;
}

function changePhase(next) {
  phase = next;
  updateControls();
}

function clockDisplay(elapsed = 0) {
  const total = ui['play-time'].querySelector('.duration');
  ui['play-time'].firstChild.nodeValue = formatTime(elapsed) + ' ';
  total.textContent = '/ ' + formatTime(clip.duration);
}

function refreshClip() {
  const offset = take && ui.trim.checked ? take.notes[0].start : 0;
  clip = take ? {
    offset,
    duration: take.duration - offset,
    notes: take.notes.map(note => ({...note, start: note.start - offset, end: note.end - offset})),
  } : {notes: [], offset: 0, duration: 0};

  const count = clip.notes.length;
  ui['take-meta'].textContent = take
    ? take.title + ' · ' + count + (count === 1 ? ' note' : ' notes') + ' · ' + formatTime(clip.duration)
    : 'No take loaded';
  ui['take-meta'].title = take?.title || '';
  ui.roll.setAttribute('aria-label', count
    ? 'Piano roll with ' + count + ' detected ' + (count === 1 ? 'note' : 'notes') + ' and the audio waveform.'
    : 'Empty piano roll and waveform.');
  ui['roll-empty'].hidden = Boolean(count);
  clockDisplay();
  updateControls();
  paintRoll();
}

function drawGrid(ctx, left, top, width, bottom, range, toX, end) {
  const {lowest, highest, laneHeight} = range;
  const whitePitchClasses = new Set([0, 2, 4, 5, 7, 9, 11]);
  ctx.font = '10px ' + color('font-mono');
  ctx.textBaseline = 'middle';
  for (let midi = highest; midi >= lowest; midi--) {
    const row = highest - midi;
    const y = top + row * laneHeight;
    const white = whitePitchClasses.has(midi % 12);
    ctx.fillStyle = white ? graphColors.graph : graphColors['graph-alt'];
    ctx.fillRect(left, y, width - left, laneHeight);
    ctx.fillStyle = graphColors['graph-line'];
    ctx.fillRect(left, Math.round(y), width - left, 1);
    const showLabel = laneHeight >= 11 || midi % Math.ceil(11 / laneHeight) === 0;
    if (white && showLabel) {
      ctx.fillStyle = graphColors['graph-label'];
      ctx.fillText(pitchNames[midi % 12] + (Math.floor(midi / 12) - 1), 10, y + laneHeight / 2);
    }
  }
  const beat = 60 / bpm;
  const beatSpacing = toX(beat) - left;
  const barStride = Math.max(1, Math.ceil(58 / (beatSpacing * 4)));
  const beats = Math.ceil(end / beat);
  const step = beatSpacing < 13 ? barStride * 4 : 1;
  for (let number = 0; number <= beats; number += step) {
    const x = Math.round(toX(number * beat));
    if (x >= width - 1) break;
    const isBar = number % 4 === 0;
    ctx.fillStyle = graphColors[isBar ? 'graph-major' : 'graph-line'];
    ctx.fillRect(x, 0, 1, bottom);
    if (isBar && (number / 4) % barStride === 0) {
      ctx.fillStyle = graphColors['graph-label'];
      ctx.fillText(String(number / 4 + 1), x + 5, top / 2 + 1);
    }
  }
}

function drawWaveform(ctx, left, width, middle, height, end) {
  ctx.fillStyle = graphColors['graph-line'];
  ctx.fillRect(left, middle, width - left, 1);
  if (!take) return;
  const samples = take.wavePeaks;
  const currentWidth = width - left;
  const sourceSeconds = take.duration;
  const toPeak = t => Math.min(samples.length, Math.floor(t / sourceSeconds * samples.length));
  ctx.fillStyle = graphColors.wave;
  for (let column = 0; column < currentWidth; column += 2) {
    const from = toPeak(clip.offset + end * column / currentWidth);
    const to = toPeak(clip.offset + end * (column + 2) / currentWidth);
    let peak = 0;
    for (let index = from; index < Math.min(samples.length, Math.max(from + 1, to)); index++) {
      peak = Math.max(peak, samples[index]);
    }
    const amplitude = Math.min(height / 2 - 2, (height / 2 - 2) * Math.sqrt(peak));
    if (amplitude > 0.25) ctx.fillRect(left + column, middle - amplitude, 1, amplitude * 2);
  }
}

function paintRoll() {
  const width = ui.roll.clientWidth;
  const height = ui.roll.clientHeight;
  if (!width || !height) return;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const pixelsWide = Math.round(width * scale);
  const pixelsHigh = Math.round(height * scale);
  if (ui.roll.width !== pixelsWide || ui.roll.height !== pixelsHigh) {
    ui.roll.width = pixelsWide;
    ui.roll.height = pixelsHigh;
    scratch.width = pixelsWide;
    scratch.height = pixelsHigh;
  }

  const left = width < 440 ? 41 : 54;
  const top = 24;
  const bottom = height - 43;
  const bar = 240 / bpm;
  const paddedDuration = clip.duration + Math.min(0.14, bar / 4);
  const end = Math.max(bar * 2, Math.ceil(paddedDuration / bar - 0.0001) * bar);
  const toX = seconds => left + seconds / end * (width - left);
  rollSize = {width, height, scale, left, end};
  const pitches = clip.notes.map(note => note.midi);
  const min = pitches.length ? Math.min(...pitches) : 60;
  const max = pitches.length ? Math.max(...pitches) : 69;
  const bufferLanes = Math.max(2, Math.ceil((12 - (max - min + 1)) / 2));
  const lowest = Math.max(0, min - bufferLanes);
  const highest = Math.min(127, max + bufferLanes);
  const laneHeight = (bottom - top) / (highest - lowest + 1);

  trackCanvas.setTransform(scale, 0, 0, scale, 0, 0);
  trackCanvas.fillStyle = graphColors.deck;
  trackCanvas.fillRect(0, 0, width, height);
  drawGrid(trackCanvas, left, top, width, bottom, {lowest, highest, laneHeight}, toX, end);
  trackCanvas.fillStyle = graphColors['graph-major'];
  trackCanvas.fillRect(0, top, width, 1);
  trackCanvas.fillRect(0, bottom, width, 1);
  trackCanvas.fillRect(left, 0, 1, height);
  trackCanvas.fillStyle = graphColors['graph-label'];
  trackCanvas.fillText('BAR', 9, top / 2 + 1);
  trackCanvas.fillText('AUDIO', 7, bottom + (height - bottom) / 2);
  drawWaveform(trackCanvas, left, width, bottom + (height - bottom) / 2, height - bottom, end);

  for (const note of clip.notes) {
    const x = toX(note.start);
    const y = top + (highest - note.midi) * laneHeight + Math.min(2, laneHeight * 0.18);
    const noteWidth = Math.max(2, toX(note.end) - x - 1);
    const noteHeight = Math.max(2, laneHeight - Math.min(4, laneHeight * 0.35));
    trackCanvas.fillStyle = graphColors.note;
    trackCanvas.beginPath();
    trackCanvas.roundRect(x, y, noteWidth, noteHeight, Math.min(3, noteHeight / 3));
    trackCanvas.fill();
    if (noteWidth > 24 && noteHeight >= 11) {
      trackCanvas.fillStyle = graphColors.deck;
      trackCanvas.fillText(pitchNames[note.midi % 12], x + 5, y + noteHeight / 2 + 0.5);
    }
  }
  showRoll(playback ? playback.context.currentTime - playback.start : null);
}

function showRoll(position = null) {
  rollCanvas.setTransform(1, 0, 0, 1, 0, 0);
  rollCanvas.clearRect(0, 0, ui.roll.width, ui.roll.height);
  rollCanvas.drawImage(scratch, 0, 0);
  if (position === null) return;
  const {width, height, scale, left, end} = rollSize;
  const x = left + Math.max(0, position) / end * (width - left);
  rollCanvas.setTransform(scale, 0, 0, scale, 0, 0);
  rollCanvas.fillStyle = graphColors.white;
  rollCanvas.fillRect(x, 0, 1, height);
}

function waveformPeaks(samples) {
  const size = Math.min(samples.length, 2400);
  const peaks = new Float32Array(size);
  for (let index = 0; index < size; index++) {
    const start = Math.floor(index * samples.length / size);
    const end = Math.floor((index + 1) * samples.length / size);
    for (let offset = start; offset < end; offset++) {
      peaks[index] = Math.max(peaks[index], Math.abs(samples[offset]));
    }
  }
  return peaks;
}

function analyze(samples, sampleRate) {
  return new Promise((resolve, reject) => {
    let worker;
    let url;
    try {
      url = URL.createObjectURL(new Blob([byId('transcriber').textContent], {type: 'text/javascript'}));
      worker = new Worker(url);
    } catch {
      if (url) URL.revokeObjectURL(url);
      resolve(transcribe(samples, sampleRate));
      return;
    }

    const dispose = () => {
      worker.terminate();
      URL.revokeObjectURL(url);
    };
    worker.onmessage = ({data}) => {
      dispose();
      if (data.error) reject(new Error(data.error));
      else resolve(data.result);
    };
    worker.onerror = event => {
      event.preventDefault();
      dispose();
      try {
        resolve(transcribe(samples, sampleRate));
      } catch (error) {
        reject(error);
      }
    };
    const transferred = samples.slice();
    worker.postMessage({samples: transferred, sampleRate}, [transferred.buffer]);
  });
}

async function useAudio({samples, sampleRate, buffer = null, title}) {
  const seconds = samples.length / sampleRate;
  if (seconds > RECORD_LIMIT + 0.2) throw new Error('Use an audio file up to five minutes long.');
  if (seconds < 0.07) throw new Error('That take was too short. Try singing a longer phrase.');
  const result = await analyze(samples, sampleRate);
  if (!result.notes.length) throw new Error('No clear notes detected. Try a solo voice closer to the microphone.');
  take = {
    title, notes: result.notes, duration: result.duration, samples, sampleRate, buffer,
    wavePeaks: waveformPeaks(samples), trimmedBuffer: null,
  };
  refreshClip();
}

async function useBuffer(buffer, title) {
  if (buffer.duration > RECORD_LIMIT + 0.2) throw new Error('Use an audio file up to five minutes long.');
  await useAudio({samples: monoSamples(buffer), sampleRate: buffer.sampleRate, buffer, title});
}

function stopPlayback() {
  playbackAttempt++;
  if (playback) {
    cancelAnimationFrame(playback.frame);
    playback.stop();
    playback = null;
  }
  ui.play.classList.remove('active');
  ui.play.setAttribute('aria-label', 'Play preview');
  clockDisplay();
  showRoll();
}

function voiceBuffer(context) {
  if (!take.buffer) {
    take.buffer = context.createBuffer(1, take.samples.length, take.sampleRate);
    take.buffer.copyToChannel(take.samples, 0);
  }
  if (clip.offset === 0) return take.buffer;
  if (!take.trimmedBuffer) {
    const start = Math.round(clip.offset * take.sampleRate);
    const length = Math.max(1, take.buffer.length - start);
    const trimmed = context.createBuffer(take.buffer.numberOfChannels, length, take.sampleRate);
    for (let channel = 0; channel < take.buffer.numberOfChannels; channel++) {
      trimmed.copyToChannel(take.buffer.getChannelData(channel).subarray(start), channel);
    }
    take.trimmedBuffer = trimmed;
  }
  return take.trimmedBuffer;
}

async function togglePlayback() {
  if (!take || phase !== 'ready') return;
  if (playback) {
    stopPlayback();
    return;
  }
  const attempt = ++playbackAttempt;
  try {
    const context = audioContext();
    await context.resume();
    if (attempt !== playbackAttempt || phase !== 'ready') return;
    const start = context.currentTime + 0.035;
    const stop = previewSource === 'voice'
      ? scheduleAudio(context, voiceBuffer(context), start)
      : scheduleMidi(context, clip.notes, start);
    const playing = {start, stop, context, frame: 0};
    playback = playing;
    ui.play.classList.add('active');
    ui.play.setAttribute('aria-label', 'Stop preview');
    const draw = () => {
      if (playing !== playback) return;
      const elapsed = context.currentTime - start;
      if (elapsed >= clip.duration) {
        stopPlayback();
        return;
      }
      clockDisplay(elapsed);
      showRoll(elapsed);
      playing.frame = requestAnimationFrame(draw);
    };
    draw();
  } catch {
    setStatus('Audio playback could not start. Try pressing Play again.', true);
  }
}

function showMeter(level) {
  const amount = Math.round(Math.min(1, Math.sqrt(level) * 1.8) * meterBars.length);
  meterBars.forEach((bar, index) => {
    const lit = index < amount;
    bar.classList.toggle('lit', lit);
    bar.classList.toggle('peak', lit && index > 34);
  });
}

async function stopRecording() {
  if (phase !== 'recording') return;
  changePhase('processing');
  cancelAnimationFrame(meterFrame);
  clearTimeout(recordingTimer);
  showMeter(0);
  setStatus('Finding notes and timing…');
  try {
    const buffer = await capture.stop();
    await useBuffer(buffer, 'Microphone take');
    ui['capture-time'].textContent = formatTime(buffer.duration);
    setStatus('Take ready. Play it back or download the MIDI.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    changePhase('ready');
  }
}

async function startRecording() {
  stopPlayback();
  changePhase('requesting');
  setStatus('Waiting for microphone access…');
  ui['capture-time'].textContent = '0:00.0';
  try {
    const started = await capture.start();
    if (!started || phase !== 'requesting') return;
    recordingAt = performance.now();
    changePhase('recording');
    setStatus('Recording. Press Stop recording when you finish.');
    const update = () => {
      if (phase !== 'recording') return;
      ui['capture-time'].textContent = formatTime((performance.now() - recordingAt) / 1000);
      showMeter(capture.meter());
      meterFrame = requestAnimationFrame(update);
    };
    update();
    recordingTimer = setTimeout(stopRecording, RECORD_LIMIT * 1000);
  } catch (error) {
    setStatus(error.message, true);
    changePhase('ready');
  }
}

function demoAudio() {
  const sampleRate = 24000;
  const duration = 3.27;
  const samples = new Float32Array(Math.round(duration * sampleRate));
  const phrase = [
    [62, 0.17, 0.36, 0.33], [65, 0.49, 0.64, 0.48], [69, 0.66, 1.10, 0.52],
    [67, 1.23, 1.46, 0.42], [65, 1.53, 1.67, 0.49], [62, 1.88, 2.18, 0.49],
    [60, 2.32, 2.49, 0.37], [62, 2.58, 3.1, 0.43],
  ];
  for (const [midi, start, end, level] of phrase) {
    const hz = 440 * 2 ** ((midi - 69) / 12);
    let phaseAngle = 0;
    const first = Math.round(start * sampleRate);
    const last = Math.round(end * sampleRate);
    for (let index = first; index < last; index++) {
      const t = (index - first) / sampleRate;
      const remaining = (last - index) / sampleRate;
      const vibrato = 1 + 0.004 * Math.sin(t * 35) - 0.012 * Math.exp(-t * 32);
      phaseAngle += Math.PI * 2 * hz / sampleRate * vibrato;
      const envelope = Math.min(1, t / 0.023, remaining / 0.035);
      samples[index] = envelope * level *
        (0.75 * Math.sin(phaseAngle) + 0.25 * Math.sin(phaseAngle * 2 + 0.4) + 0.12 * Math.sin(phaseAngle * 3));
    }
  }
  return {samples, sampleRate, title: 'Demo phrase'};
}

async function loadDemo(initial = false) {
  stopPlayback();
  changePhase('processing');
  if (!initial) setStatus('Loading demo…');
  try {
    await useAudio(demoAudio());
    setStatus(initial ? 'Ready to record. Sing one note at a time.' : 'Demo ready. Switch between Voice and MIDI to compare.');
    ui['capture-time'].textContent = '0:00.0';
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    changePhase('ready');
  }
}

ui.record.addEventListener('click', () => {
  if (phase === 'recording') stopRecording();
  else if (phase === 'ready') startRecording();
});
ui.import.addEventListener('click', () => ui.file.click());
ui.file.addEventListener('change', async () => {
  const file = ui.file.files[0];
  ui.file.value = '';
  if (!file || phase !== 'ready') return;
  stopPlayback();
  changePhase('processing');
  setStatus('Finding notes and timing…');
  try {
    if (file.size > 160 * 1024 * 1024) throw new Error('Use an audio file up to 160 MB.');
    const buffer = await decodeAudio(file);
    await useBuffer(buffer, file.name.replace(/\.[^.]+$/, '') || 'Imported audio');
    ui['capture-time'].textContent = '0:00.0';
    setStatus('Take ready. Play it back or download the MIDI.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    changePhase('ready');
  }
});

ui.tempo.addEventListener('input', () => {
  const next = ui.tempo.valueAsNumber;
  if (Number.isFinite(next) && next >= 30 && next <= 300) {
    bpm = next;
    paintRoll();
  }
});
ui.tempo.addEventListener('change', () => {
  const value = ui.tempo.valueAsNumber;
  if (Number.isFinite(value)) bpm = Math.round(Math.min(300, Math.max(30, value)));
  ui.tempo.value = bpm;
  paintRoll();
});
ui.trim.addEventListener('change', () => {
  stopPlayback();
  refreshClip();
});
ui.demo.addEventListener('click', () => loadDemo());
ui.play.addEventListener('click', togglePlayback);

for (const tab of previewTabs) {
  tab.addEventListener('click', () => {
    if (tab.dataset.source === previewSource) return;
    const wasPlaying = Boolean(playback);
    stopPlayback();
    previewSource = tab.dataset.source;
    previewTabs.forEach(button => button.setAttribute('aria-pressed', String(button === tab)));
    if (wasPlaying) togglePlayback();
  });
}

ui.export.addEventListener('click', async () => {
  if (!clip.notes.length || phase !== 'ready') return;
  try {
    const exportBpm = bpm;
    const bytes = encodeMidi(clip.notes, {bpm: exportBpm, duration: clip.duration});
    const name = take.title.normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 55);
    const filename = 'grooveprint-' + (name || 'take').toLowerCase() + '.mid';
    if (macBridge) {
      if (await saveMacMidi(bytes, filename)) setStatus('MIDI saved at ' + exportBpm + ' BPM.');
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], {type: 'audio/midi'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2_000);
    setStatus('MIDI downloaded at ' + exportBpm + ' BPM.');
  } catch (error) {
    setStatus(error.message, true);
  }
});

document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target.closest('button, input, select, textarea, a, [contenteditable]')) return;
  if (phase !== 'ready' || !take) return;
  event.preventDefault();
  togglePlayback();
});
window.addEventListener('pagehide', () => {
  capture.cancel();
  stopPlayback();
  if (phase === 'recording' || phase === 'requesting') {
    cancelAnimationFrame(meterFrame);
    clearTimeout(recordingTimer);
    changePhase('ready');
  }
});

initAppearance(() => {
  graphColors = Object.fromEntries(graphColorNames.map(name => [name, color(name)]));
  paintRoll();
});
new ResizeObserver(paintRoll).observe(ui.roll);
refreshClip();
loadDemo(true);
