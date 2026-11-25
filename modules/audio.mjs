let sharedContext;

export function audioContext() {
  const Audio = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  if (!Audio) throw new Error('Open this app in a browser that supports Web Audio.');
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Audio();
  return sharedContext;
}

export async function decodeAudio(blob) {
  if (!blob.size) throw new Error('No audio was captured. Try another take.');
  const context = audioContext();
  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    throw new Error('The browser could not read this audio. Try a new recording or a WAV or MP3 file.');
  }
}

function microphoneError(error) {
  switch (error.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error('Allow microphone access in your browser, then try recording again.');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error('No microphone is available. Connect or select a microphone and try again.');
    case 'NotReadableError':
    case 'AbortError':
      return new Error('The microphone could not start. Make sure it is connected and available, then try again.');
    default:
      return error;
  }
}

function recorderOptions() {
  const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const mimeType = types.find(type => MediaRecorder.isTypeSupported?.(type));
  return mimeType ? { mimeType } : undefined;
}

function releaseCapture(take) {
  take.source?.disconnect();
  take.stream?.getTracks().forEach(track => track.stop());
  take.source = null;
  take.stream = null;
  take.analyser = null;
}

export class Capture {
  #take = null;

  async start() {
    if (this.#take) throw new Error('A recording is already in progress.');
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder) {
      throw new Error('Microphone recording is unavailable here. Open this app in Chrome, Edge or Safari.');
    }

    const context = audioContext();
    // Start Web Audio during the Record gesture, before the permission dialog.
    if (context.state !== 'running') context.resume().catch(() => {});

    const take = {};
    this.#take = take;
    try {
      take.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          autoGainControl: false,
          echoCancellation: false,
          noiseSuppression: false,
        },
      });
      if (this.#take !== take) {
        releaseCapture(take);
        return false;
      }

      take.source = context.createMediaStreamSource(take.stream);
      take.analyser = context.createAnalyser();
      take.analyser.fftSize = 2048;
      take.samples = new Float32Array(take.analyser.fftSize);
      // No destination connection, so recording never feeds the speakers.
      take.source.connect(take.analyser);

      const recorder = new MediaRecorder(take.stream, recorderOptions());
      take.recorder = recorder;
      const chunks = [];
      take.blob = new Promise((resolve, reject) => {
        recorder.addEventListener('dataavailable', event => {
          if (event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener('error', event => {
          releaseCapture(take);
          reject(event.error || new Error('The recording stopped unexpectedly. Try recording again.'));
        }, { once: true });
        recorder.addEventListener('stop', () => {
          releaseCapture(take);
          resolve(new Blob(chunks, { type: chunks[0]?.type || recorder.mimeType }));
        }, { once: true });
      });
      // A recorder error can arrive before the user presses Stop.
      take.blob.catch(() => {});
      recorder.start();
      return true;
    } catch (error) {
      releaseCapture(take);
      if (this.#take === take) this.#take = null;
      throw microphoneError(error);
    }
  }

  meter() {
    const take = this.#take;
    if (!take?.analyser) return 0;
    take.analyser.getFloatTimeDomainData(take.samples);
    let power = 0;
    for (const sample of take.samples) power += sample * sample;
    return Math.min(1, Math.sqrt(power / take.samples.length));
  }

  async stop() {
    const take = this.#take;
    if (!take?.blob || take.stopping) throw new Error('There is no active recording to finish.');
    take.stopping = true;
    try {
      if (take.recorder.state !== 'inactive') take.recorder.stop();
      return await decodeAudio(await take.blob);
    } finally {
      releaseCapture(take);
      if (this.#take === take) this.#take = null;
    }
  }

  cancel() {
    const take = this.#take;
    if (!take) return;
    this.#take = null;
    try {
      if (take.recorder && take.recorder.state !== 'inactive') take.recorder.stop();
    } finally {
      releaseCapture(take);
    }
  }
}

export function monoSamples(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
  const mix = new Float32Array(buffer.length);
  let strongest;
  let strongestPower = 0;
  for (const channel of channels) {
    let power = 0;
    for (let index = 0; index < channel.length; index++) {
      const sample = channel[index];
      mix[index] += sample / channels.length;
      power += sample * sample;
    }
    if (power > strongestPower) {
      strongest = channel;
      strongestPower = power;
    }
  }

  let mixPower = 0;
  for (const sample of mix) mixPower += sample * sample;
  // A vocal doubled with reversed polarity can disappear when averaged.
  return mixPower < strongestPower * 0.12 ? strongest : mix;
}

export function scheduleAudio(context, buffer, startTime = context.currentTime + 0.025) {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  let active = true;
  source.addEventListener('ended', () => {
    active = false;
    source.disconnect();
  }, { once: true });
  source.start(startTime);
  return () => {
    if (!active) return;
    active = false;
    source.stop();
  };
}

export function scheduleMidi(context, notes, startTime = context.currentTime + 0.025) {
  const playing = new Set();
  for (const note of notes) {
    const voice = context.createOscillator();
    const level = context.createGain();
    const start = startTime + note.start;
    const end = Math.max(start + 0.005, startTime + note.end);
    const duration = end - start;
    const attack = Math.min(0.008, duration * 0.18);
    const release = Math.min(0.025, duration * 0.25);
    const amplitude = 0.21 * ((note.velocity ?? 96) / 127) ** 0.8;

    voice.type = 'triangle';
    voice.frequency.value = 440 * 2 ** ((note.midi - 69) / 12);
    level.gain.setValueAtTime(0, start);
    level.gain.linearRampToValueAtTime(amplitude, start + attack);
    level.gain.setValueAtTime(amplitude, end - release);
    level.gain.linearRampToValueAtTime(0, end);

    voice.connect(level);
    level.connect(context.destination);
    playing.add(voice);
    voice.addEventListener('ended', () => {
      playing.delete(voice);
      voice.disconnect();
      level.disconnect();
    }, { once: true });
    voice.start(start);
    voice.stop(end);
  }
  return () => {
    for (const voice of playing) voice.stop();
    playing.clear();
  };
}
