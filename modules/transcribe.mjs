const HOP_SECONDS = 0.008;
const MIN_NOTE_SECONDS = 0.045;

function percentile(values, fraction) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * fraction)] ?? 0;
}

function prepareSignal(samples, sampleRate) {
  // Average before decimating, then remove the microphone's DC offset.
  const stride = Math.max(1, Math.round(sampleRate / 12000));
  const signal = new Float32Array(Math.ceil(samples.length / stride));
  let previousInput = 0;
  let previousOutput = 0;
  const rate = sampleRate / stride;
  const dcCoefficient = Math.exp(-2 * Math.PI * 22 / rate);
  for (let i = 0; i < signal.length; i++) {
    const first = i * stride;
    const last = Math.min(first + stride, samples.length);
    let sum = 0;
    for (let j = first; j < last; j++) sum += samples[j];
    const input = sum / (last - first);
    previousOutput = input - previousInput + dcCoefficient * previousOutput;
    previousInput = input;
    signal[i] = previousOutput;
  }
  return { signal, rate };
}

function makeFrames(signal, rate, hop) {
  const frames = [];
  const halfWindow = Math.round(rate * 0.005);
  for (let center = 0; center < signal.length; center += hop) {
    const start = Math.max(0, center - halfWindow);
    const end = Math.min(signal.length, center + halfWindow);
    let squareSum = 0;
    for (let i = start; i < end; i++) squareSum += signal[i] ** 2;
    frames.push({ center, time: center / rate, level: Math.sqrt(squareSum / (end - start)), pitch: null });
  }
  return frames;
}

function estimatePitch(signal, center, rate, minLag, maxLag, windowSize, differences) {
  // YIN compares the waveform with delayed versions of itself. Normalizing
  // the cumulative differences favors the fundamental over its multiples.
  let cumulative = 0;
  let thresholdLag = 0;
  let smallestLag = minLag;
  let smallestDifference = Infinity;
  differences[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    const start = center - Math.floor((windowSize + lag) / 2);
    const left = Math.max(0, start);
    const right = Math.min(signal.length - lag, start + windowSize);
    let difference = 0;
    for (let i = left; i < right; i++) {
      const delta = signal[i] - signal[i + lag];
      difference += delta * delta;
    }
    difference *= windowSize / Math.max(1, right - left);
    cumulative += difference;
    differences[lag] = cumulative > 1e-10 ? (difference * lag) / cumulative : 1;

    if (lag < minLag) continue;
    if (differences[lag] < smallestDifference) {
      smallestDifference = differences[lag];
      smallestLag = lag;
    }
    if (lag > minLag && differences[lag - 1] < 0.16 && differences[lag] >= differences[lag - 1]) {
      thresholdLag = lag - 1;
      break;
    }
  }

  const lag = thresholdLag || smallestLag;
  if (differences[lag] > 0.26 || lag >= maxLag) return null;
  const curvature = differences[lag - 1] - 2 * differences[lag] + differences[lag + 1];
  const delta = curvature > 0 ? (differences[lag - 1] - differences[lag + 1]) / (2 * curvature) : 0;
  const frequency = rate / (lag + Math.max(-0.5, Math.min(0.5, delta)));
  return 69 + 12 * Math.log2(frequency / 440);
}

function smoothPitches(frames, gate) {
  return frames.map((frame, i) => {
    const before = frames[i - 1]?.pitch ?? null;
    const after = frames[i + 1]?.pitch ?? null;
    if (before === null || after === null) return frame.pitch;
    if (frame.pitch === null) {
      return frame.level >= gate && Math.abs(before - after) < 0.6 ? (before + after) / 2 : null;
    }
    return percentile([before, frame.pitch, after], 0.5);
  });
}

function segmentNotes(frames, pitches, duration, hopSeconds) {
  const segments = [];
  const boundary = (index) => Math.max(0, Math.min(duration, frames[index].time - hopSeconds / 2));
  let active = null;
  let pending = null;
  let gapStart = null;

  for (let i = 0; i < frames.length; i++) {
    const pitch = pitches[i];
    if (pitch === null) {
      pending = null;
      if (!active) continue;
      gapStart ??= i;
      if (i > gapStart) {
        active.end = boundary(gapStart);
        segments.push(active);
        active = null;
      }
      continue;
    }

    gapStart = null;
    const midi = Math.round(pitch);
    if (active && Math.abs(pitch - active.midi) <= 0.80) {
      pending = null;
      continue;
    }

    if (pending?.midi === midi) pending.count++;
    else pending = { midi, index: i, count: 1 };

    // Adjacent notes need a little extra confirmation to avoid creating
    // extra MIDI events where a held sung note briefly bends or vibrates.
    const framesNeeded = active && Math.abs(midi - active.midi) === 1 ? 5 : 3;
    if (pending.count >= framesNeeded) {
      const start = boundary(pending.index);
      if (active) {
        active.end = start;
        segments.push(active);
      }
      active = { midi, start, end: duration };
      pending = null;
    }
  }
  if (active) {
    if (gapStart !== null) active.end = boundary(gapStart);
    segments.push(active);
  }
  return segments;
}

function envelopeEdits(segment, frames, hopSeconds, minimumLength, gate) {
  const first = Math.max(0, Math.round(segment.start / hopSeconds));
  const last = Math.min(frames.length - 1, Math.round(segment.end / hopSeconds));
  const separation = Math.ceil(minimumLength / hopSeconds);
  const levels = [];
  const result = [];
  let start = segment.start;
  for (let i = first; i <= last; i++) levels.push(frames[i].level);
  const baseLevel = percentile(levels, 0.70);

  // A same-pitch syllable can be heard as a new note when its amplitude
  // drops and returns quickly, even when pitch analysis bridges the dip.
  for (let i = first + separation; i <= last - separation; i++) {
    const level = frames[i].level;
    if (level > baseLevel * 0.42 || level > frames[i - 1].level || level >= frames[i + 1].level) continue;
    const before = Math.max(frames[i - 2].level, frames[i - 3].level, frames[i - 4].level);
    const after = Math.max(frames[i + 2].level, frames[i + 3].level, frames[i + 4].level);
    if (level > Math.min(before, after) * 0.34 || Math.min(before, after) <= gate * 2) continue;
    const end = frames[i].time;
    if (end - start < minimumLength) continue;
    result.push({ midi: segment.midi, start, end });
    start = end;
    i += separation - 1;
  }
  result.push({ midi: segment.midi, start, end: segment.end });
  return result;
}

function refineBoundary(seconds, frames, hopSeconds, threshold, direction, limit) {
  const center = Math.round(seconds / hopSeconds);
  const span = Math.round(0.040 / hopSeconds);
  for (let offset = 0; offset <= span; offset++) {
    const i = center + offset * direction;
    if (i < 0) return 0;
    if (i >= frames.length) return limit;
    if (frames[i].level <= threshold) {
      return Math.max(0, Math.min(limit, frames[i].time - direction * hopSeconds / 2));
    }
  }
  return seconds;
}

/**
 * Transcribe one unaccompanied voice from normalized mono PCM samples.
 * Note starts and ends are absolute seconds in the original take.
 */
export function transcribe(samples, sampleRate, options = {}) {
  if (!samples || typeof samples.length !== "number" || !Number.isFinite(sampleRate) || sampleRate < 4000) {
    throw new TypeError("Expected mono audio samples and a sample rate of at least 4 kHz.");
  }
  const duration = samples.length / sampleRate;
  const minimumLength = Math.max(0.04, options.minNoteDuration ?? MIN_NOTE_SECONDS);
  if (duration < minimumLength) return { notes: [], duration };

  const { signal, rate } = prepareSignal(samples, sampleRate);
  const hop = Math.round(rate * HOP_SECONDS);
  const hopSeconds = hop / rate;
  const frames = makeFrames(signal, rate, hop);
  const levels = frames.map((frame) => frame.level);
  const referenceLevel = percentile(levels, 0.98);
  const backgroundLevel = percentile(levels, 0.20);
  const gate = Math.max(0.00025, referenceLevel * 0.022, Math.min(backgroundLevel * 2.3, referenceLevel * 0.19));
  const minLag = Math.max(2, Math.floor(rate / 1200));
  const maxLag = Math.ceil(rate / 60) + 1;
  const windowSize = Math.round(rate * 0.022);
  const differences = new Float64Array(maxLag + 1);
  for (const frame of frames) {
    if (frame.level >= gate) {
      frame.pitch = estimatePitch(signal, frame.center, rate, minLag, maxLag, windowSize, differences);
    }
  }

  const pitches = smoothPitches(frames, gate);
  const segments = segmentNotes(frames, pitches, duration, hopSeconds)
    .filter((segment) => segment.end - segment.start >= minimumLength - hopSeconds)
    .flatMap((segment) => envelopeEdits(segment, frames, hopSeconds, minimumLength, gate));

  const notes = segments.map((segment, i) => {
    const previousEnd = segments[i - 1]?.end ?? 0;
    const nextStart = segments[i + 1]?.start ?? duration;
    const first = Math.max(0, Math.ceil(segment.start / hopSeconds));
    const last = Math.min(frames.length, Math.ceil(segment.end / hopSeconds));
    const level = percentile(levels.slice(first, last), 0.80);
    const threshold = Math.max(gate, level * 0.09);
    const start = segment.start > previousEnd + hopSeconds
      ? Math.max(previousEnd, refineBoundary(segment.start, frames, hopSeconds, threshold, -1, duration))
      : segment.start;
    const end = segment.end < nextStart - hopSeconds
      ? Math.min(nextStart, refineBoundary(segment.end, frames, hopSeconds, threshold, 1, duration))
      : segment.end;
    return { midi: segment.midi, start: Math.min(start, segment.start), end: Math.max(end, segment.end), level };
  }).filter((note) => note.end - note.start >= minimumLength);

  const reference = Math.max(0.00025, percentile(notes.map((note) => note.level), 0.90));
  return {
    notes: notes.map(({ midi, start, end, level }, i) => {
      const nextStart = notes[i + 1]?.start ?? duration;
      const dbRatio = Math.log10(Math.max(0.00025, level) / reference);
      const velocity = Math.round(Math.max(1, Math.min(127, 108 + 57 * dbRatio)));
      return { midi, start, end: Math.min(end, nextStart), velocity };
    }),
    duration,
  };
}
