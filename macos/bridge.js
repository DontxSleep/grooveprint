const macBridge = globalThis.webkit?.messageHandlers?.grooveprint;
const macReadSize = 256 * 1024;

class MacCapture {
  #level = 0;
  #meterAt = 0;
  #meterPending = false;

  async start() {
    this.#level = 0;
    this.#meterAt = 0;
    return await macBridge.postMessage({action: 'start'});
  }

  meter() {
    const now = performance.now();
    if (!this.#meterPending && now - this.#meterAt >= 65) {
      this.#meterAt = now;
      this.#meterPending = true;
      macBridge.postMessage({action: 'meter'})
        .then(level => { this.#level = level; })
        .catch(() => { this.#level = 0; })
        .finally(() => { this.#meterPending = false; });
    }
    return this.#level;
  }

  async stop() {
    try {
      const size = await macBridge.postMessage({action: 'stop'});
      const audio = new Uint8Array(size);
      for (let offset = 0; offset < size; offset += macReadSize) {
        const payload = await macBridge.postMessage({action: 'read', offset});
        const chunk = atob(payload);
        if (chunk.length !== Math.min(macReadSize, size - offset)) {
          throw new Error('The recording could not be read. Try a new take.');
        }
        for (let index = 0; index < chunk.length; index++) {
          audio[offset + index] = chunk.charCodeAt(index);
        }
      }
      return await decodeAudio(new Blob([audio], {type: 'audio/wav'}));
    } finally {
      macBridge.postMessage({action: 'release'}).catch(() => {});
    }
  }

  cancel() {
    macBridge.postMessage({action: 'cancel'}).catch(() => {});
  }
}

function saveMacMidi(bytes, name) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return macBridge.postMessage({action: 'saveMidi', name, bytes: btoa(binary)});
}
