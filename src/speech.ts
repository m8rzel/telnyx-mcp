import type { TelnyxClient } from './telnyx.js';
import { buildSsml, rateSupportFor, VoiceError } from './voice.js';

export interface VoiceSettings {
  [key: string]: unknown;
}

export interface SpeakRequest {
  text: string;
  voice: string;
  language?: string;
  /** Speaking rate multiplier, 1 = normal. Mapped per provider (see voice.ts). */
  rate?: number;
  textType?: 'text' | 'ssml';
  voiceSettings?: VoiceSettings;
  pronunciationDictId?: string;
  disableCache?: boolean;
}

export interface TelnyxSpeechBody {
  text: string;
  voice: string;
  output_type: 'binary_output';
  language?: string;
  text_type?: 'text' | 'ssml';
  voice_settings?: VoiceSettings;
  pronunciation_dict_id?: string;
  disable_cache?: boolean;
}

/**
 * Builds the request body for POST /v2/text-to-speech/speech.
 *
 * The `rate` parameter is the one piece of real translation here: Telnyx has no
 * global speed field. Ultra/Grok take `voice_settings.voice_speed`, Minimax and
 * Soniox take `voice_settings.speed`, and Polly/Azure only accept a rate as
 * SSML `<prosody rate="…">`, which also flips `text_type` to `ssml`. Voices
 * that support none of this are rejected with an explicit message instead of
 * silently ignoring the request.
 */
export function buildSpeechBody(request: SpeakRequest): TelnyxSpeechBody {
  const { text, voice } = request;
  if (!text.trim()) throw new VoiceError('Text must not be empty.');

  const body: TelnyxSpeechBody = {
    text,
    voice,
    output_type: 'binary_output',
  };

  if (request.language) body.language = request.language;
  if (request.pronunciationDictId) body.pronunciation_dict_id = request.pronunciationDictId;
  if (request.disableCache) body.disable_cache = true;

  const voiceSettings: VoiceSettings = { ...(request.voiceSettings ?? {}) };
  let textType = request.textType;

  if (request.rate !== undefined && request.rate !== 1) {
    const support = rateSupportFor(voice);
    if (support.kind === 'unsupported') {
      throw new VoiceError(
        `Speaking rate is not supported for voice "${voice}". ${support.reason} ` +
          `Omit "rate" or pick a voice that supports it.`,
      );
    }
    if (request.rate < support.min || request.rate > support.max) {
      throw new VoiceError(
        `Rate ${request.rate} is out of range for "${voice}" (allowed ${support.min}–${support.max}).`,
      );
    }

    if (support.kind === 'voice_speed') {
      voiceSettings.voice_speed = request.rate;
    } else if (support.kind === 'speed') {
      voiceSettings.speed = request.rate;
    } else {
      if (textType === 'ssml') {
        throw new VoiceError(
          `"rate" cannot be combined with text_type "ssml" for "${voice}" — the text is already SSML. ` +
            `Set the rate yourself with <prosody rate="…"> inside your markup.`,
        );
      }
      body.text = buildSsml(text, request.rate);
      textType = 'ssml';
    }
  }

  if (textType) body.text_type = textType;
  if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings;
  return body;
}

export interface SynthesisResult {
  audio: Buffer;
  contentType: string;
  characters: number;
}

/** Calls Telnyx and returns the raw audio bytes (binary_output → audio/mpeg). */
export async function synthesize(
  client: TelnyxClient,
  request: SpeakRequest,
): Promise<SynthesisResult> {
  const body = buildSpeechBody(request);
  const { data, contentType } = await client.postBinary('/text-to-speech/speech', body);

  if (data.length === 0) {
    throw new VoiceError('Telnyx returned an empty audio response.');
  }
  // Cost is billed on the text Telnyx receives, including any SSML we added.
  return { audio: data, contentType, characters: body.text.length };
}
