/**
 * Voice activity detection for the voice engine (pure, unit-tested): splits a stream of 16 kHz PCM frames into
 * utterances. Speech starts when a frame is louder than max(threshold, 3 × the background noise) for `minSpeechMs`,
 * and ends after `silenceMs` of quiet (or at `maxMs`). The noise level adapts while nobody is speaking, so a noisy
 * phone line doesn't count as speech.
 */
import { concat, rms } from "./audio.ts";

export type VadOptions = { rate?: number; threshold?: number; minSpeechMs?: number; silenceMs?: number; maxMs?: number; prerollMs?: number };
export type VadEvent = { type: "start" } | { type: "end"; audio: Int16Array; ms: number };

export class Vad {
  private rate: number;
  private threshold: number;
  private minSpeech: number;
  private silence: number;
  private max: number;
  private preroll: number;
  private noise = 0;
  private speaking = false;
  private loudMs = 0;
  private quietMs = 0;
  private buf: Int16Array[] = [];
  private bufMs = 0;
  private pre: Int16Array[] = [];
  private preMs = 0;

  constructor(o: VadOptions = {}) {
    this.rate = o.rate ?? 16000;
    this.threshold = o.threshold ?? 600;
    this.minSpeech = o.minSpeechMs ?? 120;
    this.silence = o.silenceMs ?? 700;
    this.max = o.maxMs ?? 15_000;
    this.preroll = o.prerollMs ?? 300;
  }

  get inSpeech(): boolean {
    return this.speaking;
  }

  /** Feeds one frame (any length); returns what happened. */
  push(frame: Int16Array): VadEvent[] {
    const ms = (frame.length / this.rate) * 1000;
    const level = rms(frame);
    const loud = level > Math.max(this.threshold, this.noise * 3);
    const events: VadEvent[] = [];
    if (!this.speaking) {
      if (!loud) this.noise = this.noise ? this.noise * 0.95 + level * 0.05 : level;
      // Keep a little audio from before speech was detected, so the first syllable isn't cut.
      this.pre.push(frame);
      this.preMs += ms;
      while (this.preMs - (this.pre[0].length / this.rate) * 1000 >= this.preroll + this.minSpeech) this.preMs -= (this.pre.shift()!.length / this.rate) * 1000;
      this.loudMs = loud ? this.loudMs + ms : 0;
      if (this.loudMs >= this.minSpeech) {
        this.speaking = true;
        this.quietMs = 0;
        this.buf = this.pre;
        this.bufMs = this.preMs;
        this.pre = [];
        this.preMs = 0;
        events.push({ type: "start" });
      }
      return events;
    }
    this.buf.push(frame);
    this.bufMs += ms;
    this.quietMs = loud ? 0 : this.quietMs + ms;
    if (this.quietMs >= this.silence || this.bufMs >= this.max) {
      events.push({ type: "end", audio: concat(this.buf), ms: this.bufMs });
      this.speaking = false;
      this.buf = [];
      this.bufMs = 0;
      this.loudMs = 0;
    }
    return events;
  }

  reset(): void {
    this.speaking = false;
    this.buf = [];
    this.bufMs = 0;
    this.loudMs = 0;
    this.pre = [];
    this.preMs = 0;
  }
}
