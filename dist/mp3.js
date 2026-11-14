/**
 * Minimal MPEG audio (MP3) frame toolkit — no external dependencies, no ffmpeg.
 *
 * Why hand-rolled: the server only needs three things from an MP3 — walk the
 * frames, measure the exact duration, and concatenate segments with silence in
 * between. All three are pure header arithmetic for MPEG Layer III; pulling in
 * ffmpeg (a ~70 MB binary) or a decoder library for that would be a far bigger
 * dependency than the ~200 lines below. Audio is never decoded or re-encoded,
 * so joining is lossless.
 *
 * Silence is produced as real MPEG Layer III frames whose payload is all zero
 * bytes: with the protection bit set to "no CRC", every byte after the 4-byte
 * header belongs to the side info / main data, and an all-zero side info means
 * part2_3_length = 0 for every granule — the decoder reads no main data and
 * outputs silence of exactly one frame length.
 */
const BITRATES_V1_L3 = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1,
];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1];
const BITRATES_V1_L2 = [
    0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1,
];
const BITRATES_V1_L1 = [
    0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1,
];
const BITRATES_V2_L1 = [
    0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1,
];
const SAMPLE_RATES = {
    MPEG1: [44100, 48000, 32000],
    MPEG2: [22050, 24000, 16000],
    'MPEG2.5': [11025, 12000, 8000],
};
function bitrateTable(version, layer) {
    if (version === 'MPEG1') {
        if (layer === 3)
            return BITRATES_V1_L3;
        if (layer === 2)
            return BITRATES_V1_L2;
        return BITRATES_V1_L1;
    }
    // MPEG2 / MPEG2.5 share one table for layers II and III.
    return layer === 1 ? BITRATES_V2_L1 : BITRATES_V2_L3;
}
function samplesPerFrame(version, layer) {
    if (layer === 1)
        return 384;
    if (layer === 2)
        return 1152;
    return version === 'MPEG1' ? 1152 : 576;
}
/** Side info size in bytes for Layer III, which is all-zero in a silent frame. */
export function sideInfoSize(version, channels) {
    if (version === 'MPEG1')
        return channels === 1 ? 17 : 32;
    return channels === 1 ? 9 : 17;
}
/** Size of the ID3v2 tag at the start of the buffer, or 0 when there is none. */
export function id3v2Size(buffer) {
    if (buffer.length < 10)
        return 0;
    if (buffer[0] !== 0x49 || buffer[1] !== 0x44 || buffer[2] !== 0x33)
        return 0; // "ID3"
    const flags = buffer[5] ?? 0;
    const size = ((buffer[6] ?? 0) & 0x7f) * 0x200000 +
        ((buffer[7] ?? 0) & 0x7f) * 0x4000 +
        ((buffer[8] ?? 0) & 0x7f) * 0x80 +
        ((buffer[9] ?? 0) & 0x7f);
    const footer = (flags & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footer;
}
/** Parses a frame header at `offset`, or returns null when it is not a valid frame. */
export function parseFrameHeader(buffer, offset) {
    if (offset + 4 > buffer.length)
        return null;
    const b0 = buffer[offset] ?? 0;
    const b1 = buffer[offset + 1] ?? 0;
    const b2 = buffer[offset + 2] ?? 0;
    const b3 = buffer[offset + 3] ?? 0;
    if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0)
        return null;
    const versionBits = (b1 >> 3) & 0x03;
    if (versionBits === 1)
        return null; // reserved
    const version = versionBits === 3 ? 'MPEG1' : versionBits === 2 ? 'MPEG2' : 'MPEG2.5';
    const layerBits = (b1 >> 1) & 0x03;
    if (layerBits === 0)
        return null; // reserved
    const layer = 4 - layerBits;
    const hasCrc = (b1 & 0x01) === 0;
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const bitrateKbps = bitrateTable(version, layer)[bitrateIndex] ?? -1;
    if (bitrateKbps <= 0)
        return null; // "free" or "bad" bitrate
    const sampleRateIndex = (b2 >> 2) & 0x03;
    const sampleRate = SAMPLE_RATES[version][sampleRateIndex] ?? 0;
    if (!sampleRate)
        return null;
    const padding = ((b2 >> 1) & 0x01) === 1;
    const channelMode = (b3 >> 6) & 0x03;
    const modeExtension = (b3 >> 4) & 0x03;
    const channels = channelMode === 3 ? 1 : 2;
    const spf = samplesPerFrame(version, layer);
    const paddingBytes = padding ? (layer === 1 ? 4 : 1) : 0;
    const length = layer === 1
        ? (Math.floor((12 * bitrateKbps * 1000) / sampleRate) + (padding ? 1 : 0)) * 4
        : Math.floor((spf / 8) * ((bitrateKbps * 1000) / sampleRate)) + paddingBytes;
    if (length <= 4)
        return null;
    const header = {
        offset,
        length,
        version,
        layer,
        bitrateKbps,
        sampleRate,
        channelMode,
        channels,
        modeExtension,
        padding,
        hasCrc,
        copyright: ((b3 >> 3) & 0x01) === 1,
        original: ((b3 >> 2) & 0x01) === 1,
        emphasis: b3 & 0x03,
        samplesPerFrame: spf,
        isTagFrame: false,
    };
    header.isTagFrame = isXingOrVbriFrame(buffer, header);
    return header;
}
/**
 * Detects Xing/Info/VBRI header frames, which hold metadata instead of audio.
 * The magic words sit at fixed offsets (right after the side info for Xing/Info,
 * at header + 32 for VBRI), so this cannot false-positive on audio data.
 */
function isXingOrVbriFrame(buffer, header) {
    if (header.layer !== 3)
        return false;
    const base = header.offset + 4 + (header.hasCrc ? 2 : 0);
    const xingAt = base + sideInfoSize(header.version, header.channels);
    if (xingAt + 4 <= buffer.length) {
        const tag = buffer.subarray(xingAt, xingAt + 4).toString('latin1');
        if (tag === 'Xing' || tag === 'Info')
            return true;
    }
    const vbriAt = header.offset + 36;
    if (vbriAt + 4 <= buffer.length) {
        if (buffer.subarray(vbriAt, vbriAt + 4).toString('latin1') === 'VBRI')
            return true;
    }
    return false;
}
export class Mp3ParseError extends Error {
}
/**
 * Walks every frame of an MP3 buffer. Leading ID3v2 tags and trailing junk are
 * skipped; a Xing/Info frame is reported but flagged via `isTagFrame`.
 */
export function parseMp3(buffer) {
    const frames = [];
    let offset = id3v2Size(buffer);
    let resyncs = 0;
    while (offset + 4 <= buffer.length) {
        const header = parseFrameHeader(buffer, offset);
        if (!header) {
            // Resynchronise on the next 0xFF byte — handles ID3v1/APE trailers and
            // stray bytes between chunks of a streamed response.
            const next = buffer.indexOf(0xff, offset + 1);
            if (next === -1)
                break;
            resyncs += 1;
            if (resyncs > 10_000)
                break;
            offset = next;
            continue;
        }
        frames.push(header);
        offset += header.length;
    }
    const audioFrames = frames.filter((f) => !f.isTagFrame);
    if (audioFrames.length === 0) {
        throw new Mp3ParseError('No MPEG audio frames found. The response was not MP3 — check that the selected voice returns audio/mpeg.');
    }
    const durationSeconds = audioFrames.reduce((sum, f) => sum + f.samplesPerFrame / f.sampleRate, 0);
    const first = audioFrames[0];
    const last = audioFrames[audioFrames.length - 1];
    return {
        frames,
        durationSeconds,
        audioStart: first.offset,
        audioEnd: Math.min(last.offset + last.length, buffer.length),
    };
}
/** Audio payload without ID3 tags and without a Xing/Info header frame. */
export function audioFramesOnly(buffer) {
    const info = parseMp3(buffer);
    return buffer.subarray(info.audioStart, info.audioEnd);
}
/** Exact duration in seconds of an MP3 buffer. */
export function mp3Duration(buffer) {
    return parseMp3(buffer).durationSeconds;
}
/** Derives a silence template from the first audio frame of an MP3 buffer. */
export function templateFromMp3(buffer) {
    const info = parseMp3(buffer);
    const frame = info.frames.find((f) => !f.isTagFrame);
    if (frame.layer !== 3) {
        throw new Mp3ParseError(`Only MPEG Layer III is supported for joining, got Layer ${frame.layer}. Request MP3 output from the voice.`);
    }
    return {
        version: frame.version,
        layer: frame.layer,
        bitrateKbps: frame.bitrateKbps,
        sampleRate: frame.sampleRate,
        channelMode: frame.channelMode,
        copyright: frame.copyright,
        original: frame.original,
        emphasis: frame.emphasis,
    };
}
function bitrateIndexFor(template) {
    const table = bitrateTable(template.version, template.layer);
    const index = table.indexOf(template.bitrateKbps);
    if (index <= 0) {
        throw new Mp3ParseError(`Bitrate ${template.bitrateKbps} kbps is not valid for ${template.version} Layer ${template.layer}.`);
    }
    return index;
}
function sampleRateIndexFor(template) {
    const index = SAMPLE_RATES[template.version].indexOf(template.sampleRate);
    if (index < 0) {
        throw new Mp3ParseError(`Sample rate ${template.sampleRate} Hz is not valid for ${template.version}.`);
    }
    return index;
}
/** Duration of a single frame built from `template`, in seconds. */
export function frameDuration(template) {
    return samplesPerFrame(template.version, template.layer) / template.sampleRate;
}
/**
 * Builds real MPEG Layer III silence matching `template`. Frame count is rounded
 * to the nearest whole frame, so the returned duration is what the file will
 * actually contain — never the requested value when they differ.
 */
export function createSilence(seconds, template) {
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Mp3ParseError(`Silence length must be a non-negative number, got ${seconds}.`);
    }
    const perFrame = frameDuration(template);
    const frameCount = Math.round(seconds / perFrame);
    if (frameCount === 0) {
        return { buffer: Buffer.alloc(0), durationSeconds: 0, frameCount: 0 };
    }
    const spf = samplesPerFrame(template.version, template.layer);
    const frameLength = Math.floor((spf / 8) * ((template.bitrateKbps * 1000) / template.sampleRate)) + 0; // no padding: frame duration is independent of it
    const versionBits = template.version === 'MPEG1' ? 0b11 : template.version === 'MPEG2' ? 0b10 : 0;
    const layerBits = 4 - template.layer;
    const channels = template.channelMode === 3 ? 1 : 2;
    const header = Buffer.alloc(4);
    header[0] = 0xff;
    header[1] = 0xe0 | (versionBits << 3) | (layerBits << 1) | 0x01; // protection bit 1 = no CRC
    header[2] = (bitrateIndexFor(template) << 4) | (sampleRateIndexFor(template) << 2);
    header[3] =
        (template.channelMode << 6) |
            (0 << 4) |
            ((template.copyright ? 1 : 0) << 3) |
            ((template.original ? 1 : 0) << 2) |
            (template.emphasis & 0x03);
    // Sanity check: the side info must fit, otherwise the bitrate is too low for
    // this channel mode and the frame would be malformed.
    const needed = 4 + sideInfoSize(template.version, channels);
    if (frameLength < needed) {
        throw new Mp3ParseError(`Frame length ${frameLength} bytes is too small for ${channels}-channel ${template.version} side info (${needed} bytes needed).`);
    }
    const frame = Buffer.alloc(frameLength); // zero payload = silent granules
    header.copy(frame, 0);
    const buffer = Buffer.alloc(frameLength * frameCount);
    for (let i = 0; i < frameCount; i += 1) {
        frame.copy(buffer, i * frameLength);
    }
    return { buffer, durationSeconds: frameCount * perFrame, frameCount };
}
/** True when two MP3 buffers can be concatenated without re-encoding. */
export function isCompatible(a, b) {
    return (a.version === b.version &&
        a.layer === b.layer &&
        a.sampleRate === b.sampleRate &&
        (a.channelMode === 3) === (b.channelMode === 3));
}
/**
 * Concatenates MP3 buffers on frame level (no decoding, no re-encoding). All
 * parts must share version, layer, sample rate and channel count; bitrate may
 * differ (the result is then variable bitrate, which every decoder handles).
 */
export function concatMp3(parts) {
    const nonEmpty = parts.filter((p) => p.length > 0);
    if (nonEmpty.length === 0)
        return Buffer.alloc(0);
    const cleaned = [];
    let reference = null;
    for (const part of nonEmpty) {
        const template = templateFromMp3(part);
        if (reference === null) {
            reference = template;
        }
        else if (!isCompatible(reference, template)) {
            throw new Mp3ParseError(`Cannot join MP3 parts with different audio formats: ${reference.version}/${reference.sampleRate} Hz/` +
                `${reference.channelMode === 3 ? 'mono' : 'stereo'} vs ${template.version}/${template.sampleRate} Hz/` +
                `${template.channelMode === 3 ? 'mono' : 'stereo'}. Use identical voice settings for every segment.`);
        }
        cleaned.push(audioFramesOnly(part));
    }
    return Buffer.concat(cleaned);
}
