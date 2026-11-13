import { parseVoice } from './voice.js';

/**
 * Per-character list prices from https://telnyx.com/pricing/text-to-speech
 * (retrieved 2026-11-13). Telnyx bills per synthesised character; providers
 * marked BYOK are billed by that provider against your own API key, so Telnyx
 * publishes no per-character price for them.
 */
export const PRICE_PER_CHARACTER_USD = {
  telnyxStandard: 0.000003,
  telnyxHd: 0.000048,
  telnyxUltra: 0.000032,
  qwen3: 0.000032,
  pollyStandard: 0.000009,
  pollyNeural: 0.000024,
  minimax: 0.000034,
  rime: 0.00002,
  inworldMini: 0.0000055,
  inworldMax: 0.00001,
  resemble: 0.000008,
  murf: 0.000008,
} as const;

export interface CostEstimate {
  characters: number;
  /** Null when Telnyx publishes no per-character price for this voice. */
  usd: number | null;
  pricePerCharacterUsd: number | null;
  /** Human-readable pricing tier or the reason the price is unknown. */
  basis: string;
}

const PRICING_SOURCE = 'https://telnyx.com/pricing/text-to-speech';

function tierFor(voice: string): { price: number | null; basis: string } {
  const lower = voice.toLowerCase();
  const { provider, model } = parseVoice(voice);

  if (provider === 'telnyx') {
    if (model === 'ultra')
      return { price: PRICE_PER_CHARACTER_USD.telnyxUltra, basis: 'Telnyx Ultra' };
    if (model === 'qwen3tts' || model === 'qwen3')
      return { price: PRICE_PER_CHARACTER_USD.qwen3, basis: 'Qwen3 TTS' };
    if (model === 'kokorotts' || model === 'kokoro')
      return { price: PRICE_PER_CHARACTER_USD.telnyxStandard, basis: 'Telnyx TTS (Kokoro)' };
    return {
      price: null,
      basis:
        `Telnyx model "${model ?? 'unknown'}" is not in the published price list ` +
        `(Telnyx TTS $0.000003, HD Voices $0.000048, Ultra $0.000032 per character).`,
    };
  }

  if (provider === 'aws') {
    const neural = /neural|generative|long-?form/.test(lower);
    return neural
      ? { price: PRICE_PER_CHARACTER_USD.pollyNeural, basis: 'Amazon Polly, neural engine' }
      : { price: PRICE_PER_CHARACTER_USD.pollyStandard, basis: 'Amazon Polly, standard engine' };
  }

  if (provider === 'minimax') return { price: PRICE_PER_CHARACTER_USD.minimax, basis: 'MiniMax' };
  if (provider === 'rime') return { price: PRICE_PER_CHARACTER_USD.rime, basis: 'Rime' };
  if (provider === 'resemble')
    return { price: PRICE_PER_CHARACTER_USD.resemble, basis: 'Resemble' };
  if (provider === 'murf') return { price: PRICE_PER_CHARACTER_USD.murf, basis: 'Murf' };
  if (provider === 'inworld') {
    if (model?.includes('max'))
      return { price: PRICE_PER_CHARACTER_USD.inworldMax, basis: 'Inworld Max' };
    if (model?.includes('mini'))
      return { price: PRICE_PER_CHARACTER_USD.inworldMini, basis: 'Inworld Mini' };
    return {
      price: null,
      basis: 'Inworld price depends on the model (Mini $0.0000055, Max $0.00001 per character).',
    };
  }
  if (provider === 'elevenlabs')
    return {
      price: null,
      basis: 'ElevenLabs is bring-your-own-key — billed by ElevenLabs, not per Telnyx character.',
    };
  if (provider === 'azure')
    return {
      price: null,
      basis: 'Azure Neural HD is bring-your-own-key — billed by Azure, not per Telnyx character.',
    };

  return {
    price: null,
    basis: `No published Telnyx per-character price for provider "${provider}".`,
  };
}

/** Estimates list-price cost for a character count. Never calls the API. */
export function estimateCost(characters: number, voice: string): CostEstimate {
  if (!Number.isFinite(characters) || characters < 0) {
    throw new Error(`Character count must be a non-negative number, got ${characters}.`);
  }
  const { price, basis } = tierFor(voice);
  return {
    characters,
    usd: price === null ? null : Number((characters * price).toFixed(6)),
    pricePerCharacterUsd: price,
    basis: `${basis} (source: ${PRICING_SOURCE})`,
  };
}
