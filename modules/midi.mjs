const TICKS_PER_BEAT = 960;
const MAX_DELTA_TICKS = 0x0fffffff;

function writeDelta(bytes, ticks) {
  if (ticks > MAX_DELTA_TICKS) {
    throw new RangeError('The gap between MIDI events is too long.');
  }

  const delta = [ticks & 0x7f];
  while (ticks > 0x7f) {
    ticks >>>= 7;
    delta.unshift((ticks & 0x7f) | 0x80);
  }
  bytes.push(...delta);
}

/** Encode a single-track Standard MIDI File from note times in seconds. */
export function encodeMidi(notes, { bpm = 140, duration = 0 } = {}) {
  const tempo = Math.round(60_000_000 / bpm);
  if (!Number.isFinite(bpm) || tempo < 1 || tempo > 0xffffff) {
    throw new RangeError('The tempo is outside the supported MIDI range.');
  }

  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError('The MIDI clip duration must be zero or a positive number of seconds.');
  }

  const ticksPerSecond = TICKS_PER_BEAT * 1_000_000 / tempo;
  const events = [];
  for (const { midi, start, end, velocity = 88 } of notes) {
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) {
      throw new RangeError('MIDI note numbers must be integers from 0 to 127.');
    }
    if (!Number.isInteger(velocity) || velocity < 1 || velocity > 127) {
      throw new RangeError('MIDI velocities must be integers from 1 to 127.');
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new RangeError('Every MIDI note needs a start time before its end time.');
    }

    const firstTick = Math.round(start * ticksPerSecond);
    const lastTick = Math.max(firstTick + 1, Math.round(end * ticksPerSecond));
    events.push(
      { tick: firstTick, status: 0x90, midi, velocity },
      { tick: lastTick, status: 0x80, midi, velocity: 0 },
    );
  }

  // A repeated pitch can end and start at the same tick. Release it first.
  events.sort((a, b) => a.tick - b.tick || a.status - b.status || a.midi - b.midi);

  const track = [0x00, 0xff, 0x51, 0x03, tempo >>> 16, (tempo >>> 8) & 0xff, tempo & 0xff];
  let previousTick = 0;
  for (const { tick, status, midi, velocity } of events) {
    writeDelta(track, tick - previousTick);
    track.push(status, midi, velocity);
    previousTick = tick;
  }
  const endTick = Math.max(previousTick, Math.round(duration * ticksPerSecond));
  writeDelta(track, endTick - previousTick);
  track.push(0xff, 0x2f, 0x00);

  const file = new Uint8Array(22 + track.length);
  file.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1], 0);
  file.set([0x4d, 0x54, 0x72, 0x6b], 14);
  const header = new DataView(file.buffer);
  header.setUint16(12, TICKS_PER_BEAT);
  header.setUint32(18, track.length);
  file.set(track, 22);
  return file;
}
