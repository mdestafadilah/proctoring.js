import { VIOLATION_TYPES } from '../core/options.js';
import { isSecureContext, throttle } from '../core/utils.js';

/**
 * Audio detector.
 *
 * Measures room loudness (RMS) and, optionally, how "busy" the spectrum is. The
 * loudness path is straightforward and well-behaved. The spectral path is
 * **experimental and cannot count speakers** — see `computeSpectralDensity` for
 * the measurements behind that claim.
 *
 * Policy decision worth stating: this detector **never records**. It reads the
 * live waveform on the main thread and discards every sample immediately. That
 * keeps the package usable in jurisdictions where recording a candidate's audio
 * requires separate consent, and it is why there is no `MediaRecorder` here.
 */
export class AudioDetector {
  static name = 'audio';

  constructor(config, context) {
    this.config = config;
    this.context = context;

    // Said once, at construction, rather than left to the README: a host that
    // switches this on reasonably expects to be told about extra speakers, and
    // the metric cannot do that. See `computeSpectralDensity`.
    if (config.detectMultipleVoices) {
      context.log(
        'warn',
        'audio.detectMultipleVoices is experimental: it measures broadband spectral activity, not speaker count, and voiceThreshold is not calibrated against real audio',
        { voiceThreshold: config.voiceThreshold }
      );
    }

    this.stream = null;
    this.audioContext = null;
    this.analyser = null;
    this.buffer = null;

    this.loudSince = 0;
    this.loudReported = false;
    this.voiceReported = false;

    this.stopPolling = null;

    this._emit = throttle((type, details) => {
      this.context.report(type, details, { detector: 'audio' });
    }, config.throttleMs);
  }

  async init() {
    if (!isSecureContext()) {
      throw new Error(
        'proctoring.js: audio monitoring requires a secure context (https:// or http://localhost)'
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('proctoring.js: getUserMedia is not supported in this browser');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Disable every processing stage that would hide the signal we are
        // trying to measure — noise suppression actively removes background
        // voices, which is exactly the evidence we want.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      throw new Error('proctoring.js: the Web Audio API is not supported in this browser');
    }

    this.audioContext = new AudioCtx();

    // Browsers create the context suspended until a user gesture. `resume()` is
    // a no-op when already running, so call it unconditionally and report the
    // outcome — a suspended context reads as a silent room.
    if (this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
      } catch (err) {
        this.context.log('warn', 'AudioContext could not resume without a user gesture', {
          error: err,
        });
      }
    }

    const source = this.audioContext.createMediaStreamSource(this.stream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = this.config.fftSize;
    this.analyser.smoothingTimeConstant = this.config.smoothingTimeConstant;

    // The analyser must be connected to something to be pulled, but routing it
    // to the destination would echo the candidate's own mic back at them.
    // Connecting to a muted gain node keeps the graph alive and silent.
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(this.analyser);
    this.analyser.connect(silentGain);
    silentGain.connect(this.audioContext.destination);

    this.buffer = new Float32Array(this.analyser.fftSize);
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount);

    this.context.setState('audio', { active: true, status: 'running' });

    // Sample at ~10Hz: fast enough to catch a shout, cheap enough to ignore.
    this.stopPolling = setInterval(() => this._sample(), 100);
    return true;
  }

  _sample() {
    if (!this.analyser) return;
    const now = Date.now();

    // --- loudness --------------------------------------------------------
    this.analyser.getFloatTimeDomainData(this.buffer);
    const rms = computeRms(this.buffer);

    if (rms >= this.config.rmsThreshold) {
      if (!this.loudSince) this.loudSince = now;
      const forMs = now - this.loudSince;

      if (!this.loudReported && forMs >= this.config.loudGraceMs) {
        this.loudReported = true;
        this._emit(VIOLATION_TYPES.AUDIO_TOO_LOUD, {
          rms: Math.round(rms * 10000) / 10000,
          threshold: this.config.rmsThreshold,
          forMs,
        });
        this.context.setState('audio', { active: true, status: 'loud', rms });
      }
    } else {
      this.loudSince = 0;
      // Require the room to actually quieten down before re-arming, otherwise a
      // sustained noise would fire once per throttle window forever.
      if (rms < this.config.rmsThreshold * 0.6) this.loudReported = false;
    }

    this.context.setState('audio', { active: true, status: 'running', rms });

    // --- spectral busyness ------------------------------------------------
    if (this.config.detectMultipleVoices) {
      this.analyser.getByteFrequencyData(this.freqData);
      const density = computeSpectralDensity(this.freqData);

      if (density >= this.config.voiceThreshold) {
        if (!this.voiceReported) {
          this.voiceReported = true;
          this._emit(VIOLATION_TYPES.AUDIO_MULTIPLE_VOICES, {
            density: Math.round(density * 1000) / 1000,
            threshold: this.config.voiceThreshold,
          });
        }
      } else if (density < this.config.voiceThreshold * 0.6) {
        this.voiceReported = false;
      }
    }
  }

  getState() {
    return {
      active: Boolean(this.analyser),
      status: this.audioContext?.state ?? 'stopped',
      rmsThreshold: this.config.rmsThreshold,
      ctxState: this.audioContext?.state ?? null,
    };
  }

  destroy() {
    if (this.stopPolling) clearInterval(this.stopPolling);
    this.stopPolling = null;

    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      // Closing the context releases the audio hardware handle immediately.
      this.audioContext.close().catch(() => {});
    }

    this.stream = null;
    this.analyser = null;
    this.buffer = null;
    this.freqData = null;
    this.audioContext = null;
    this.context.setState('audio', { active: false, status: 'destroyed' });
  }
}

/** Root-mean-square amplitude of a PCM buffer, in 0..1. */
export function computeRms(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

/**
 * Fraction of the spectrum sitting above an absolute amplitude floor.
 *
 * Intended as a cheap proxy for "more than one voice". It is a weak one, and two
 * measured caveats are pinned by tests so this comment cannot drift away from
 * the behaviour:
 *
 * - **Not gain-invariant.** The floor is absolute, so the same source merely
 *   turned up scores higher: one voice measures 0.0020 at 0.3x gain and 0.0118
 *   at 1.0x — a 5.9x rise from volume alone. A single loud speaker therefore
 *   reads as "busier" than two quiet ones.
 * - **Not a speaker count.** One voice and two differ by only ~1.3x, while a
 *   room with an elevated noise floor scores ~10x higher than either. The score
 *   tracks the noise floor more than the number of talkers, so no threshold
 *   separates "several people talking" from "one person in a noisy room".
 *
 * It is kept because `audio-multiple-voices` is a published violation type and a
 * host that calibrates `voiceThreshold` against its own audio may still find the
 * ratio useful. Do not present its output as a speaker count.
 */
export function computeSpectralDensity(freqData, floor = 32) {
  let active = 0;
  // Skip the first few bins: DC offset and sub-bass rumble are not speech.
  for (let i = 4; i < freqData.length; i += 1) {
    if (freqData[i] > floor) active += 1;
  }
  const considered = freqData.length - 4;
  return considered > 0 ? active / considered : 0;
}
