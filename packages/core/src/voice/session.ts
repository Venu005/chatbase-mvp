import { q1 } from "../db";
import { env, envNum } from "../env";
import { HttpError } from "../errors";
import { transcribe } from "../speech";
import { recordAnswer } from "../ai-log";
import { refundCredit } from "../usage";
import { newRun } from "../providers/resilient";
import { type AnswerAgent, cacheAnswer, prepareAnswer, saveAnswer, streamAnswer } from "../answer";
import { resample, toWav } from "./audio";
import { Vad } from "./vad";
import { SentenceSplitter, cleanForSpeech } from "./speech-text";
import { synthesize, ttsLanguage } from "./tts";

/**
 * One voice conversation (a website visitor talking, or a phone call), shared by every voice channel:
 *
 *   caller audio → voice activity detection → speech-to-text (Sarvam) → the normal answer pipeline (search, Q&A
 *   answers, credits, cache, handoff) → the answer is spoken sentence by sentence (text-to-speech) while it is still
 *   being written, so the first words play quickly.
 *
 * Barge-in: when the caller starts talking while the agent is thinking or speaking, the reply is cut off at once
 * (the channel is told to drop audio it hasn't played yet) and the new sentence is answered instead.
 * Handoff: "let me talk to a person" follows the agent's handoff setting; on phone calls with a transfer number the
 * call is transferred to it.
 *
 * Channels (apps/voice) only move audio: they call push() with caller audio and implement VoiceIO.
 */

export type VoiceAgent = AnswerAgent & {
  welcome_message: string;
  voice_enabled: boolean;
  voice_language: string;
  voice_speaker: string;
  voice_greeting: string;
  voice_transfer_number: string | null;
  voice_token: string;
};

export async function loadVoiceAgent(agentId: string): Promise<VoiceAgent | null> {
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) return null;
  return q1<VoiceAgent>(
    `SELECT a.id, a.user_id, a.name, a.instructions, a.handoff_enabled, a.handoff_message, a.lead_mode, a.knowledge_version, u.plan,
            a.welcome_message, a.voice_enabled, a.voice_language, a.voice_speaker, a.voice_greeting, a.voice_transfer_number, a.voice_token
       FROM agents a JOIN users u ON u.id = a.user_id WHERE a.id = $1`,
    [agentId]
  );
}

export type VoiceEvent =
  | { type: "state"; state: "listening" | "thinking" | "speaking" }
  | { type: "transcript"; text: string; language: string | null }
  | { type: "reply"; text: string; partial: boolean }
  | { type: "interrupted" }
  | { type: "handoff"; notice: string | null; transfer: boolean }
  | { type: "metrics"; sttMs: number; firstAudioMs: number | null; totalMs: number }
  | { type: "error"; message: string };

export interface VoiceIO {
  /** Agent audio to play, at the session's output rate. */
  audio(pcm: Int16Array): void;
  /** Drop any agent audio sent but not played yet (barge-in). */
  clear(): void;
  event(e: VoiceEvent): void;
  /** Phone calls: hand the call to this number. */
  transfer?(number: string): Promise<void>;
  /** Phone calls: end the call. */
  hangup?(): void;
}

const ENGINE_RATE = 16000;

export class VoiceSession {
  private vad: Vad;
  private gen = 0; // bumped on barge-in: work for an older turn stops sending audio
  private turn: AbortController | null = null;
  private playingUntil = 0;
  private queue: Promise<void> = Promise.resolve();
  private language: string;
  private closed = false;
  private handedOff = false;
  private bargeIn = env("VOICE_BARGE_IN")?.toLowerCase() !== "off";

  constructor(
    private agent: VoiceAgent,
    private o: { sessionId: string; channel: "voice" | "phone"; inputRate: number; outputRate: number; io: VoiceIO }
  ) {
    this.language = agent.voice_language;
    this.vad = new Vad({
      rate: ENGINE_RATE,
      threshold: envNum("VOICE_VAD_THRESHOLD", 600),
      silenceMs: envNum("VOICE_SILENCE_MS", 700),
      minSpeechMs: envNum("VOICE_MIN_SPEECH_MS", 150),
      maxMs: envNum("VOICE_MAX_UTTERANCE_MS", 15_000),
    });
  }

  /** Says the greeting. */
  start(): void {
    const greeting = this.agent.voice_greeting.trim() || this.agent.welcome_message;
    const gen = this.gen;
    this.queue = this.queue
      .then(() => this.say(greeting, gen))
      .then(() => this.played(gen))
      .catch((e) => this.fail(e))
      .then(() => {
        if (gen === this.gen && !this.closed) this.o.io.event({ type: "state", state: "listening" });
      });
  }

  /** Caller audio (any frame size) at the input rate. */
  push(pcm: Int16Array): void {
    if (this.closed) return;
    for (const ev of this.vad.push(resample(pcm, this.o.inputRate, ENGINE_RATE))) {
      if (ev.type === "start") {
        if (this.bargeIn && (this.turn || Date.now() < this.playingUntil)) this.interrupt();
      } else {
        const utterance = ev.audio;
        const gen = this.gen;
        this.queue = this.queue.then(() => this.answer(utterance, gen)).catch((e) => this.fail(e));
      }
    }
  }

  close(): void {
    this.closed = true;
    this.turn?.abort();
  }

  private get speaking() {
    return Date.now() < this.playingUntil;
  }

  private interrupt() {
    this.gen++;
    this.turn?.abort();
    this.playingUntil = 0;
    this.o.io.clear();
    this.o.io.event({ type: "interrupted" });
  }

  private send(pcm: Int16Array, gen: number): boolean {
    if (gen !== this.gen || this.closed) return false;
    this.o.io.audio(pcm);
    this.playingUntil = Math.max(Date.now(), this.playingUntil) + (pcm.length / this.o.outputRate) * 1000;
    this.o.io.event({ type: "state", state: "speaking" });
    return true;
  }

  private async say(text: string, gen: number, signal?: AbortSignal): Promise<void> {
    const clean = cleanForSpeech(text);
    if (!clean) return;
    const speech = await synthesize(clean, { language: this.language, speaker: this.agent.voice_speaker, rate: this.o.outputRate, signal });
    this.send(speech.pcm, gen);
  }

  /** Resolves when everything sent so far has been played (as far as we can tell). */
  private async played(gen: number): Promise<void> {
    while (gen === this.gen && !this.closed && this.speaking) await new Promise((r) => setTimeout(r, Math.min(200, this.playingUntil - Date.now() + 20)));
  }

  private fail(e: unknown) {
    console.error("Voice turn failed:", e);
    this.o.io.event({ type: "error", message: (e as Error).message ?? String(e) });
  }

  /** One turn: what the caller said → the spoken answer. */
  private async answer(utterance: Int16Array, gen: number): Promise<void> {
    if (gen !== this.gen || this.closed) return;
    const ended = Date.now();
    const abort = new AbortController();
    this.turn = abort;
    this.o.io.event({ type: "state", state: "thinking" });
    try {
      const heard = await transcribe(toWav(utterance, ENGINE_RATE) as Uint8Array<ArrayBuffer>, "audio/wav");
      const sttMs = Date.now() - ended;
      if (gen !== this.gen || !heard.text) return;
      this.o.io.event({ type: "transcript", text: heard.text, language: heard.language });
      this.language = ttsLanguage(heard.language, this.agent.voice_language);

      let prepared;
      try {
        prepared = await prepareAnswer(this.agent, this.o.sessionId, this.o.channel, heard.text);
      } catch (e) {
        if (e instanceof HttpError && e.status === 402) return void (await this.say("Sorry, this assistant can't take more questions right now. Please contact the business directly.", gen));
        throw e;
      }

      if ("handedOff" in prepared) {
        const transfer = this.o.channel === "phone" && !!this.agent.voice_transfer_number && !!this.o.io.transfer;
        const first = !this.handedOff;
        this.handedOff = true;
        this.o.io.event({ type: "handoff", notice: prepared.notice, transfer });
        if (transfer) {
          await this.say("Sure, connecting you to a person now. Please stay on the line.", gen);
          await this.played(gen);
          await this.o.io.transfer!(this.agent.voice_transfer_number!);
        } else if (first || prepared.notice) {
          await this.say(prepared.notice ?? this.agent.handoff_message, gen);
          if (this.o.channel === "phone" && this.o.io.hangup) {
            await this.played(gen);
            this.o.io.hangup();
          }
        }
        return;
      }

      const run = newRun();
      const splitter = new SentenceSplitter();
      let text = "";
      let firstAudioMs: number | null = null;
      let speech = Promise.resolve();
      // Sentences are synthesised as soon as they're complete (in parallel with the rest of the answer) and played in order.
      const speak = (sentence: string) => {
        const audio = synthesize(sentence, { language: this.language, speaker: this.agent.voice_speaker, rate: this.o.outputRate, signal: abort.signal });
        speech = speech.then(async () => {
          const s = await audio;
          if (this.send(s.pcm, gen) && firstAudioMs === null) firstAudioMs = Date.now() - ended;
        });
        speech.catch(() => {}); // awaited below; don't let an early rejection go unhandled
      };
      let error: unknown = null;
      try {
        for await (const delta of streamAnswer(prepared, run, abort.signal)) {
          text += delta;
          for (const s of splitter.push(delta)) speak(s);
        }
        for (const s of splitter.flush()) speak(s);
        if (!text.trim()) throw new Error("The model returned an empty reply");
        await speech;
      } catch (e) {
        error = abort.signal.aborted ? new Error("The caller interrupted") : e;
      }
      const interrupted = abort.signal.aborted;
      if (text.trim()) this.o.io.event({ type: "reply", text, partial: !!error });
      const messageId = text.trim() ? await saveAnswer(prepared, text).catch(() => null) : null;
      if (!text.trim()) await refundCredit(this.agent.user_id).catch(() => {});
      await recordAnswer(prepared, run, { status: !error ? "ok" : text.trim() ? "partial" : "error", messageId, error, answer: text, firstAudioMs });
      if (!error) await cacheAnswer(prepared, run, text);
      this.o.io.event({ type: "metrics", sttMs, firstAudioMs, totalMs: Date.now() - ended });
      if (error && !interrupted) {
        console.error("Voice answer failed:", error);
        if (!firstAudioMs) await this.say("Sorry, I couldn't answer that right now. Please try again.", gen);
      }
    } finally {
      if (this.turn === abort) this.turn = null;
      if (gen === this.gen && !this.closed) {
        await this.played(gen);
        if (gen === this.gen) this.o.io.event({ type: "state", state: "listening" });
      }
    }
  }
}
