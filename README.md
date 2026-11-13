# telnyx-mcp

A private MCP server that gives an assistant Telnyx **text-to-speech**: find a voice,
synthesise text into an MP3 file, render a whole script with timed pauses, and price a
job before running it.

## Why this exists

The official Telnyx connector ships 43 tools covering numbers, messaging, calls and the
voice AI stack — but **none of them generate speech from text**. The REST endpoint
`POST /v2/text-to-speech/speech` is fully capable (4,900+ voices across 13 providers,
`binary_output` returns `audio/mpeg` directly), it just is not exposed. This server wraps
exactly that endpoint, plus the pieces you actually need around it: pause handling,
segment joining, duration measurement and cost estimation.

## Tools

| Tool | Does | Parameters |
| --- | --- | --- |
| `list_voices` | Lists voices from `GET /v2/text-to-speech/voices`, filtered and paged. Returns `returned of matched of total` plus a per-provider count, never the full catalogue. | `language` (`"de"` matches de-DE/de-AT/de-CH, `"de-DE"` matches only that), `provider`, `search`, `limit` (default 50, max 200), `offset` |
| `speak` | Synthesises one text and writes an MP3. Returns the absolute path, bytes, measured duration, character count and estimated cost — **never** the audio inline. | `text` (required), `voice` (required), `language`, `rate`, `text_type` (`text`\|`ssml`), `voice_settings`, `file_name` |
| `render_script` | Renders a markdown script with `[PAUSE n]` markers into one continuous MP3: text is split at sentence boundaries, synthesised segment by segment, and joined with real silence. Returns total duration plus per-segment durations. | `script` (required), `voice` (required), `language`, `rate`, `voice_settings`, `max_chars` (default 1800), `lead_in_seconds`, `lead_out_seconds`, `file_name` |
| `estimate_cost` | Prices a character count, a text or a full script **without calling the API**. For a script it also returns segment/pause statistics. | one of `characters` / `text` / `script`, plus `voice` (required), `max_chars` |

### Script format

```markdown
# Heading — not spoken

Take a slow breath in.

[PAUSE 5]

And let it go.

[PAUSE 12]
```

- A line that consists of **only** `[PAUSE n]` becomes exactly n seconds of silence.
  `n` may be decimal, with a dot or a comma (`[PAUSE 2,5]`).
- Consecutive markers are added together.
- Headings, horizontal rules and lines that *mention* a marker without being one (the
  usual "Note: `[PAUSE 2]` = 2 seconds" legend) are dropped — never spoken, never timed.
- Text is packed into segments of at most `max_chars`, split only at sentence
  boundaries. A single sentence longer than the limit is kept whole rather than cut.

## Install

```bash
git clone git@github.com:m8rzel/telnyx-mcp.git
cd telnyx-mcp
npm install
npm run build
```

Requires Node 20 or newer. Runtime dependencies: `@modelcontextprotocol/sdk` and `zod` —
nothing else, in particular **no ffmpeg**.

## Configure

The API key is read from the environment only. It is never stored in this repository and
never appears in a log line or an error message. Without it the server exits immediately
with exit code 78.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `TELNYX_API_KEY` | yes | — | Telnyx API key (Portal → Auth → API Keys) |
| `TELNYX_TTS_OUTPUT_DIR` | no | `<os-temp>/telnyx-mcp` | Where MP3 files are written |
| `TELNYX_TTS_TIMEOUT_MS` | no | `120000` | HTTP timeout per attempt |
| `TELNYX_TTS_MAX_RETRIES` | no | `3` | Attempts per request (429/5xx/network, with backoff) |

### Wiring it into an MCP client

```json
{
  "mcpServers": {
    "telnyx": {
      "command": "node",
      "args": ["/absolute/path/to/telnyx-mcp/dist/index.js"],
      "env": {
        "TELNYX_API_KEY": "your-telnyx-api-key",
        "TELNYX_TTS_OUTPUT_DIR": "/absolute/path/to/audio-output"
      }
    }
  }
}
```

Use absolute paths — the server is started as a child process and inherits no shell.
Transport is stdio; stdout is the protocol channel, so all diagnostics go to stderr.

## Running it with Docker

The image is a two-stage build on `node:20-alpine`: the first stage installs everything
and compiles TypeScript, the second one keeps only `node_modules` (production), `dist/`
and `package.json`. No ffmpeg, no port, no `HEALTHCHECK` — a stdio server has nothing a
health probe could talk to.

### Build it yourself

```bash
docker build -t telnyx-mcp .
```

### Or pull it from GHCR

Every push to `main` publishes `ghcr.io/m8rzel/telnyx-mcp:latest` for `linux/amd64` and
`linux/arm64`; a `v*` tag publishes `:1.2.3` and `:1.2` alongside it.

**This repository is private, so the package is private too** — pulling requires a login
with a personal access token (classic) that carries the `read:packages` scope:

```bash
docker login ghcr.io -u m8rzel        # password = the PAT, not your GitHub password
docker pull ghcr.io/m8rzel/telnyx-mcp:latest
```

### Run it

```bash
docker run --rm -i \
  -e TELNYX_API_KEY="$TELNYX_API_KEY" \
  -e TELNYX_TTS_OUTPUT_DIR="$HOME/telnyx-audio" \
  -v "$HOME/telnyx-audio:$HOME/telnyx-audio" \
  ghcr.io/m8rzel/telnyx-mcp:latest
```

It then waits silently for JSON-RPC on stdin; `telnyx-mcp ready. Output directory: …` on
stderr means it is up. Ctrl-C to stop.

### Wiring the container into an MCP client

```json
{
  "mcpServers": {
    "telnyx": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "TELNYX_API_KEY",
        "-e", "TELNYX_TTS_OUTPUT_DIR=/Users/marcel/telnyx-audio",
        "-v", "/Users/marcel/telnyx-audio:/Users/marcel/telnyx-audio",
        "ghcr.io/m8rzel/telnyx-mcp:latest"
      ],
      "env": {
        "TELNYX_API_KEY": "your-telnyx-api-key"
      }
    }
  }
}
```

`-e TELNYX_API_KEY` without a value passes the variable through from the `env` block
above, so the key never appears in the argument list of a `docker` process. Replace
`/Users/marcel/telnyx-audio` with a directory that exists on your machine, and create it
before the first start — Docker would otherwise create it as a root-owned directory.

### Three things that will bite you

| Rule | Why |
| --- | --- |
| `-i`, never `-t` | A TTY turns stdio into a terminal: line editing, echo and control sequences end up in the stream and corrupt the JSON-RPC frames. `docker run -it` is right for a shell and wrong for an MCP server. |
| The audio directory needs the **same absolute path inside and outside** | `speak` and `render_script` return the *path* of the MP3, never the audio itself. Mount `~/telnyx-audio` to `/data` and the client is handed `/data/foo.mp3` — a path that does not exist on your machine. Mounting the directory onto itself and pointing `TELNYX_TTS_OUTPUT_DIR` at it keeps both sides in agreement. |
| `--rm` | The MCP client starts one container per session and ends it when it quits. Without `--rm` every client restart leaves another stopped container behind. |

### File ownership

The container runs as the unprivileged `node` user that ships with the image (uid 1000).
On Docker Desktop for macOS the bind mount is owned by the calling user regardless, so
this needs no attention. On Linux it does: if your own uid is not 1000, the server cannot
write into the mounted directory and `speak` fails with `EACCES`. Start it as yourself in
that case:

```bash
docker run --rm -i --user "$(id -u):$(id -g)" \
  -e TELNYX_API_KEY="$TELNYX_API_KEY" \
  -e TELNYX_TTS_OUTPUT_DIR="$HOME/telnyx-audio" \
  -v "$HOME/telnyx-audio:$HOME/telnyx-audio" \
  ghcr.io/m8rzel/telnyx-mcp:latest
```

In an MCP client config the same flags go into the `args` array — `"--user", "501:20"`
with the numbers from `id -u` and `id -g`, because `$(…)` is not expanded there.

## Speaking rate

Telnyx has **no single rate field**. The `rate` parameter here is a multiplier
(`1` = normal) that is translated per provider:

| Voice | How `rate` is sent | Range |
| --- | --- | --- |
| `Telnyx.Ultra.*`, `Telnyx.Grok.*` | `voice_settings.voice_speed` | 0.5–2.0 |
| `Minimax.*` | `voice_settings.speed` | 0.5–2.0 |
| `Soniox.*` | `voice_settings.speed` | 0.7–1.3 |
| `aws.Polly.*`, `azure.*` | text is wrapped in `<speak><prosody rate="85%">…</prosody></speak>` and `text_type` is set to `ssml` | 0.2–2.0 |
| everything else (Kokoro, Qwen3, Bayan, Sukhan, ElevenLabs, Resemble, Inworld, Fish, xAI) | **rejected with an explanation** | — |

Only AWS Polly and Azure accept SSML at all. A rate for a voice that cannot do it is an
error before any request is sent, rather than a silently ignored parameter — you would
otherwise pay for audio at the wrong tempo. Note that the SSML wrapper adds characters,
and Telnyx bills per character, so the reported cost includes it.

## How the audio is assembled

`render_script` makes one API call per speech segment and then joins everything on **MP3
frame level** — no decoding, no re-encoding, no quality loss, no ffmpeg:

- Silence is generated as real MPEG Layer III frames that match the format Telnyx
  returned (version, sample rate, channel mode, bitrate). The payload after each 4-byte
  header is all zeroes, which with the protection bit set to "no CRC" means
  `part2_3_length = 0` for every granule: the decoder reads no main data and outputs one
  frame of silence.
- Pause lengths are quantised to whole frames (24 ms at 24 kHz, 26 ms at 44.1 kHz). The
  result reports the **actual** duration, and `requested_seconds` whenever it differs.
- Duration is computed exactly from the frame headers (`samples / sample rate`), not
  estimated from the bitrate.
- Parts with different sample rates or channel counts are refused instead of being glued
  into a file that plays at the wrong speed.

That costs ~200 lines of header arithmetic and keeps the dependency list at two packages;
requiring ffmpeg for the same job would be a ~70 MB external binary.

`scripts/verify-audio.mjs` checks this against an independent implementation: ffmpeg
encodes a tone, this code builds the silence and joins the parts, and ffmpeg then decodes
and measures the result. It needs ffmpeg on `PATH` (or `FFMPEG_PATH`) and is therefore not
part of `npm test`:

```bash
npm run build && node scripts/verify-audio.mjs
```

## Cost

Telnyx bills per synthesised character. List prices used by `estimate_cost`
(source: <https://telnyx.com/pricing/text-to-speech>):

| Tier | USD per character | 14,000-character script |
| --- | --- | --- |
| Telnyx TTS (Kokoro) | $0.000003 | ~$0.04 |
| Telnyx Ultra, Qwen3 | $0.000032 | ~$0.45 |
| Telnyx HD Voices | $0.000048 | ~$0.67 |
| Amazon Polly standard | $0.000009 | ~$0.13 |
| Amazon Polly neural | $0.000024 | ~$0.34 |
| MiniMax | $0.000034 | ~$0.48 |
| Resemble, Murf | $0.000008 | ~$0.11 |
| Inworld Mini / Max | $0.0000055 / $0.00001 | ~$0.08 / ~$0.14 |

**ElevenLabs and Azure are bring-your-own-key.** Using `elevenlabs.*` or `azure.*` voices
through Telnyx requires your own provider key stored in your Telnyx account; those
requests are billed by ElevenLabs/Azure, not per Telnyx character. `estimate_cost`
returns `null` for them instead of inventing a number.

## Limits

- **Character limit per request is undocumented.** The default `max_chars` of 1800 is a
  conservative choice, not a Telnyx specification. Raise it if long segments work for you.
- **Rate limits for this endpoint are undocumented.** Segments are synthesised
  sequentially, never in parallel; 429 responses are retried with backoff and honour
  `Retry-After`.
- **MP3 only.** `render_script` needs MPEG Layer III to join frames. Voices that return
  PCM or another format fail with a clear message rather than a corrupt file.
- Sentence splitting is a regular expression on `. ! ? …` followed by whitespace, so an
  abbreviation like "z. B." can be treated as a sentence end. That only affects where a
  segment boundary falls, never the spoken text.

## Development

```bash
npm run lint     # eslint, type-aware
npm run build    # tsc -> dist/
npm test         # vitest, 90 tests, no network
npm run check    # all three
```

Dependency versions are pinned exactly, so `npm install` reproduces the tested tree even
though no lockfile is committed. The Docker build follows the same rule: it runs
`npm install`, and automatically switches to `npm ci` as soon as a `package-lock.json`
is committed.

Tests mock the HTTP layer and run against real LAME-encoded MP3 fixtures (base64-embedded
in `tests/fixtures/index.ts`, so the repository holds no binary blobs), which means the
suite runs offline and without an API key. Regenerate the fixtures with
`node scripts/make-fixtures.mjs` (needs ffmpeg).

## Security

- The key lives in `TELNYX_API_KEY` only. There is no key in the code, the tests, the
  examples or the git history — `.env` is git-ignored and `.env.example` holds variable
  names only.
- Every error message passes through a redaction filter that strips the key and anything
  shaped like a bearer token before it is returned or logged.
- `file_name` is reduced to a safe base name; the resolved path is verified to stay
  inside the configured output directory, so no input can write outside it.
- Audio is written to disk and referenced by path. Nothing is base64-encoded into a
  response — a 30-minute hypnosis script is around 14 MB.

## License

MIT — see [LICENSE](LICENSE).
