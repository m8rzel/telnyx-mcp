import type { TelnyxClient } from './telnyx.js';

export interface TelnyxVoice {
  id?: string;
  voice_id?: string;
  name?: string;
  provider?: string;
  model_id?: string;
  language?: string;
  gender?: string;
  accent?: string;
  age?: string;
  label?: string;
  [key: string]: unknown;
}

export interface VoiceSummary {
  /** Identifier to pass to `speak`, e.g. "Telnyx.Ultra.Clara". */
  id: string;
  name?: string;
  provider?: string;
  language?: string;
  gender?: string;
}

export interface VoiceFilter {
  /** BCP-47 code or language prefix, e.g. "de" or "de-DE". */
  language?: string;
  /** Provider segment, e.g. "telnyx", "aws", "elevenlabs". */
  provider?: string;
  /** Free-text match against id, name, accent and label. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface VoiceListResult {
  total: number;
  matched: number;
  returned: number;
  offset: number;
  voices: VoiceSummary[];
  /** Counts per provider across all matches, so the caller can narrow down. */
  providers: Record<string, number>;
}

export const DEFAULT_VOICE_LIMIT = 50;
export const MAX_VOICE_LIMIT = 200;

/** The catalogue has thousands of entries and changes rarely — cache it. */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  voices: TelnyxVoice[];
}

let cache: CacheEntry | null = null;

export function clearVoiceCache(): void {
  cache = null;
}

export async function fetchVoices(client: TelnyxClient, now = Date.now()): Promise<TelnyxVoice[]> {
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.voices;
  const payload = await client.getJson<{ voices?: TelnyxVoice[]; data?: TelnyxVoice[] }>(
    '/text-to-speech/voices',
  );
  const voices = payload.voices ?? payload.data ?? [];
  cache = { fetchedAt: now, voices };
  return voices;
}

function voiceId(voice: TelnyxVoice): string {
  return String(voice.id ?? voice.voice_id ?? voice.name ?? '');
}

/**
 * "de-DE" matches only de-DE; the bare prefix "de" matches every German
 * variant (de-DE, de-AT, de-CH). Mixing those up would silently widen a
 * deliberately narrow filter.
 */
function matchesLanguage(voice: TelnyxVoice, wanted: string): boolean {
  const language = String(voice.language ?? '').toLowerCase();
  if (!language) return false;
  const want = wanted.toLowerCase();
  if (want.includes('-')) return language === want;
  return language === want || language.startsWith(`${want}-`);
}

function matchesSearch(voice: TelnyxVoice, needle: string): boolean {
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
export function filterVoices(voices: TelnyxVoice[], filter: VoiceFilter = {}): VoiceListResult {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_VOICE_LIMIT, 1), MAX_VOICE_LIMIT);
  const offset = Math.max(filter.offset ?? 0, 0);

  const matched = voices.filter((voice) => {
    if (
      filter.provider &&
      String(voice.provider ?? '').toLowerCase() !== filter.provider.toLowerCase()
    ) {
      // Fall back to the id prefix when the provider field is absent.
      const prefix = voiceId(voice).split('.')[0]?.toLowerCase();
      if (prefix !== filter.provider.toLowerCase()) return false;
    }
    if (filter.language && !matchesLanguage(voice, filter.language)) return false;
    if (filter.search && !matchesSearch(voice, filter.search)) return false;
    return true;
  });

  const providers: Record<string, number> = {};
  for (const voice of matched) {
    const key = String(voice.provider ?? voiceId(voice).split('.')[0] ?? 'unknown').toLowerCase();
    providers[key] = (providers[key] ?? 0) + 1;
  }

  const page = matched.slice(offset, offset + limit).map((voice): VoiceSummary => {
    const summary: VoiceSummary = { id: voiceId(voice) };
    if (voice.name) summary.name = String(voice.name);
    if (voice.provider) summary.provider = String(voice.provider);
    if (voice.language) summary.language = String(voice.language);
    if (voice.gender) summary.gender = String(voice.gender);
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
