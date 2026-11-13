import { describe, expect, it } from 'vitest';

import { buildSpeechBody } from '../src/speech.js';
import { buildSsml, escapeXml, parseVoice, rateSupportFor, VoiceError } from '../src/voice.js';

describe('voice identifiers', () => {
  it('splits provider and model', () => {
    expect(parseVoice('Telnyx.Ultra.Clara')).toMatchObject({ provider: 'telnyx', model: 'ultra' });
    expect(parseVoice('aws.Polly.Neural.Vicki')).toMatchObject({ provider: 'aws', model: 'polly' });
    expect(parseVoice('Soniox.Emma').provider).toBe('soniox');
    expect(parseVoice('Soniox.Emma').model).toBeUndefined();
  });

  it('rejects an identifier without a provider segment', () => {
    expect(() => parseVoice('Clara')).toThrow(VoiceError);
    expect(() => parseVoice('')).toThrow(VoiceError);
  });
});

describe('rate capability matrix', () => {
  it('maps Telnyx Ultra and Grok to voice_speed', () => {
    expect(rateSupportFor('Telnyx.Ultra.Clara').kind).toBe('voice_speed');
    expect(rateSupportFor('Telnyx.Grok.Eve').kind).toBe('voice_speed');
  });

  it('maps Minimax and Soniox to speed, with their own ranges', () => {
    expect(rateSupportFor('Minimax.speech-2.8-turbo.Girl')).toMatchObject({
      kind: 'speed',
      max: 2,
    });
    expect(rateSupportFor('Soniox.tts-rt-v2.Emma')).toMatchObject({ kind: 'speed', max: 1.3 });
  });

  it('maps Polly and Azure to SSML', () => {
    expect(rateSupportFor('aws.Polly.Vicki').kind).toBe('ssml');
    expect(rateSupportFor('azure.Neural.Katja').kind).toBe('ssml');
  });

  it('reports the other providers as unsupported with a reason', () => {
    const kokoro = rateSupportFor('Telnyx.KokoroTTS.af_heart');
    expect(kokoro.kind).toBe('unsupported');
    expect(kokoro).toHaveProperty('reason', expect.stringContaining('Ultra'));
    expect(rateSupportFor('elevenlabs.eleven_turbo_v2_5.abc').kind).toBe('unsupported');
  });
});

describe('SSML generation', () => {
  it('wraps text in prosody with a percentage rate', () => {
    expect(buildSsml('Hallo', 0.85)).toBe('<speak><prosody rate="85%">Hallo</prosody></speak>');
  });

  it('escapes markup characters so the payload stays valid XML', () => {
    expect(escapeXml('A & B <tag> "x" \'y\'')).toBe(
      'A &amp; B &lt;tag&gt; &quot;x&quot; &apos;y&apos;',
    );
    expect(buildSsml('5 < 6 & 7', 1.2)).toContain('5 &lt; 6 &amp; 7');
  });
});

describe('request body', () => {
  it('always asks for binary output and keeps the text untouched without a rate', () => {
    expect(buildSpeechBody({ text: 'Hallo', voice: 'Telnyx.Ultra.Clara' })).toEqual({
      text: 'Hallo',
      voice: 'Telnyx.Ultra.Clara',
      output_type: 'binary_output',
    });
  });

  it('puts the rate into voice_settings.voice_speed for Ultra', () => {
    const body = buildSpeechBody({ text: 'Hallo', voice: 'Telnyx.Ultra.Clara', rate: 0.85 });
    expect(body.voice_settings).toEqual({ voice_speed: 0.85 });
    expect(body.text_type).toBeUndefined();
    expect(body.text).toBe('Hallo');
  });

  it('uses voice_settings.speed for Minimax', () => {
    const body = buildSpeechBody({ text: 'Hi', voice: 'Minimax.speech-2.8-turbo.Girl', rate: 1.2 });
    expect(body.voice_settings).toEqual({ speed: 1.2 });
  });

  it('converts the rate to SSML for Polly and flips text_type', () => {
    const body = buildSpeechBody({ text: 'Hallo Welt', voice: 'aws.Polly.Vicki', rate: 0.9 });
    expect(body.text).toBe('<speak><prosody rate="90%">Hallo Welt</prosody></speak>');
    expect(body.text_type).toBe('ssml');
    expect(body.voice_settings).toBeUndefined();
  });

  it('keeps user supplied voice_settings and adds the rate', () => {
    const body = buildSpeechBody({
      text: 'Hallo',
      voice: 'Telnyx.Ultra.Clara',
      rate: 1.1,
      voiceSettings: { emotion: 'neutral' },
    });
    expect(body.voice_settings).toEqual({ emotion: 'neutral', voice_speed: 1.1 });
  });

  it('refuses a rate for a voice that cannot do it, naming alternatives', () => {
    expect(() =>
      buildSpeechBody({ text: 'Hallo', voice: 'Telnyx.KokoroTTS.af_heart', rate: 0.8 }),
    ).toThrow(/not supported for voice/i);
    expect(() =>
      buildSpeechBody({ text: 'Hallo', voice: 'elevenlabs.eleven_turbo_v2_5.abc', rate: 0.8 }),
    ).toThrow(/Telnyx\.Ultra/);
  });

  it('refuses a rate outside the provider range', () => {
    expect(() =>
      buildSpeechBody({ text: 'Hallo', voice: 'Soniox.tts-rt-v2.Emma', rate: 1.8 }),
    ).toThrow(/out of range/i);
  });

  it('refuses to wrap SSML that the caller already wrote', () => {
    expect(() =>
      buildSpeechBody({
        text: '<speak>Hallo</speak>',
        voice: 'aws.Polly.Vicki',
        rate: 0.9,
        textType: 'ssml',
      }),
    ).toThrow(/already SSML/i);
  });

  it('treats rate 1 as "no change" for every voice', () => {
    const body = buildSpeechBody({ text: 'Hallo', voice: 'Telnyx.KokoroTTS.af_heart', rate: 1 });
    expect(body.voice_settings).toBeUndefined();
  });

  it('passes language, dictionary and cache flags through unchanged', () => {
    const body = buildSpeechBody({
      text: 'Hallo',
      voice: 'aws.Polly.Vicki',
      language: 'de-DE',
      pronunciationDictId: 'abc-123',
      disableCache: true,
    });
    expect(body).toMatchObject({
      language: 'de-DE',
      pronunciation_dict_id: 'abc-123',
      disable_cache: true,
    });
  });

  it('rejects empty text', () => {
    expect(() => buildSpeechBody({ text: '   ', voice: 'Telnyx.Ultra.Clara' })).toThrow(VoiceError);
  });
});
