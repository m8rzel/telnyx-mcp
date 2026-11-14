import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { audioResult, MAX_EMBED_AUDIO_BYTES } from '../src/embed.js';

describe('audio in the tool result', () => {
  const audio = Buffer.from('ID3-fake-mp3');

  it('returns the JSON summary and the MP3 as an audio block', () => {
    const result = audioResult({ file_path: '/tmp/a.mp3', bytes: audio.length }, audio, true);
    expect(result.content).toHaveLength(2);
    const [text, block] = result.content;
    expect(text).toMatchObject({ type: 'text' });
    expect(JSON.parse((text as { text: string }).text)).toMatchObject({
      file_path: '/tmp/a.mp3',
      audio_embedded: true,
    });
    expect(block).toEqual({
      type: 'audio',
      data: audio.toString('base64'),
      mimeType: 'audio/mpeg',
    });
  });

  it('keeps only the JSON when embedding is switched off', () => {
    const result = audioResult({ file_path: '/tmp/a.mp3' }, audio, false);
    expect(result.content).toHaveLength(1);
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(summary.audio_embedded).toBe(false);
    expect(summary.audio_note).toBeUndefined();
  });

  it('still inlines a file of exactly the limit', () => {
    const edge = Buffer.alloc(MAX_EMBED_AUDIO_BYTES);
    expect(audioResult({}, edge, true).content).toHaveLength(2);
  });

  it('normalises the content type from Telnyx', () => {
    const withParams = audioResult({}, audio, true, 'Audio/MPEG; charset=binary');
    expect(withParams.content[1]).toMatchObject({ mimeType: 'audio/mpeg' });
    const unknown = audioResult({}, audio, true, 'application/octet-stream');
    expect(unknown.content[1]).toMatchObject({ mimeType: 'audio/mpeg' });
  });

  it('does not inline files above the limit and says why', () => {
    const big = Buffer.alloc(MAX_EMBED_AUDIO_BYTES + 1);
    const result = audioResult({ file_path: '/tmp/long.mp3' }, big, true);
    expect(result.content).toHaveLength(1);
    const summary = JSON.parse((result.content[0] as { text: string }).text);
    expect(summary.audio_embedded).toBe(false);
    expect(summary.audio_note).toMatch(/exceed the inline limit/);
  });

  it('passes the content type through', () => {
    const result = audioResult({}, audio, true, 'audio/mp3');
    expect(result.content[1]).toMatchObject({ type: 'audio', mimeType: 'audio/mp3' });
  });
});

describe('TELNYX_TTS_EMBED_AUDIO', () => {
  it('is on by default', () => {
    expect(loadConfig({ TELNYX_API_KEY: 'k' }).embedAudio).toBe(true);
  });

  it('accepts the usual false values', () => {
    for (const value of ['false', '0', 'no', 'off', ' FALSE ']) {
      expect(loadConfig({ TELNYX_API_KEY: 'k', TELNYX_TTS_EMBED_AUDIO: value }).embedAudio).toBe(
        false,
      );
    }
  });

  it('rejects anything else instead of guessing', () => {
    expect(() => loadConfig({ TELNYX_API_KEY: 'k', TELNYX_TTS_EMBED_AUDIO: 'maybe' })).toThrow(
      /true or false/,
    );
  });
});
