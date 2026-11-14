import { concatMp3, createSilence, mp3Duration, templateFromMp3, } from './mp3.js';
import { parseScript, scriptStats, DEFAULT_MAX_CHARS } from './script.js';
import { synthesize } from './speech.js';
function round(value) {
    return Number(value.toFixed(3));
}
/**
 * Renders a markdown script with `[PAUSE n]` markers into one continuous MP3.
 *
 * Speech is synthesised first so the silence can be built with exactly the
 * audio format Telnyx returned; everything is then joined on frame level
 * without re-encoding.
 */
export async function renderScript(client, markdown, options) {
    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    const items = parseScript(markdown, { maxChars });
    const stats = scriptStats(items, maxChars);
    if (stats.speechSegments === 0) {
        throw new Error('The script contains no speakable text (only markers, headings or blank lines).');
    }
    const speechIndices = items
        .map((item, index) => ({ item, index }))
        .filter((entry) => entry.item.kind === 'speech');
    const audioByIndex = new Map();
    let characters = 0;
    for (const [done, entry] of speechIndices.entries()) {
        const { audio, characters: used } = await synthesize(client, {
            ...options,
            text: entry.item.text,
        });
        audioByIndex.set(entry.index, audio);
        characters += used;
        options.onProgress?.(done + 1, speechIndices.length);
    }
    const first = audioByIndex.get(speechIndices[0].index);
    const template = templateFromMp3(first);
    const parts = [];
    const buffers = [];
    let speechDuration = 0;
    let silenceDuration = 0;
    const pushSilence = (seconds, index) => {
        if (seconds <= 0)
            return;
        const silence = createSilence(seconds, template);
        if (silence.frameCount === 0)
            return;
        buffers.push(silence.buffer);
        silenceDuration += silence.durationSeconds;
        const part = {
            index,
            kind: 'silence',
            durationSeconds: round(silence.durationSeconds),
        };
        if (Math.abs(silence.durationSeconds - seconds) > 0.001)
            part.requestedSeconds = seconds;
        parts.push(part);
    };
    pushSilence(options.leadInSeconds ?? 0, -1);
    for (const [index, item] of items.entries()) {
        if (item.kind === 'silence') {
            pushSilence(item.seconds, index);
            continue;
        }
        const audio = audioByIndex.get(index);
        const duration = mp3Duration(audio);
        buffers.push(audio);
        speechDuration += duration;
        parts.push({
            index,
            kind: 'speech',
            durationSeconds: round(duration),
            characters: item.text.length,
            preview: item.text.length > 60 ? `${item.text.slice(0, 60)}…` : item.text,
        });
    }
    pushSilence(options.leadOutSeconds ?? 0, items.length);
    const audio = concatMp3(buffers);
    return {
        audio,
        totalDurationSeconds: round(speechDuration + silenceDuration),
        speechDurationSeconds: round(speechDuration),
        silenceDurationSeconds: round(silenceDuration),
        characters,
        parts,
        template,
    };
}
