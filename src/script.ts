/**
 * Markdown script parser for `[PAUSE n]` markers.
 *
 * Ported from the battle-tested Python skill used to render hypnosis scripts
 * (segmentation, pause folding, note-block filtering, sentence-safe packing).
 * Nothing is spoken that was not meant to be spoken: headings, horizontal
 * rules and the explanatory note block about the markers are dropped.
 */

export interface SpeechSegment {
  kind: 'speech';
  text: string;
}

export interface SilenceSegment {
  kind: 'silence';
  seconds: number;
}

export type ScriptItem = SpeechSegment | SilenceSegment;

/** A line consisting of nothing but a marker, e.g. "[PAUSE 12]". */
const BARE_PAUSE = /^\[PAUSE\s+(\d+(?:[.,]\d+)?)\]$/i;
/** Any marker occurrence, used to detect the legend/note block. */
const ANY_PAUSE = /\[PAUSE\s+\d+(?:[.,]\d+)?\]/i;
const HEADING = /^#{1,6}\s/;
const SEPARATOR = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const SENTENCE_BOUNDARY = /(?<=[.!?…])\s+/;

export interface ParseOptions {
  /** Maximum characters per synthesis request. Default 1800. */
  maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 1800;

/**
 * Parses a markdown script into an ordered list of speech and silence items.
 * Consecutive pauses are folded into one; paragraphs are packed into segments
 * of at most `maxChars` characters, never splitting a sentence.
 */
export function parseScript(markdown: string, options: ParseOptions = {}): ScriptItem[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 50) {
    throw new Error(`maxChars must be an integer of at least 50, got ${maxChars}.`);
  }

  const items: ScriptItem[] = [];
  let buffer: string[] = [];

  const flush = (): void => {
    const joined = buffer
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .trim();
    buffer = [];
    if (!joined) return;
    for (const text of packSentences(splitSentences(joined), maxChars)) {
      items.push({ kind: 'speech', text });
    }
  };

  const addSilence = (seconds: number): void => {
    const last = items[items.length - 1];
    if (last && last.kind === 'silence') {
      last.seconds += seconds;
    } else {
      items.push({ kind: 'silence', seconds });
    }
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || HEADING.test(line) || SEPARATOR.test(line)) {
      flush();
      continue;
    }

    const bare = BARE_PAUSE.exec(line);
    if (bare) {
      flush();
      addSilence(Number(bare[1]!.replace(',', '.')));
      continue;
    }

    if (ANY_PAUSE.test(line)) {
      // Contains a marker but is not a marker line on its own: this is the
      // note/legend block explaining the markers. Neither spoken nor paused.
      flush();
      continue;
    }

    buffer.push(line);
  }

  flush();
  return items;
}

/** Splits a paragraph at sentence boundaries. */
export function splitSentences(text: string): string[] {
  const parts = text
    .split(SENTENCE_BOUNDARY)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text.trim()].filter(Boolean);
}

/**
 * Packs sentences into segments of at most `maxChars`. A single sentence that
 * exceeds the limit is kept whole — a too-long segment is better than audio cut
 * mid-sentence; `overlongSegments` reports those to the caller.
 */
export function packSentences(sentences: string[], maxChars: number): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  let length = 0;

  for (const sentence of sentences) {
    const added = sentence.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && length + added > maxChars) {
      segments.push(current.join(' '));
      current = [sentence];
      length = sentence.length;
    } else {
      current.push(sentence);
      length += added;
    }
  }
  if (current.length > 0) segments.push(current.join(' '));
  return segments;
}

export interface ScriptStats {
  speechSegments: number;
  silenceBlocks: number;
  characters: number;
  words: number;
  longestSegmentChars: number;
  totalPauseSeconds: number;
  /** Segments longer than the limit because a single sentence exceeded it. */
  overlongSegments: number;
}

export function scriptStats(items: ScriptItem[], maxChars = DEFAULT_MAX_CHARS): ScriptStats {
  const speech = items.filter((i): i is SpeechSegment => i.kind === 'speech');
  const silence = items.filter((i): i is SilenceSegment => i.kind === 'silence');
  return {
    speechSegments: speech.length,
    silenceBlocks: silence.length,
    characters: speech.reduce((sum, s) => sum + s.text.length, 0),
    words: speech.reduce((sum, s) => sum + s.text.split(/\s+/).filter(Boolean).length, 0),
    longestSegmentChars: speech.reduce((max, s) => Math.max(max, s.text.length), 0),
    totalPauseSeconds: Number(silence.reduce((sum, s) => sum + s.seconds, 0).toFixed(3)),
    overlongSegments: speech.filter((s) => s.text.length > maxChars).length,
  };
}
