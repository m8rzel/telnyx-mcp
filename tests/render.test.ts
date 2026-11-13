import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { mp3Duration } from '../src/mp3.js';
import { renderScript } from '../src/render.js';
import { TelnyxClient } from '../src/telnyx.js';

import { tone24kMono as tone } from './fixtures/index.js';

const toneDuration = mp3Duration(tone);

const config: Config = {
  apiKey: 'KEYTESTONLY0000000000',
  outputDir: '/tmp/telnyx-mcp-test',
  timeoutMs: 5000,
  maxRetries: 2,
};

/** Returns the same fixture audio for every synthesis call. */
function clientReturningTone(): { client: TelnyxClient; fetchImpl: ReturnType<typeof vi.fn> } {
  const fetchImpl = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(tone, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      ),
    );
  return {
    client: new TelnyxClient(config, { fetchImpl, sleep: () => Promise.resolve() }),
    fetchImpl,
  };
}

describe('render_script', () => {
  it('synthesises one request per speech segment and inserts the pauses', async () => {
    const { client, fetchImpl } = clientReturningTone();
    const script = 'Erster Satz.\n\n[PAUSE 2]\n\nZweiter Satz.';

    const result = await renderScript(client, script, { voice: 'Telnyx.Ultra.Clara' });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.parts.map((p) => p.kind)).toEqual(['speech', 'silence', 'speech']);
    expect(result.speechDurationSeconds).toBeCloseTo(toneDuration * 2, 2);
    expect(result.silenceDurationSeconds).toBeCloseTo(2, 1);
    expect(result.totalDurationSeconds).toBeCloseTo(toneDuration * 2 + 2, 1);
  });

  it('produces a single playable MP3 whose measured length matches the report', async () => {
    const { client } = clientReturningTone();

    const result = await renderScript(client, 'A.\n\n[PAUSE 1]\n\nB.', {
      voice: 'Telnyx.Ultra.Clara',
    });

    expect(mp3Duration(result.audio)).toBeCloseTo(result.totalDurationSeconds, 2);
  });

  it('adds lead-in and lead-out silence around the whole script', async () => {
    const { client } = clientReturningTone();

    const result = await renderScript(client, 'Nur ein Satz.', {
      voice: 'Telnyx.Ultra.Clara',
      leadInSeconds: 1.5,
      leadOutSeconds: 2,
    });

    expect(result.parts.map((p) => p.kind)).toEqual(['silence', 'speech', 'silence']);
    expect(result.silenceDurationSeconds).toBeCloseTo(3.5, 1);
  });

  it('reports the frame-aligned pause length when it differs from the request', async () => {
    const { client } = clientReturningTone();

    const result = await renderScript(client, 'A.\n\n[PAUSE 1,01]\n\nB.', {
      voice: 'Telnyx.Ultra.Clara',
    });

    const silence = result.parts.find((p) => p.kind === 'silence')!;
    expect(silence.requestedSeconds).toBe(1.01);
    expect(silence.durationSeconds).not.toBe(1.01);
    expect(Math.abs(silence.durationSeconds - 1.01)).toBeLessThan(0.03);
  });

  it('counts the characters that are actually billed', async () => {
    const { client } = clientReturningTone();

    const result = await renderScript(client, 'Hallo.\n\n[PAUSE 1]\n\nWelt.', {
      voice: 'Telnyx.Ultra.Clara',
    });

    expect(result.characters).toBe('Hallo.'.length + 'Welt.'.length);
  });

  it('counts the SSML overhead when a rate forces SSML', async () => {
    const { client } = clientReturningTone();

    const result = await renderScript(client, 'Hallo.', { voice: 'aws.Polly.Vicki', rate: 0.9 });

    expect(result.characters).toBeGreaterThan('Hallo.'.length);
  });

  it('refuses a script without speakable text instead of writing an empty file', async () => {
    const { client, fetchImpl } = clientReturningTone();

    await expect(
      renderScript(client, '# Titel\n\n[PAUSE 5]', { voice: 'Telnyx.Ultra.Clara' }),
    ).rejects.toThrow(/no speakable text/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('propagates a Telnyx failure instead of leaving a gap in the audio', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: '90103', detail: 'nope' }] }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new TelnyxClient(config, { fetchImpl, sleep: () => Promise.resolve() });

    await expect(renderScript(client, 'Hallo.', { voice: 'Telnyx.Ultra.Clara' })).rejects.toThrow(
      /90103/,
    );
  });

  it('reports a non-MP3 response clearly rather than writing junk', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(Buffer.from('RIFFWAVEfmt '), { status: 200 }));
    const client = new TelnyxClient(config, { fetchImpl, sleep: () => Promise.resolve() });

    await expect(renderScript(client, 'Hallo.', { voice: 'Telnyx.Ultra.Clara' })).rejects.toThrow(
      /not MP3/i,
    );
  });
});
