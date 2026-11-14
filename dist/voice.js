/**
 * Voice identifier handling and the provider capability matrix.
 *
 * Telnyx voice ids are dot separated: `Provider.Model.VoiceId`, or
 * `Provider.VoiceId` when a provider ships a single model. Model and voice ids
 * may themselves contain dots (e.g. `Minimax.speech-2.8-turbo.English_radiant_girl`),
 * so the split below is deliberately only used to identify provider and — for
 * Telnyx's own models — the model family. It never tries to reconstruct the id.
 */
export class VoiceError extends Error {
}
export function parseVoice(voice) {
    const trimmed = voice.trim();
    if (!trimmed)
        throw new VoiceError('Voice must not be empty.');
    const segments = trimmed.split('.').filter((s) => s.length > 0);
    if (segments.length < 2) {
        throw new VoiceError(`Voice "${voice}" is not in Provider.Model.VoiceId format (e.g. "Telnyx.Ultra.Clara" or "aws.Polly.Vicki").`);
    }
    const parts = { provider: segments[0].toLowerCase(), raw: trimmed };
    if (segments.length > 2)
        parts.model = segments[1].toLowerCase();
    return parts;
}
/**
 * Source: https://developers.telnyx.com/docs/voice/tts (provider pages,
 * retrieved 2026-11-13). Telnyx has no global rate field — Ultra/Grok use
 * `voice_settings.voice_speed`, Minimax/Soniox use `voice_settings.speed`,
 * and only AWS Polly and Azure accept SSML (`text_type: "ssml"`), where the
 * rate is expressed as `<prosody rate="85%">`.
 */
export function rateSupportFor(voice) {
    const { provider, model, raw } = parseVoice(voice);
    if (provider === 'telnyx') {
        if (model === 'ultra' || model === 'grok') {
            return { kind: 'voice_speed', min: 0.5, max: 2.0 };
        }
        const modelName = raw.split('.')[1];
        return {
            kind: 'unsupported',
            reason: model === undefined
                ? 'Telnyx voices without an explicit model do not expose a speaking rate.'
                : `Telnyx.${modelName} exposes no speaking-rate control (only Ultra and Grok do).`,
        };
    }
    if (provider === 'minimax')
        return { kind: 'speed', min: 0.5, max: 2.0 };
    if (provider === 'soniox')
        return { kind: 'speed', min: 0.7, max: 1.3 };
    if (provider === 'aws' || provider === 'azure')
        return { kind: 'ssml', min: 0.2, max: 2.0 };
    return {
        kind: 'unsupported',
        reason: `Provider "${provider}" exposes no speaking-rate control via the Telnyx API and does not accept SSML. ` +
            `Rate works with Telnyx.Ultra.*, Telnyx.Grok.*, Minimax.*, Soniox.* (native speed) and aws.Polly.* / azure.* (SSML prosody).`,
    };
}
/** Escapes text for inclusion in an SSML document. */
export function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}
/** Wraps plain text in `<speak><prosody rate="…%">` for Polly/Azure. */
export function buildSsml(text, rate) {
    const percent = Math.round(rate * 100);
    return `<speak><prosody rate="${percent}%">${escapeXml(text)}</prosody></speak>`;
}
