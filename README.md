# telnyx-mcp

A private MCP server that gives an assistant Telnyx **text-to-speech**: find a voice,
synthesise text into an MP3 file, render a whole script with timed pauses, and price a
job before running it.

## Einrichten — ein Eintrag, kein Clone

`npx` holt das Paket direkt aus GitHub. Kein Clone, kein Docker, kein Build. Das hier
ist der komplette Vorgang:

```json
{
  "mcpServers": {
    "telnyx": {
      "command": "npx",
      "args": ["-y", "git+ssh://git@github.com/m8rzel/telnyx-mcp.git"],
      "env": {
        "TELNYX_API_KEY": "<dein-key>",
        "TELNYX_TTS_OUTPUT_DIR": "/Users/marcel/mcp/telnyx-audio"
      }
    }
  }
}
```

Für Claude Code als Einzeiler:

```bash
mkdir -p ~/mcp/telnyx-audio
claude mcp add telnyx -s user \
  -e TELNYX_API_KEY=dein-key \
  -e TELNYX_TTS_OUTPUT_DIR="$HOME/mcp/telnyx-audio" \
  -- npx -y git+ssh://git@github.com/m8rzel/telnyx-mcp.git
```

`TELNYX_TTS_OUTPUT_DIR` muss ein **existierender absoluter Pfad** sein. Die Werkzeuge
geben den *Pfad* der erzeugten MP3 zurück, nie die Audiodaten — ein relativer Pfad oder
ein Ordner, den es nicht gibt, liefert dem Client eine Dateiangabe, mit der er nichts
anfangen kann. Lässt du die Variable weg, landen die Dateien in
`<os-temp>/telnyx-mcp` und werden vom System irgendwann aufgeräumt.

`-y` unterdrückt die Rückfrage „Ok to proceed?“ — ohne das Flag würde `npx` beim ersten
Start auf eine Eingabe warten, die ein MCP-Client nie gibt, und in einen Timeout laufen.

### Zugang zum privaten Repo

Das Repository ist privat, also braucht `npx` Credentials für den Clone. Es gibt zwei
saubere Wege und eine Notlösung:

| Weg | Spec in `args` | Haken |
| --- | --- | --- |
| **SSH** (empfohlen) | `git+ssh://git@github.com/m8rzel/telnyx-mcp.git` | Braucht einen entsperrten Schlüssel im `ssh-agent`. Hat der Schlüssel eine Passphrase und erreicht der MCP-Client den Agent nicht, scheitert der Clone — Lösung unten. |
| **HTTPS + Keychain** | `git+https://github.com/m8rzel/telnyx-mcp.git` | Funktioniert nur, wenn `git` den macOS-Keychain-Helper benutzt und dort ein Token für github.com liegt. Läuft das Token ab, bricht der Start ohne sichtbaren Grund ab. |
| **PAT in der URL** | `git+https://<token>@github.com/m8rzel/telnyx-mcp.git` | **Nicht benutzen.** Das Token steht im Klartext in der MCP-Config, wird mitgesichert, mitgesynct und landet in jedem Screenshot der Datei. Nur als Notlösung, wenn beides andere ausfällt — und danach das Token rotieren. |

**SSH einrichten (einmalig, macOS).** Der Punkt ist, dass der MCP-Client als
GUI-Kindprozess startet und nicht die Shell-Umgebung erbt, in der dein `ssh-agent`
läuft. Mit dem Schlüssel in der Keychain übernimmt der systemweite Agent das:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

und in `~/.ssh/config`:

```
Host github.com
  AddKeysToAgent yes
  UseKeychain yes
  IdentityFile ~/.ssh/id_ed25519
```

`UseKeychain yes` lässt `ssh` die Passphrase aus der Keychain holen, statt interaktiv zu
fragen — genau der Fall, in dem ein Kindprozess ohne Terminal sonst hängen bleibt.
Prüfen mit `ssh -T git@github.com` (muss ohne Passphrase-Prompt durchlaufen) und danach
mit dem echten Aufruf:

```bash
TELNYX_API_KEY=dein-key TELNYX_TTS_OUTPUT_DIR="$HOME/mcp/telnyx-audio" \
  npx -y git+ssh://git@github.com/m8rzel/telnyx-mcp.git
```

`telnyx-mcp ready. Output directory: …` auf stderr heißt: läuft. Strg-C beendet.

**HTTPS einrichten.** Einmal

```bash
git config --global credential.helper osxkeychain
git clone https://github.com/m8rzel/telnyx-mcp.git /tmp/telnyx-auth-test
```

Beim Clone fragt `git` nach Benutzer und Passwort; als Passwort ein Personal Access
Token mit `repo`-Scope eingeben. Es liegt danach in der Keychain und `npx` kommt ohne
weitere Eingabe durch. Das Verzeichnis kannst du wieder löschen.

Die radikale Alternative: Repo öffentlich machen und unter `@m8rzel/telnyx-mcp` auf npm
veröffentlichen — dann wäre der Eintrag schlicht `npx -y @m8rzel/telnyx-mcp`, ohne jede
Authentifizierung. Das ist eine Entscheidung über Sichtbarkeit, keine technische.

### Version festnageln

Ohne Angabe nimmt `npx` den aktuellen Stand des Standardbranches. Das heißt: Jeder Push
auf `main` ändert beim nächsten Start ungefragt die laufende Installation. Ein Commit-ish
hinter der URL verhindert das:

```text
git+ssh://git@github.com/m8rzel/telnyx-mcp.git#v1.0.0   ← Tag, empfohlen
git+ssh://git@github.com/m8rzel/telnyx-mcp.git#main      ← Branch, gleicht dem Standard
git+ssh://git@github.com/m8rzel/telnyx-mcp.git#a92a2f0   ← Commit, maximal eindeutig
```

Für den produktiven Eintrag gehört ein **Tag** in die Config. Aktualisieren ist dann ein
bewusster Schritt: Tag in der Config hochziehen, Client neu starten.

### Startzeit

Gemessen vom `npx`-Aufruf bis zur `initialize`-Antwort auf stdout, Node 22, Git-Remote
lokal (die Netzlatenz zu GitHub kommt obendrauf, erfahrungsgemäß ein bis drei Sekunden):

| Lauf | Zeit |
| --- | --- |
| erster Start, leerer npm-Cache | **11,6 s** |
| jeder weitere Start | **0,9–1,5 s** |

Der erste Start lädt den MCP-SDK-Baum (92 Pakete) herunter, danach liegt alles im
npm-Cache und `npx` prüft nur noch per `git ls-remote`, ob sich der Stand geändert hat.
Kompiliert wird **nie** — deshalb ist `dist/` eingecheckt (siehe unten). Zum Vergleich:
dieselbe Konstellation mit einem `prepare`-Script, das beim Start TypeScript baut,
braucht kalt 15,2 s und setzt eine funktionierende Toolchain auf dem Zielrechner voraus.

### Warum `dist/` im Repository liegt

`npx <git-spec>` klont, installiert und packt das Paket. Gibt es ein `prepare`-Script,
installiert npm dafür zusätzlich **alle** Dev-Abhängigkeiten und kompiliert — bei jedem
kalten Start, auf dem Rechner des Nutzers. Das kostet Zeit und schafft eine Fehlerquelle,
die man aus dem MCP-Client kaum sieht: Schlägt der Build fehl, startet der Server nicht,
und die Meldung dazu versteckt sich in der npx-Ausgabe.

Deshalb liegt das Build-Ergebnis im Repository, `package.json` hat kein `prepare` und
`files` beschränkt das Paket auf `dist`. Der Preis: `npm run build` muss **vor** jedem
Commit laufen, sonst weichen Quelle und Build voneinander ab. Siehe
[CONTRIBUTING.md](CONTRIBUTING.md); `npm run verify:dist` prüft es.

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

Zum Benutzen: nichts installieren, siehe [Einrichten](#einrichten--ein-eintrag-kein-clone).
Zum Entwickeln:

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

### Wiring a local clone into an MCP client

Der Standardweg ist `npx` ([oben](#einrichten--ein-eintrag-kein-clone)). Wenn du am Code
arbeitest und den Clone statt GitHub einbinden willst:

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

## Fallback: mit Docker betreiben

Brauchst du nur, wenn der `npx`-Weg ausfällt — etwa weil auf dem Rechner kein `git` mit
GitHub-Zugang eingerichtet ist, der Server strikt isoliert laufen soll oder du eine
feste, lokal gebaute Fassung einfrieren willst. Der Nachteil liegt auf der Hand: ein
Clone, ein Image-Build und ein laufender Docker-Daemon statt einer Zeile in der Config.

Das Image ist ein zweistufiger Build auf `node:20-alpine`: Die erste Stufe installiert
alles und kompiliert TypeScript, die zweite übernimmt nur `node_modules` (ohne
Dev-Abhängigkeiten), `dist/` und `package.json`. Kein ffmpeg, kein Port, kein
`HEALTHCHECK` — ein stdio-Server hat nichts, womit eine Health-Probe reden könnte.

### Ein Befehl

```bash
git clone https://github.com/m8rzel/telnyx-mcp.git ~/mcp/telnyx-mcp
cd ~/mcp/telnyx-mcp && bash install.sh
```

Das ist alles. Kein Dateien-Verschieben, kein JSON-Editieren, kein manuelles Bauen.
Ab dem zweiten Mal genügt `./install.sh` — den ersten Lauf startest du über `bash`,
weil das Ausführungsbit einen `git clone` nicht zwingend übersteht; das Skript setzt
es dann selbst.

Was dabei passiert:

| Schritt | |
| --- | --- |
| 1 | Prüft, ob Docker installiert ist **und** der Daemon antwortet. Sonst Abbruch mit Hinweis auf Docker Desktop. |
| 2 | Baut das Image `telnyx-mcp` aus dem Repo-Verzeichnis — egal, aus welchem Ordner du das Skript aufrufst. |
| 3 | Legt den Audio-Ordner an: `$HOME/mcp/telnyx-audio`, oder was in `TELNYX_TTS_OUTPUT_DIR` steht. |
| 4 | Holt den API-Schlüssel aus `$TELNYX_API_KEY`, sonst aus einer vorhandenen `.env`, sonst fragt es dich (ohne die Eingabe anzuzeigen). Sichert ihn in `.env` mit `chmod 600`. |
| 5 | Registriert den Server in **Claude Code** (falls die CLI `claude` da ist) und in **Claude Desktop** (falls dessen Konfiguration existiert). Findet es keines von beiden, gibt es die fertige JSON-Konfiguration zum Kopieren aus. |
| 6 | Rauchtest: startet den Container mit genau der registrierten Befehlszeile und lässt ihn per JSON-RPC die vier Werkzeuge melden. |
| 7 | Sagt dir, wo die MP3s landen und dass Claude einmal neu starten muss. |

Das Skript ist **idempotent**: Nach einem `git pull` lässt du es einfach erneut laufen.
Einen bestehenden `telnyx`-Eintrag ersetzt es, andere MCP-Server lässt es unberührt —
und von der Claude-Desktop-Konfiguration legt es vor jeder Änderung eine Sicherungskopie
`claude_desktop_config.json.bak-<Zeitstempel>` an.

Optionen:

```bash
bash install.sh --non-interactive   # keine Rückfragen (Schlüssel muss vorliegen)
bash install.sh --no-register       # nur bauen und testen, nichts registrieren
bash install.sh --help
```

### Von Hand, falls du die Schritte einzeln willst

```bash
docker build -t telnyx-mcp .
mkdir -p ~/mcp/telnyx-audio

docker run --rm -i \
  -e TELNYX_API_KEY="$TELNYX_API_KEY" \
  -e TELNYX_TTS_OUTPUT_DIR="$HOME/mcp/telnyx-audio" \
  -v "$HOME/mcp/telnyx-audio:$HOME/mcp/telnyx-audio" \
  telnyx-mcp
```

Er wartet dann still auf JSON-RPC über stdin; `telnyx-mcp ready. Output directory: …` auf
stderr heißt, er läuft. Mit Strg-C wieder raus.

Und so sieht der Eintrag aus, den der Installer schreibt (`~/Library/Application
Support/Claude/claude_desktop_config.json` bzw. `claude mcp add`):

```json
{
  "mcpServers": {
    "telnyx": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "TELNYX_API_KEY",
        "-e", "TELNYX_TTS_OUTPUT_DIR",
        "-v", "/Users/marcel/mcp/telnyx-audio:/Users/marcel/mcp/telnyx-audio",
        "telnyx-mcp"
      ],
      "env": {
        "TELNYX_API_KEY": "dein-telnyx-api-key",
        "TELNYX_TTS_OUTPUT_DIR": "/Users/marcel/mcp/telnyx-audio"
      }
    }
  }
}
```

`-e TELNYX_API_KEY` ohne Wert reicht die Variable aus dem `env`-Block durch, damit der
Schlüssel nicht in der Argumentliste eines `docker`-Prozesses auftaucht.

### Drei Stolpersteine

| Regel | Warum |
| --- | --- |
| `-i`, niemals `-t` | Ein TTY macht aus stdio ein Terminal: Zeileneditor, Echo und Steuersequenzen landen im Strom und zerlegen die JSON-RPC-Frames. `docker run -it` ist für eine Shell richtig und für einen MCP-Server falsch. |
| Der Audio-Ordner braucht **innen und außen denselben absoluten Pfad** | `speak` und `render_script` liefern den *Pfad* der MP3 zurück, nie die Audiodaten. Mountest du `~/mcp/telnyx-audio` nach `/data`, bekommt der Client `/data/foo.mp3` — einen Pfad, den es auf deinem Rechner nicht gibt. Das Verzeichnis auf sich selbst zu mounten und `TELNYX_TTS_OUTPUT_DIR` darauf zu setzen, hält beide Seiten deckungsgleich. |
| `--rm` | Der MCP-Client startet pro Sitzung einen Container und beendet ihn beim Schließen. Ohne `--rm` bleibt bei jedem Neustart ein gestoppter Container liegen. |

### Dateirechte

Der Container läuft als unprivilegierter `node`-User, der im Image mitkommt (uid 1000).
Unter Docker Desktop für macOS gehört der Bind-Mount ohnehin dem aufrufenden Benutzer,
dort ist nichts zu tun. Unter Linux schon: Ist die eigene uid nicht 1000, kann der Server
nicht in das gemountete Verzeichnis schreiben und `speak` scheitert mit `EACCES`. Der
Installer erkennt das und ergänzt dort automatisch `--user $(id -u):$(id -g)`. Von Hand:

```bash
docker run --rm -i --user "$(id -u):$(id -g)" \
  -e TELNYX_API_KEY="$TELNYX_API_KEY" \
  -e TELNYX_TTS_OUTPUT_DIR="$HOME/mcp/telnyx-audio" \
  -v "$HOME/mcp/telnyx-audio:$HOME/mcp/telnyx-audio" \
  telnyx-mcp
```

In einer MCP-Client-Konfiguration gehören dieselben Flags in das `args`-Array —
`"--user", "501:20"` mit den Zahlen aus `id -u` und `id -g`, weil `$(…)` dort nicht
ausgewertet wird.

### Optional: Image aus der GHCR statt lokal bauen

**Dieser Weg ist noch nicht aktiv.** Der Workflow dafür liegt als
`.github/docker.yml` im Repo — also *nicht* in `.github/workflows/`, wo GitHub ihn
ausführen würde. Grund: Dem schreibenden GitHub-Zugang fehlt der `workflow`-Scope,
ein Push nach `.github/workflows/` wird mit `403 insufficient scopes` abgelehnt.
Solange die Datei dort liegt, läuft nichts und es existiert kein Image in der GHCR.

Der Standardweg ist deshalb der lokale Build, den `install.sh` erledigt. Wer den
GHCR-Weg aktivieren will, verschiebt die Datei einmal von Hand und löscht den
erklärenden Kommentarblock an ihrem Anfang:

```bash
git mv .github/docker.yml .github/workflows/docker.yml
```

Danach veröffentlicht jeder Push auf `main` `ghcr.io/m8rzel/telnyx-mcp:latest` für
`linux/amd64` und `linux/arm64`; ein `v*`-Tag veröffentlicht zusätzlich `:1.2.3` und
`:1.2`. Weil dieses Repository privat ist, ist das Package ebenfalls privat — vor dem
Pull einmal anmelden, mit einem Personal Access Token (classic) mit dem Scope
`read:packages`:

```bash
docker login ghcr.io -u m8rzel        # Passwort = das Token, nicht das GitHub-Passwort
docker pull ghcr.io/m8rzel/telnyx-mcp:latest
```

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
npm run lint         # eslint, type-aware
npm run build        # tsc -> dist/
npm test             # vitest, 90 tests, no network
npm run check        # all three
npm run verify:dist  # baut neu und bricht ab, wenn dist/ vom Commit abweicht
```

`dist/` ist eingecheckt (Begründung [oben](#warum-dist-im-repository-liegt)) — jeder
Commit, der `src/` berührt, muss das neu gebaute `dist/` mitbringen. Details in
[CONTRIBUTING.md](CONTRIBUTING.md).

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
