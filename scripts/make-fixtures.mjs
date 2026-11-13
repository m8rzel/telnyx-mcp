#!/usr/bin/env node
/**
 * Regenerates tests/fixtures/index.ts.
 *
 * The MP3 test fixtures must come from a real encoder (LAME, via ffmpeg), not
 * from this repository's own frame builder — otherwise the parser would only
 * ever be tested against its own output. Needs ffmpeg on PATH (or FFMPEG_PATH).
 *
 *   node scripts/make-fixtures.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const work = mkdtempSync(path.join(tmpdir(), 'telnyx-mcp-fixtures-'));

const specs = [
  {
    file: 'tone-24k-mono.mp3',
    constant: 'TONE_24K_MONO',
    doc: '0.2 s sine, 24 kHz mono, 24 kbps, no Xing header — the shape Telnyx Ultra returns.',
    args: ['sine=frequency=440:duration=0.2:sample_rate=24000', 1, 24000, '24k', 0],
  },
  {
    file: 'tone-44k-mono-xing.mp3',
    constant: 'TONE_44K_MONO_XING',
    doc: '0.2 s sine, 44.1 kHz mono, 32 kbps, with an Info/Xing header frame.',
    args: ['sine=frequency=330:duration=0.2:sample_rate=44100', 1, 44100, '32k', 1],
  },
  {
    file: 'tone-44k-stereo.mp3',
    constant: 'TONE_44K_STEREO',
    doc: '0.2 s sine, 44.1 kHz stereo, 64 kbps — used to test format mismatches.',
    args: ['sine=frequency=220:duration=0.2:sample_rate=44100', 2, 44100, '64k', 0],
  },
];

const encoded = specs.map((spec) => {
  const [source, channels, rate, bitrate, xing] = spec.args;
  const target = path.join(work, spec.file);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', source,
    '-ac', String(channels), '-ar', String(rate),
    '-c:a', 'libmp3lame', '-b:a', bitrate,
    '-write_xing', String(xing),
    ...(xing ? [] : ['-id3v2_version', '0']),
    target,
  ];
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed for ${spec.file}: ${result.stderr || result.error?.message}`);
  }
  return { ...spec, base64: readFileSync(target).toString('base64') };
});

const body = encoded
  .map(
    (spec) =>
      `/* prettier-ignore */\n/** ${spec.doc} */\nconst ${spec.constant} =\n  '${spec.base64}';\n`,
  )
  .join('\n');

const output = `/**
 * Real MP3 test fixtures, encoded by LAME (via ffmpeg) rather than by this
 * repository's own code — otherwise the frame parser would only ever be tested
 * against its own output. They are embedded as base64 so the repository holds no
 * binary blobs; each is a 0.2 s sine tone, which is enough to exercise every
 * header, Xing and format-mismatch path.
 *
 * Regenerate with \`node scripts/make-fixtures.mjs\` (needs ffmpeg on PATH).
 */

${body}
const decode = (value: string): Buffer => Buffer.from(value, 'base64');

export const tone24kMono = decode(TONE_24K_MONO);
export const tone44kMonoXing = decode(TONE_44K_MONO_XING);
export const tone44kStereo = decode(TONE_44K_STEREO);
`;

const destination = new URL('../tests/fixtures/index.ts', import.meta.url);
writeFileSync(destination, output);
process.stdout.write(`Wrote ${path.basename(destination.pathname)} from ${work}\n`);
