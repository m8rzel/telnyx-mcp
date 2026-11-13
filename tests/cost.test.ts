import { describe, expect, it } from 'vitest';

import { estimateCost, PRICE_PER_CHARACTER_USD } from '../src/cost.js';
import { filterVoices, type TelnyxVoice } from '../src/voices.js';

describe('cost estimation', () => {
  it('prices Telnyx Ultra at the published per-character rate', () => {
    const result = estimateCost(14_000, 'Telnyx.Ultra.Clara');
    expect(result.pricePerCharacterUsd).toBe(PRICE_PER_CHARACTER_USD.telnyxUltra);
    expect(result.usd).toBeCloseTo(0.448, 4);
    expect(result.basis).toContain('telnyx.com/pricing');
  });

  it('separates Polly standard from the neural engine', () => {
    expect(estimateCost(1000, 'aws.Polly.Vicki').pricePerCharacterUsd).toBe(0.000009);
    expect(estimateCost(1000, 'aws.Polly.Neural.Vicki').pricePerCharacterUsd).toBe(0.000024);
  });

  it('returns no price for bring-your-own-key providers and says why', () => {
    const eleven = estimateCost(1000, 'elevenlabs.eleven_turbo_v2_5.abc');
    expect(eleven.usd).toBeNull();
    expect(eleven.basis).toMatch(/bring-your-own-key/i);
    expect(estimateCost(1000, 'azure.Neural.Katja').usd).toBeNull();
  });

  it('admits when a voice is not in the published list', () => {
    const unknown = estimateCost(1000, 'fishaudio.s2-pro.someone');
    expect(unknown.usd).toBeNull();
    expect(unknown.basis).toMatch(/no published/i);
  });

  it('rejects a negative character count', () => {
    expect(() => estimateCost(-5, 'Telnyx.Ultra.Clara')).toThrow(/non-negative/);
  });
});

describe('voice list filtering', () => {
  const catalogue: TelnyxVoice[] = [
    {
      id: 'Telnyx.Ultra.Clara',
      name: 'Clara',
      provider: 'Telnyx',
      language: 'de-DE',
      gender: 'female',
    },
    { id: 'Telnyx.Ultra.Max', name: 'Max', provider: 'Telnyx', language: 'de-AT', gender: 'male' },
    { id: 'aws.Polly.Vicki', name: 'Vicki', provider: 'AWS', language: 'de-DE' },
    { id: 'aws.Polly.Joanna', name: 'Joanna', provider: 'AWS', language: 'en-US' },
    { id: 'elevenlabs.turbo.Rachel', name: 'Rachel', provider: 'ElevenLabs', language: 'en-GB' },
  ];

  it('filters by language prefix and exact code', () => {
    expect(filterVoices(catalogue, { language: 'de' }).matched).toBe(3);
    expect(filterVoices(catalogue, { language: 'de-DE' }).matched).toBe(2);
  });

  it('filters by provider case-insensitively', () => {
    expect(filterVoices(catalogue, { provider: 'telnyx' }).matched).toBe(2);
    expect(filterVoices(catalogue, { provider: 'AWS' }).matched).toBe(2);
  });

  it('searches names and ids', () => {
    expect(filterVoices(catalogue, { search: 'clara' }).voices[0]!.id).toBe('Telnyx.Ultra.Clara');
    expect(filterVoices(catalogue, { search: 'polly' }).matched).toBe(2);
  });

  it('caps the result and reports returned/matched/total with a provider breakdown', () => {
    const result = filterVoices(catalogue, { limit: 2 });
    expect(result).toMatchObject({ total: 5, matched: 5, returned: 2, offset: 0 });
    expect(result.voices).toHaveLength(2);
    expect(result.providers).toEqual({ telnyx: 2, aws: 2, elevenlabs: 1 });
  });

  it('pages with an offset', () => {
    const page = filterVoices(catalogue, { limit: 2, offset: 4 });
    expect(page.returned).toBe(1);
    expect(page.voices[0]!.id).toBe('elevenlabs.turbo.Rachel');
  });

  it('combines filters', () => {
    expect(
      filterVoices(catalogue, { language: 'de', provider: 'telnyx', search: 'max' }).matched,
    ).toBe(1);
  });
});
