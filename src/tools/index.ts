import { stat } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import type { Config } from '../config.js';
import { estimateCost } from '../cost.js';
import { audioResult, MAX_EMBED_AUDIO_BYTES } from '../embed.js';
import { mp3Duration } from '../mp3.js';
import { writeAudioFile } from '../output.js';
import { renderScript } from '../render.js';
import { DEFAULT_MAX_CHARS, parseScript, scriptStats } from '../script.js';
import { synthesize } from '../speech.js';
import type { TelnyxClient } from '../telnyx.js';
import { fetchVoices, filterVoices } from '../voices.js';
import { estimateCostInput, listVoicesInput, renderScriptInput, speakInput } from './schemas.js';

function json(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Wraps a handler so no exception ever escapes as a protocol-level error:
 * failures come back as a readable tool result the model can act on.
 */
async function guard(
  run: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

export function registerTools(server: McpServer, client: TelnyxClient, config: Config): void {
  server.registerTool(
    'list_voices',
    {
      title: 'List Telnyx voices',
      description:
        'Lists available Telnyx text-to-speech voices. The full catalogue has thousands of entries, ' +
        'so results are filtered and paged: pass language ("de"), provider ("telnyx") or a search term. ' +
        'Returns "returned of matched of total" plus a per-provider breakdown.',
      inputSchema: listVoicesInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const voices = await fetchVoices(client);
        const filter: Parameters<typeof filterVoices>[1] = {};
        if (args.language) filter.language = args.language;
        if (args.provider) filter.provider = args.provider;
        if (args.search) filter.search = args.search;
        if (args.limit !== undefined) filter.limit = args.limit;
        if (args.offset !== undefined) filter.offset = args.offset;
        return json(filterVoices(voices, filter));
      }),
  );

  server.registerTool(
    'speak',
    {
      title: 'Synthesise speech to an MP3 file',
      description:
        'Synthesises text with a Telnyx voice and writes an MP3 file. Returns the absolute file path, ' +
        'byte size, measured duration, character count and the estimated list-price cost, plus the MP3 itself ' +
        `as an audio block (up to ${MAX_EMBED_AUDIO_BYTES / 1024 / 1024} MB, unless TELNYX_TTS_EMBED_AUDIO=false).`,
      inputSchema: speakInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { audio, contentType, characters } = await synthesize(client, {
          text: args.text,
          voice: args.voice,
          ...(args.language ? { language: args.language } : {}),
          ...(args.rate !== undefined ? { rate: args.rate } : {}),
          ...(args.text_type ? { textType: args.text_type } : {}),
          ...(args.voice_settings ? { voiceSettings: args.voice_settings } : {}),
        });

        const path = await writeAudioFile(config.outputDir, audio, args.file_name);
        const { size } = await stat(path);

        let durationSeconds: number | null = null;
        let durationNote: string | undefined;
        try {
          durationSeconds = Number(mp3Duration(audio).toFixed(3));
        } catch (error) {
          durationNote = `Duration could not be measured: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }

        return audioResult(
          {
            file_path: path,
            bytes: size,
            content_type: contentType,
            duration_seconds: durationSeconds,
            ...(durationNote ? { duration_note: durationNote } : {}),
            characters,
            voice: args.voice,
            estimated_cost: estimateCost(characters, args.voice),
          },
          audio,
          config.embedAudio,
          contentType,
        );
      }),
  );

  server.registerTool(
    'render_script',
    {
      title: 'Render a [PAUSE n] script to one MP3',
      description:
        'Renders a markdown script into a single continuous MP3. Lines consisting only of "[PAUSE n]" become ' +
        'n seconds of real silence; text is split at sentence boundaries and synthesised segment by segment, ' +
        'then joined on MP3 frame level without re-encoding. Returns the file path, the measured total ' +
        'duration and the duration of every segment, plus the MP3 as an audio block ' +
        `(up to ${MAX_EMBED_AUDIO_BYTES / 1024 / 1024} MB, unless TELNYX_TTS_EMBED_AUDIO=false).`,
      inputSchema: renderScriptInput,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const result = await renderScript(client, args.script, {
          voice: args.voice,
          ...(args.language ? { language: args.language } : {}),
          ...(args.rate !== undefined ? { rate: args.rate } : {}),
          ...(args.voice_settings ? { voiceSettings: args.voice_settings } : {}),
          ...(args.max_chars !== undefined ? { maxChars: args.max_chars } : {}),
          ...(args.lead_in_seconds !== undefined ? { leadInSeconds: args.lead_in_seconds } : {}),
          ...(args.lead_out_seconds !== undefined ? { leadOutSeconds: args.lead_out_seconds } : {}),
        });

        const path = await writeAudioFile(config.outputDir, result.audio, args.file_name);
        const { size } = await stat(path);

        return audioResult(
          {
            file_path: path,
            bytes: size,
            total_duration_seconds: result.totalDurationSeconds,
            total_duration_formatted: formatDuration(result.totalDurationSeconds),
            speech_duration_seconds: result.speechDurationSeconds,
            silence_duration_seconds: result.silenceDurationSeconds,
            characters: result.characters,
            voice: args.voice,
            audio_format: {
              mpeg_version: result.template.version,
              sample_rate: result.template.sampleRate,
              bitrate_kbps: result.template.bitrateKbps,
              channels: result.template.channelMode === 3 ? 1 : 2,
            },
            estimated_cost: estimateCost(result.characters, args.voice),
            parts: result.parts,
          },
          result.audio,
          config.embedAudio,
        );
      }),
  );

  server.registerTool(
    'estimate_cost',
    {
      title: 'Estimate synthesis cost',
      description:
        'Estimates the list-price cost for a character count, a text or a full [PAUSE n] script — ' +
        'without calling the Telnyx API. Use this before rendering long scripts.',
      inputSchema: estimateCostInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      guard(() => {
        const maxChars = args.max_chars ?? DEFAULT_MAX_CHARS;
        let characters: number;
        let basis: string;

        if (args.script !== undefined) {
          const stats = scriptStats(parseScript(args.script, { maxChars }), maxChars);
          characters = stats.characters;
          basis = 'spoken characters of the script';
          return json({
            ...estimateCost(characters, args.voice),
            counted: basis,
            script_stats: stats,
          });
        }

        if (args.text !== undefined) {
          characters = args.text.length;
          basis = 'length of the supplied text';
        } else if (args.characters !== undefined) {
          characters = args.characters;
          basis = 'supplied character count';
        } else {
          throw new Error('Provide one of "characters", "text" or "script".');
        }

        return json({ ...estimateCost(characters, args.voice), counted: basis });
      }),
  );
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}
