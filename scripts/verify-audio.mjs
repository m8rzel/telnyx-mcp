#!/usr/bin/env node
/**
 * Independent check of the hand-rolled MP3 layer.
 *
 * The unit tests verify the frame maths against this server's own parser. This
 * script verifies it against a *different* implementation: ffmpeg encodes a
 * tone, this code builds silence and joins the parts, and ffmpeg then decodes
 * and measures the result. Needs ffmpeg on PATH (or FFMPEG_PATH), so it is not
 * part of `npm test`.
 *
 *   npm run build && node scripts/verify-audio.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { concatMp3, createSilence, mp3Duration, templateFromMp3 } = await import('../dist/mp3.js');

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const work = mkdtempSync(path.join(tmpdir(), 'telnyx-mcp-verify-'));

/** ffmpeg writes its stream report to stderr, so both streams are collected. */
function run(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run "${ffmpeg}": ${result.error.message}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

const probe = (file, args = []) => run(['-i', file, ...args, '-f', 'null', '-']);

function volumeOf(file) {
  const match = /max_volume:\s*(-?[\d.]+) dB/.exec(probe(file, ['-af', 'volumedetect']));
  return match ? Number(match[1]) : NaN;
}

// A freshly encoded tone in the shape Telnyx Ultra returns: 24 kHz mono MP3.
const tonePath = path.join(work, 'tone.mp3');
run([
  '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.0:sample_rate=24000',
  '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '48k',
  '-write_xing', '0', '-id3v2_version', '0',
  tonePath,
]);

const tone = readFileSync(tonePath);
const template = templateFromMp3(tone);
const silence = createSilence(2, template);
const joined = concatMp3([tone, silence.buffer, tone]);

const silencePath = path.join(work, 'silence.mp3');
const joinedPath = path.join(work, 'joined.mp3');
writeFileSync(silencePath, silence.buffer);
writeFileSync(joinedPath, joined);

let failures = 0;
const check = (label, condition, detail) => {
  process.stdout.write(`${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`);
  if (!condition) failures += 1;
};

const silenceProbe = probe(silencePath);
check('ffmpeg decodes the generated silence', !/Error|Invalid data/i.test(silenceProbe));
check(
  'silence has the source sample rate and channel count',
  silenceProbe.includes(`${template.sampleRate} Hz`) &&
    silenceProbe.includes(template.channelMode === 3 ? 'mono' : 'stereo'),
);
check(
  'generated silence is digitally silent',
  volumeOf(silencePath) <= -90,
  `${volumeOf(silencePath)} dB`,
);

const expected = mp3Duration(tone) * 2 + silence.durationSeconds;
const joinedProbe = probe(joinedPath);
const duration = /Duration: (\d+):(\d+):([\d.]+)/.exec(joinedProbe);
const measured = duration
  ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])
  : NaN;
check(
  'ffmpeg measures the joined file as this server calculated',
  Math.abs(measured - expected) < 0.05,
  `ffmpeg ${measured.toFixed(2)} s vs calculated ${expected.toFixed(2)} s`,
);

process.stdout.write(`\nArtifacts: ${work}\n`);
process.exit(failures === 0 ? 0 : 1);
