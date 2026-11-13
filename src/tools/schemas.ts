import { z } from 'zod';
import { MAX_VOICE_LIMIT, DEFAULT_VOICE_LIMIT } from '../voices.js';
import { DEFAULT_MAX_CHARS } from '../script.js';

/** ElevenLabs-only tuning, relayed verbatim by Telnyx. */
export const voiceSettingsSchema = z
  .object({
    stability: z.number().min(0).max(1).optional(),
    similarity_boost: z.number().min(0).max(1).optional(),
    style: z.number().min(0).max(1).optional(),
    use_speaker_boost: z.boolean().optional(),
    model_id: z.string().optional(),
    language_boost: z.string().optional(),
    emotion: z
      .enum(['neutral', 'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised'])
      .optional(),
    volume: z.number().positive().optional(),
    sampling_rate: z.number().int().positive().optional(),
  })
  .passthrough();

export const voiceIdSchema = z
  .string()
  .min(3)
  .describe(
    'Voice id in Provider.Model.VoiceId format, e.g. "Telnyx.Ultra.Clara" or "aws.Polly.Vicki".',
  );

export const rateSchema = z
  .number()
  .min(0.2)
  .max(2)
  .describe(
    'Speaking rate multiplier (1 = normal). Mapped per provider: voice_speed for Telnyx Ultra/Grok, ' +
      'speed for Minimax/Soniox, SSML <prosody rate> for AWS Polly and Azure. Other providers reject it.',
  );

export const languageSchema = z
  .string()
  .min(2)
  .describe(
    'BCP-47 language code, e.g. "de-DE". Used by AWS Polly, Azure, ElevenLabs, Inworld and Soniox; ignored by other providers.',
  );

export const listVoicesInput = {
  language: z.string().min(2).optional().describe('Filter by language, e.g. "de" or "de-DE".'),
  provider: z
    .string()
    .min(2)
    .optional()
    .describe('Filter by provider, e.g. "telnyx", "aws", "elevenlabs".'),
  search: z.string().min(1).optional().describe('Free-text match on name, id, accent or label.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_VOICE_LIMIT)
    .optional()
    .describe(`Maximum voices to return (default ${DEFAULT_VOICE_LIMIT}, max ${MAX_VOICE_LIMIT}).`),
  offset: z.number().int().min(0).optional().describe('Skip this many matches (paging).'),
};

export const speakInput = {
  text: z
    .string()
    .min(1)
    .max(100_000)
    .describe('Text to synthesise. Markdown is stripped by Telnyx.'),
  voice: voiceIdSchema,
  language: languageSchema.optional(),
  rate: rateSchema.optional(),
  text_type: z
    .enum(['text', 'ssml'])
    .optional()
    .describe('Set "ssml" to send your own SSML. Only AWS Polly and Azure support it.'),
  voice_settings: voiceSettingsSchema.optional().describe('Provider-specific tuning.'),
  file_name: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe('Base name for the MP3 inside the output directory. Sanitised; no paths allowed.'),
};

export const renderScriptInput = {
  script: z
    .string()
    .min(1)
    .max(500_000)
    .describe(
      'Markdown script. Lines that consist only of "[PAUSE n]" become n seconds of real silence; ' +
        'headings, horizontal rules and note lines mentioning the markers are not spoken.',
    ),
  voice: voiceIdSchema,
  language: languageSchema.optional(),
  rate: rateSchema.optional(),
  voice_settings: voiceSettingsSchema.optional(),
  max_chars: z
    .number()
    .int()
    .min(50)
    .max(5000)
    .optional()
    .describe(`Maximum characters per synthesis request (default ${DEFAULT_MAX_CHARS}).`),
  lead_in_seconds: z
    .number()
    .min(0)
    .max(60)
    .optional()
    .describe('Silence before the first segment.'),
  lead_out_seconds: z
    .number()
    .min(0)
    .max(60)
    .optional()
    .describe('Silence after the last segment.'),
  file_name: z.string().min(1).max(120).optional().describe('Base name for the MP3.'),
};

export const estimateCostInput = {
  characters: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Character count to price. Provide this or "text"/"script".'),
  text: z.string().optional().describe('Text whose length should be priced.'),
  script: z
    .string()
    .optional()
    .describe('Markdown script with [PAUSE n] markers; only the spoken characters are counted.'),
  voice: voiceIdSchema,
  max_chars: z.number().int().min(50).max(5000).optional(),
};
