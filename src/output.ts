import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class OutputPathError extends Error {}

const MAX_BASENAME_LENGTH = 80;

/**
 * Turns arbitrary user input into a safe file name stem: no separators, no
 * traversal, no leading dots, no control characters, no Windows reserved names.
 */
export function sanitizeFileStem(input: string, fallback = 'speech'): string {
  const base = path
    .basename(input)
    .replace(/\.mp3$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, MAX_BASENAME_LENGTH);

  if (!base || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return fallback;
  return base;
}

/** Short, collision-resistant suffix so repeated calls never overwrite each other. */
function uniqueSuffix(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}_${random}`;
}

/**
 * Resolves a target file inside `outputDir`. An explicit `fileName` is reduced
 * to its base name first, so "../../etc/passwd" can never escape the directory;
 * the result is verified to stay inside `outputDir` regardless.
 */
export function resolveOutputPath(outputDir: string, fileName?: string): string {
  const stem = fileName ? sanitizeFileStem(fileName) : `telnyx-tts_${uniqueSuffix()}`;
  const resolvedDir = path.resolve(outputDir);
  const target = path.resolve(resolvedDir, `${stem}.mp3`);

  const relative = path.relative(resolvedDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new OutputPathError(
      `Refusing to write outside the configured output directory (${resolvedDir}).`,
    );
  }
  return target;
}

/** Writes the MP3 and returns its absolute path. Creates the directory if needed. */
export async function writeAudioFile(
  outputDir: string,
  data: Buffer,
  fileName?: string,
): Promise<string> {
  const target = resolveOutputPath(outputDir, fileName);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, data);
  return target;
}
