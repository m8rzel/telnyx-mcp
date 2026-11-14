export const DEFAULT_VOICE_LIMIT = 50;
export const MAX_VOICE_LIMIT = 200;
/** The catalogue has thousands of entries and changes rarely — cache it. */
const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;
export function clearVoiceCache() {
    cache = null;
}
export async function fetchVoices(client, now = Date.now()) {
    if (cache && now - cache.fetchedAt < CACHE_TTL_MS)
        return cache.voices;
    const payload = await client.getJson('/text-to-speech/voices');
    const voices = payload.voices ?? payload.data ?? [];
    cache = { fetchedAt: now, voices };
    return voices;
}
function voiceId(voice) {
    return String(voice.id ?? voice.voice_id ?? voice.name ?? '');
}
/**
 * "de-DE" matches only de-DE; the bare prefix "de" matches every German
 * variant (de-DE, de-AT, de-CH). Mixing those up would silently widen a
 * deliberately narrow filter.
 */
function matchesLanguage(voice, wanted) {
    const language = String(voice.language ?? '').toLowerCase();
    if (!language)
        return false;
    const want = wanted.toLowerCase();
    if (want.includes('-'))
        return language === want;
    return language === want || language.startsWith(`${want}-`);
}
function matchesSearch(voice, needle) {
    const haystack = [voice.name, voiceId(voice), voice.accent, voice.label, voice.gender]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
    return haystack.includes(needle.toLowerCase());
}
/**
 * Filters and pages the voice catalogue. The full list has thousands of
 * entries, so results are always capped and reported as "returned of matched
 * of total" instead of being dumped into the conversation.
 */
export function filterVoices(voices, filter = {}) {
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_VOICE_LIMIT, 1), MAX_VOICE_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);
    const matched = voices.filter((voice) => {
        if (filter.provider &&
            String(voice.provider ?? '').toLowerCase() !== filter.provider.toLowerCase()) {
            // Fall back to the id prefix when the provider field is absent.
            const prefix = voiceId(voice).split('.')[0]?.toLowerCase();
            if (prefix !== filter.provider.toLowerCase())
                return false;
        }
        if (filter.language && !matchesLanguage(voice, filter.language))
            return false;
        if (filter.search && !matchesSearch(voice, filter.search))
            return false;
        return true;
    });
    const providers = {};
    for (const voice of matched) {
        const key = String(voice.provider ?? voiceId(voice).split('.')[0] ?? 'unknown').toLowerCase();
        providers[key] = (providers[key] ?? 0) + 1;
    }
    const page = matched.slice(offset, offset + limit).map((voice) => {
        const summary = { id: voiceId(voice) };
        if (voice.name)
            summary.name = String(voice.name);
        if (voice.provider)
            summary.provider = String(voice.provider);
        if (voice.language)
            summary.language = String(voice.language);
        if (voice.gender)
            summary.gender = String(voice.gender);
        return summary;
    });
    return {
        total: voices.length,
        matched: matched.length,
        returned: page.length,
        offset,
        voices: page,
        providers,
    };
}
