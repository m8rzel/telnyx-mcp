import { describe, expect, it } from 'vitest';

import { packSentences, parseScript, scriptStats, splitSentences } from '../src/script.js';

describe('[PAUSE n] parsing', () => {
  it('turns a marker line into silence and keeps the text around it', () => {
    const items = parseScript('Atme ein.\n\n[PAUSE 5]\n\nUnd wieder aus.');
    expect(items).toEqual([
      { kind: 'speech', text: 'Atme ein.' },
      { kind: 'silence', seconds: 5 },
      { kind: 'speech', text: 'Und wieder aus.' },
    ]);
  });

  it('adds up consecutive markers', () => {
    const items = parseScript('Text.\n\n[PAUSE 5]\n\n[PAUSE 12]\n\nWeiter.');
    expect(items[1]).toEqual({ kind: 'silence', seconds: 17 });
  });

  it('accepts decimal seconds with comma or dot', () => {
    expect(parseScript('A.\n[PAUSE 2,5]\nB.')[1]).toEqual({ kind: 'silence', seconds: 2.5 });
    expect(parseScript('A.\n[PAUSE 0.75]\nB.')[1]).toEqual({ kind: 'silence', seconds: 0.75 });
  });

  it('is case insensitive and tolerates extra whitespace', () => {
    expect(parseScript('A.\n  [pause   3]  \nB.')[1]).toEqual({ kind: 'silence', seconds: 3 });
  });

  it('never speaks headings or horizontal rules', () => {
    const items = parseScript('# Überschrift\n\n---\n\nNur das hier.');
    expect(items).toEqual([{ kind: 'speech', text: 'Nur das hier.' }]);
  });

  it('drops the note block that explains the markers', () => {
    const script = [
      'Hinweis: Marker wie [PAUSE 2] werden nicht gesprochen.',
      '`[PAUSE 2]` = 2 Sekunden · `[PAUSE 5]` = 5 Sekunden',
      '',
      'Jetzt der echte Text.',
      '',
      '[PAUSE 4]',
    ].join('\n');
    const items = parseScript(script);
    expect(items).toEqual([
      { kind: 'speech', text: 'Jetzt der echte Text.' },
      { kind: 'silence', seconds: 4 },
    ]);
  });

  it('joins the lines of a paragraph into one segment', () => {
    const items = parseScript('Erste Zeile\nzweite Zeile\n\n[PAUSE 1]');
    expect(items[0]).toEqual({ kind: 'speech', text: 'Erste Zeile zweite Zeile' });
  });

  it('returns nothing speakable for a marker-only script', () => {
    expect(parseScript('[PAUSE 3]').filter((i) => i.kind === 'speech')).toHaveLength(0);
  });
});

describe('sentence-safe segmentation', () => {
  it('splits at sentence boundaries', () => {
    expect(splitSentences('Eins. Zwei! Drei? Vier…')).toEqual(['Eins.', 'Zwei!', 'Drei?', 'Vier…']);
  });

  it('packs sentences up to the limit without cutting one in half', () => {
    const sentences = ['A'.repeat(40) + '.', 'B'.repeat(40) + '.', 'C'.repeat(40) + '.'];
    const packed = packSentences(sentences, 90);
    expect(packed).toHaveLength(2);
    expect(packed[0]).toBe(`${sentences[0]} ${sentences[1]}`);
    expect(packed.every((segment) => segment.includes('.'))).toBe(true);
  });

  it('keeps an over-long single sentence whole and reports it', () => {
    const long = `${'x'.repeat(300)}.`;
    const items = parseScript(long, { maxChars: 100 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'speech' });
    expect(scriptStats(items, 100).overlongSegments).toBe(1);
  });

  it('rejects an unusable maxChars instead of silently defaulting', () => {
    expect(() => parseScript('Text.', { maxChars: 10 })).toThrow(/at least 50/);
  });
});

describe('script statistics', () => {
  it('counts only spoken characters, words and pauses', () => {
    const script = '# Titel\n\nHallo Welt. Noch ein Satz.\n\n[PAUSE 7]\n\n[PAUSE 3]\n\nEnde.';
    const stats = scriptStats(parseScript(script));
    expect(stats.speechSegments).toBe(2);
    expect(stats.silenceBlocks).toBe(1);
    expect(stats.totalPauseSeconds).toBe(10);
    expect(stats.characters).toBe('Hallo Welt. Noch ein Satz.'.length + 'Ende.'.length);
    expect(stats.words).toBe(6);
    expect(stats.overlongSegments).toBe(0);
  });
});
