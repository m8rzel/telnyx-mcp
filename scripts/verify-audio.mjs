#!/usr/bin/env node
/**
 * Independent check of the hand-rolled MP3 layer.
 *
 * The unit tests verify the frame maths against the server's own parser. This
 * script verifies it against a *different* implementation: it builds silence
 * and a joined file, then has ffmpeg decode them and measure the result. Needs
 * ffmpeg on PATH (or FFMPEG_PATH) and is therefore not part of `npm test`.
 *
 *   node scripts/verify-audio.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { concatMp3, createSilence, mp3Duration, templateFromMp3 } = await import('../dist/mp3.js');

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const work = mkdtempSync(path.join(tmpdir(), 'telnyx-mcp-verify-'));

const tones = JSON.parse(
  readFileSync(new URL('../tests/fixtures/tones.base64.json', import.meta.url), 'utf8'),
);
const tone = Buffer.from(tones['tone-24k-mono'], 'base64');
const template = templateFromMp3(tone);

const silence = createSilence(2, template);
const joined = concatMp3([tone, silence.buffer, tone]);

const silencePath = path.join(work, 'silence.mp3');
const joinedPath = path.join(work, 'joined.mp3');
writeFileSync(silencePath, silence.buffer);
writeFileSync(joinedPath, joined);

/** ffmpeg writes its stream report to stderr, so both streams are collected. */
function probe(file, args = []) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file, ...args, '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  if (result.error) {
    throw new Error(`Could not run "${ffmpeg}": ${result.error.message}`);
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

function volumeOf(file) {
  const match = /max_volume:\s*(-?[\d.]+) dB/.exec(probe(file, ['-af', 'volumedetect']));
  return match ? Number(match[1]) : NaN;
}

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
