import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, redact } from '../src/config.js';
import { OutputPathError, resolveOutputPath, sanitizeFileStem } from '../src/output.js';

describe('configuration', () => {
  it('fails loudly when the API key is missing', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ TELNYX_API_KEY: '  ' })).toThrow(/Missing TELNYX_API_KEY/);
  });

  it('defaults the output directory to a folder in the OS temp dir', () => {
    const config = loadConfig({ TELNYX_API_KEY: 'k' });
    expect(config.outputDir).toBe(path.join(tmpdir(), 'telnyx-mcp'));
    expect(config.timeoutMs).toBe(120_000);
    expect(config.maxRetries).toBe(3);
  });

  it('resolves a relative output directory to an absolute path', () => {
    const config = loadConfig({ TELNYX_API_KEY: 'k', TELNYX_TTS_OUTPUT_DIR: './audio' });
    expect(path.isAbsolute(config.outputDir)).toBe(true);
  });

  it('rejects nonsense numbers instead of silently using them', () => {
    expect(() => loadConfig({ TELNYX_API_KEY: 'k', TELNYX_TTS_TIMEOUT_MS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => loadConfig({ TELNYX_API_KEY: 'k', TELNYX_TTS_MAX_RETRIES: 'nope' })).toThrow(
      ConfigError,
    );
  });
});

describe('redaction', () => {
  it('removes the key and anything that looks like a bearer token', () => {
    const key = 'KEYSUPERSECRETVALUE12345';
    expect(redact(`auth failed for ${key}`, key)).toBe('auth failed for [REDACTED]');
    expect(redact('Authorization: Bearer abc.def-123')).toBe('Authorization: Bearer [REDACTED]');
  });
});

describe('output paths', () => {
  const dir = '/tmp/telnyx-mcp-test';

  it('strips directories and traversal from a file name', () => {
    expect(sanitizeFileStem('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileStem('/absolute/path/audio.mp3')).toBe('audio');
    expect(sanitizeFileStem('..')).toBe('speech');
  });

  it('keeps umlauts but replaces separators and control characters', () => {
    expect(sanitizeFileStem('Trance Übung 1')).toBe('Trance-Übung-1');
    expect(sanitizeFileStem('a\u0000b')).toBe('ab');
  });

  it('always resolves inside the output directory', () => {
    expect(resolveOutputPath(dir, 'take-1')).toBe(path.join(dir, 'take-1.mp3'));
    expect(resolveOutputPath(dir, '../../escape')).toBe(path.join(dir, 'escape.mp3'));
    expect(resolveOutputPath(dir, 'x/y/z.mp3')).toBe(path.join(dir, 'z.mp3'));
  });

  it('generates a unique name when none is given', () => {
    const a = resolveOutputPath(dir);
    const b = resolveOutputPath(dir);
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.resolve(dir));
    expect(a.endsWith('.mp3')).toBe(true);
  });

  it('exports an error type for callers to catch', () => {
    expect(new OutputPathError('x')).toBeInstanceOf(Error);
  });
});
