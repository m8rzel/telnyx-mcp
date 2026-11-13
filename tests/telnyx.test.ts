import { describe, expect, it, vi } from 'vitest';

import type { Config } from '../src/config.js';
import { backoffMs, describeTelnyxError, TelnyxClient, TelnyxError } from '../src/telnyx.js';

const SECRET = 'KEY0123456789ABCDEFSECRET';

const config: Config = {
  apiKey: SECRET,
  outputDir: '/tmp/telnyx-mcp-test',
  timeoutMs: 5000,
  maxRetries: 3,
};

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('error description', () => {
  it('flattens the Telnyx errors array', () => {
    const { message, code } = describeTelnyxError(
      JSON.stringify({
        errors: [{ code: '90103', title: 'Failed to produce text to speech', detail: 'bad voice' }],
      }),
    );
    expect(code).toBe('90103');
    expect(message).toContain('[90103]');
    expect(message).toContain('bad voice');
  });

  it('falls back to the raw body when it is not JSON', () => {
    expect(describeTelnyxError('upstream exploded').message).toBe('upstream exploded');
  });
});

describe('backoff', () => {
  it('grows exponentially and stays capped', () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(500);
    expect(backoffMs(1)).toBeLessThan(1000);
    expect(backoffMs(6)).toBeLessThanOrEqual(15_250);
  });

  it('honours retry-after over the exponential schedule', () => {
    expect(backoffMs(1, 7)).toBe(7000);
    expect(backoffMs(1, 9999)).toBe(30_000);
  });
});

describe('TelnyxClient', () => {
  const sleep = (): Promise<void> => Promise.resolve();

  it('sends bearer auth and returns parsed JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { voices: [{ id: 'A' }] }));
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    const result = await client.getJson<{ voices: unknown[] }>('/text-to-speech/voices');

    expect(result.voices).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.telnyx.com/v2/text-to-speech/voices');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('retries on 429 and succeeds on the next attempt', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, { errors: [{ code: '10006' }] }, { 'retry-after': '0' }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { voices: [] }));
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    await expect(client.getJson('/text-to-speech/voices')).resolves.toEqual({ voices: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 until the attempts are used up', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { errors: [{ code: '90103' }] }));
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    await expect(client.getJson('/text-to-speech/voices')).rejects.toThrow(TelnyxError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400 — a bad request stays bad', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(400, { errors: [{ code: '10015', detail: 'invalid voice' }] }),
      );
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    await expect(client.getJson('/text-to-speech/voices')).rejects.toThrow(/invalid voice/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries network failures and then reports them', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    await expect(client.getJson('/x')).rejects.toThrow(/Network error/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never leaks the API key into an error message', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(401, { errors: [{ detail: `bad token ${SECRET} via Bearer ${SECRET}` }] }),
      );
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    const error = await client.getJson('/x').catch((e: unknown) => e as Error);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('[REDACTED]');
  });

  it('returns audio bytes and the content type for binary posts', async () => {
    const audio = Buffer.from([0xff, 0xfb, 0x00, 0x00]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(audio, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
      );
    const client = new TelnyxClient(config, { fetchImpl, sleep });

    const result = await client.postBinary('/text-to-speech/speech', { text: 'hi' });

    expect(result.contentType).toBe('audio/mpeg');
    expect(result.data.equals(audio)).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({ text: 'hi' });
  });
});
