import { describe, expect, it } from 'vitest';

import {
  concatMp3,
  createSilence,
  frameDuration,
  id3v2Size,
  mp3Duration,
  Mp3ParseError,
  parseFrameHeader,
  parseMp3,
  sideInfoSize,
  templateFromMp3,
} from '../src/mp3.js';

import {
  tone24kMono as tone24k,
  tone44kMonoXing as tone44kXing,
  tone44kStereo,
} from './fixtures/index.js';

describe('frame header parsing', () => {
  it('reads the format of a real MPEG-2 Layer III frame', () => {
    const header = parseFrameHeader(tone24k, id3v2Size(tone24k));
    expect(header).not.toBeNull();
    expect(header!.version).toBe('MPEG2');
    expect(header!.layer).toBe(3);
    expect(header!.sampleRate).toBe(24000);
    expect(header!.channels).toBe(1);
    expect(header!.bitrateKbps).toBe(24);
    expect(header!.samplesPerFrame).toBe(576);
  });

  it('rejects data that is not a frame header', () => {
    expect(parseFrameHeader(Buffer.from([0x00, 0x00, 0x00, 0x00]), 0)).toBeNull();
    expect(parseFrameHeader(Buffer.from([0xff, 0xff, 0xff, 0xff]), 0)).toBeNull();
  });

  it('knows the Layer III side info sizes', () => {
    expect(sideInfoSize('MPEG1', 1)).toBe(17);
    expect(sideInfoSize('MPEG1', 2)).toBe(32);
    expect(sideInfoSize('MPEG2', 1)).toBe(9);
    expect(sideInfoSize('MPEG2.5', 2)).toBe(17);
  });
});

describe('duration measurement', () => {
  it('measures a 0.2 s file to within one frame', () => {
    const duration = mp3Duration(tone24k);
    expect(duration).toBeGreaterThan(0.18);
    expect(duration).toBeLessThan(0.3); // encoder delay and padding
  });

  it('ignores the Xing header frame', () => {
    const info = parseMp3(tone44kXing);
    const tagFrames = info.frames.filter((f) => f.isTagFrame);
    expect(tagFrames).toHaveLength(1);
    expect(info.durationSeconds).toBeGreaterThan(0.18);
    expect(info.durationSeconds).toBeLessThan(0.3);
  });

  it('skips a leading ID3v2 tag', () => {
    const tag = Buffer.alloc(10);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 3;
    tag[9] = 20; // 20 bytes of payload, synchsafe
    const withTag = Buffer.concat([tag, Buffer.alloc(20), tone24k]);
    expect(id3v2Size(withTag)).toBe(30);
    expect(mp3Duration(withTag)).toBeCloseTo(mp3Duration(tone24k), 3);
  });

  it('throws a readable error when the payload is not MP3', () => {
    expect(() => mp3Duration(Buffer.from('{"errors":[]}', 'utf8'))).toThrow(Mp3ParseError);
    expect(() => mp3Duration(Buffer.from('{"errors":[]}', 'utf8'))).toThrow(/not MP3/i);
  });
});

describe('silence generation', () => {
  const template = templateFromMp3(tone24k);

  it('derives the template from the source audio', () => {
    expect(template).toMatchObject({ version: 'MPEG2', sampleRate: 24000, bitrateKbps: 24 });
  });

  it('produces frames a parser accepts, with the requested length', () => {
    const silence = createSilence(2, template);
    const parsed = parseMp3(silence.buffer);
    expect(parsed.frames.every((f) => !f.isTagFrame)).toBe(true);
    expect(parsed.frames).toHaveLength(silence.frameCount);
    expect(parsed.durationSeconds).toBeCloseTo(silence.durationSeconds, 6);
    expect(silence.durationSeconds).toBeCloseTo(2, 1);
  });

  it('reports the frame-aligned duration, not the requested one', () => {
    const perFrame = frameDuration(template); // 24 ms at 24 kHz
    const silence = createSilence(1.01, template);
    expect(silence.frameCount).toBe(Math.round(1.01 / perFrame));
    expect(silence.durationSeconds).toBe(silence.frameCount * perFrame);
  });

  it('writes a payload of zero bytes after each header (silent granules)', () => {
    const silence = createSilence(0.1, template);
    const frame = parseFrameHeader(silence.buffer, 0)!;
    const payload = silence.buffer.subarray(4, frame.length);
    expect(payload.every((byte) => byte === 0)).toBe(true);
    expect(frame.hasCrc).toBe(false);
  });

  it('returns an empty buffer for zero seconds and rejects negatives', () => {
    expect(createSilence(0, template).buffer).toHaveLength(0);
    expect(() => createSilence(-1, template)).toThrow(Mp3ParseError);
  });

  it('matches the source sample rate for a 44.1 kHz stereo template', () => {
    const stereoTemplate = templateFromMp3(tone44kStereo);
    const silence = createSilence(0.5, stereoTemplate);
    const parsed = parseMp3(silence.buffer);
    expect(parsed.frames[0]!.sampleRate).toBe(44100);
    expect(parsed.frames[0]!.channels).toBe(2);
    expect(parsed.durationSeconds).toBeCloseTo(0.5, 1);
  });
});

describe('concatenation', () => {
  it('adds up the durations of speech and silence', () => {
    const template = templateFromMp3(tone24k);
    const silence = createSilence(1.5, template);
    const joined = concatMp3([tone24k, silence.buffer, tone24k]);
    const expected = mp3Duration(tone24k) * 2 + silence.durationSeconds;
    expect(mp3Duration(joined)).toBeCloseTo(expected, 3);
  });

  it('drops the Xing header of the parts so it cannot mislead players', () => {
    const joined = concatMp3([tone44kXing, tone44kXing]);
    expect(parseMp3(joined).frames.some((f) => f.isTagFrame)).toBe(false);
    expect(mp3Duration(joined)).toBeCloseTo(mp3Duration(tone44kXing) * 2, 3);
  });

  it('refuses to mix incompatible formats instead of producing broken audio', () => {
    expect(() => concatMp3([tone24k, tone44kStereo])).toThrow(/different audio formats/i);
  });

  it('ignores empty parts', () => {
    expect(concatMp3([])).toHaveLength(0);
    expect(mp3Duration(concatMp3([Buffer.alloc(0), tone24k]))).toBeCloseTo(mp3Duration(tone24k), 3);
  });
});
