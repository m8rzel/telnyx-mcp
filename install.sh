#!/usr/bin/env bash
#
# telnyx-mcp — Ein-Befehl-Installer
#
# Baut das Docker-Image, legt den Audio-Ordner an, sichert den API-Schlüssel und
# registriert den Server in Claude Code und/oder Claude Desktop. Danach einmal
# Claude neu starten, fertig.
#
#   bash install.sh                  # alles, mit Rückfrage nach dem Schlüssel
#   bash install.sh --non-interactive   # ohne Rückfragen (Schlüssel muss vorliegen)
#   bash install.sh --no-register       # nur bauen und testen, nichts registrieren
#   bash install.sh --help
#
# Das Skript ist idempotent: nach einem `git pull` einfach erneut laufen lassen.

set -euo pipefail

# ---------------------------------------------------------------------------
# Grundlagen
# ---------------------------------------------------------------------------

IMAGE_NAME="telnyx-mcp"
SERVER_NAME="telnyx"

# Pfad des Skripts, damit es aus jedem Verzeichnis heraus funktioniert.
# BASH_SOURCE ist auch korrekt, wenn das Skript gesourct wird; $0 ist der Fallback.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd -P)"

AUDIO_DIR="${TELNYX_TTS_OUTPUT_DIR:-$HOME/mcp/telnyx-audio}"
ENV_FILE="$SCRIPT_DIR/.env"
DESKTOP_CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

NON_INTERACTIVE=0
DO_REGISTER=1
API_KEY=""
KEY_SOURCE=""
TMP_DIR=""

# Farben nur, wenn die Ausgabe wirklich in einem Terminal landet.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_BLUE=$'\033[34m'
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""
fi

STEP_NO=0

step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s%s[%d/7]%s %s%s%s\n' "$C_BOLD" "$C_BLUE" "$STEP_NO" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"
}

info()  { printf '      %s\n' "$1"; }
dim()   { printf '      %s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
ok()    { printf '      %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$1"; }
warn()  { printf '      %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$1"; }

# Bricht mit einer verständlichen Meldung ab — nie mit einem Stacktrace.
die() {
  printf '\n%s%s✗ Abbruch:%s %s\n' "$C_BOLD" "$C_RED" "$C_RESET" "$1" >&2
  shift || true
  while [ "$#" -gt 0 ]; do
    if [ -z "$1" ]; then printf '\n' >&2; else printf '  %s\n' "$1" >&2; fi
    shift
  done
  printf '\n' >&2
  exit 1
}

cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
}
trap cleanup EXIT

# Netz für alles, was ich nicht einzeln abgefangen habe: eine Zeilennummer statt
# eines stillen Exits.
on_error() {
  local exit_code="$1" line="$2"
  printf '\n%s%s✗ Unerwarteter Fehler%s in Zeile %s (Exit-Code %s).\n' \
    "$C_BOLD" "$C_RED" "$C_RESET" "$line" "$exit_code" >&2
  printf '  Nichts wurde halb registriert — du kannst das Skript einfach erneut starten.\n' >&2
  printf '  Hilft das nicht weiter, schick mir die Ausgabe ab Schritt %s.\n\n' "$STEP_NO" >&2
}
trap 'on_error "$?" "$LINENO"' ERR

usage() {
  cat <<'EOF'
telnyx-mcp — Ein-Befehl-Installer

  bash install.sh [Optionen]

Was passiert:
  1. Docker prüfen
  2. Image "telnyx-mcp" bauen
  3. Audio-Ordner anlegen
  4. API-Schlüssel besorgen und in .env sichern (chmod 600)
  5. Server in Claude Code und/oder Claude Desktop registrieren
  6. Rauchtest: Container starten und per JSON-RPC antworten lassen
  7. Zusammenfassung

Optionen:
  --non-interactive   Keine Rückfragen. Der Schlüssel muss in $TELNYX_API_KEY
                      oder in .env stehen, sonst bricht das Skript ab.
  --no-register       Nur bauen und testen, keine MCP-Konfiguration anfassen.
                      Dann ist auch kein API-Schlüssel nötig.
  -h, --help          Diese Hilfe.

Umgebungsvariablen:
  TELNYX_API_KEY         Telnyx-Schlüssel (Portal -> Auth -> API Keys)
  TELNYX_TTS_OUTPUT_DIR  Zielordner für die MP3s
                         (Standard: $HOME/mcp/telnyx-audio)
  NO_COLOR               Gesetzt = Ausgabe ohne Farben

Das Skript ist idempotent: nach einem `git pull` einfach erneut laufen lassen.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --no-register)     DO_REGISTER=0 ;;
    -h|--help)         usage; exit 0 ;;
    *)
      printf '%sUnbekannte Option:%s %s\n\n' "$C_RED" "$C_RESET" "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

# Nach einem `git clone` ist das Dateibit nicht zwingend gesetzt (die GitHub-API
# committet mit 100644). Damit `./install.sh` beim nächsten Mal direkt geht:
chmod +x "$SCRIPT_DIR/install.sh" 2>/dev/null || true

printf '%s%s┌─ telnyx-mcp Installer ─────────────────────────────%s\n' "$C_BOLD" "$C_BLUE" "$C_RESET"
printf '%s│%s  Repo:  %s\n' "$C_BLUE" "$C_RESET" "$SCRIPT_DIR"
printf '%s│%s  Audio: %s\n' "$C_BLUE" "$C_RESET" "$AUDIO_DIR"
printf '%s└────────────────────────────────────────────────────%s\n' "$C_BLUE" "$C_RESET"

# ---------------------------------------------------------------------------
# 1. Docker
# ---------------------------------------------------------------------------

step "Docker prüfen"

if ! command -v docker >/dev/null 2>&1; then
  die "Docker ist nicht installiert." \
      "" \
      "Auf dem Mac installierst du Docker Desktop:" \
      "  https://www.docker.com/products/docker-desktop/" \
      "" \
      "Oder per Homebrew:" \
      "  brew install --cask docker" \
      "" \
      "Danach Docker Desktop einmal starten und dieses Skript erneut laufen lassen."
fi
ok "docker gefunden: $(command -v docker)"

if ! docker info >/dev/null 2>&1; then
  die "Docker ist installiert, aber der Daemon antwortet nicht." \
      "" \
      "Meistens heißt das: Docker Desktop läuft noch nicht." \
      "  open -a Docker        # Mac: starten und warten, bis das Wal-Symbol ruhig ist" \
      "" \
      "Dann dieses Skript erneut laufen lassen."
fi
ok "Docker-Daemon erreichbar${C_DIM} ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'Version unbekannt'))${C_RESET}"

# ---------------------------------------------------------------------------
# 2. Image bauen
# ---------------------------------------------------------------------------

step "Image \"$IMAGE_NAME\" bauen"

if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
  die "Kein Dockerfile in $SCRIPT_DIR." \
      "" \
      "Das Skript gehört in das Repo-Root von telnyx-mcp." \
      "Bist du im richtigen Ordner? Dann hol die neuesten Dateien:" \
      "  git -C \"$SCRIPT_DIR\" pull"
fi

info "docker build -t $IMAGE_NAME \"$SCRIPT_DIR\""
dim  "Das dauert beim ersten Mal ein bis zwei Minuten."

if ! docker build -t "$IMAGE_NAME" "$SCRIPT_DIR"; then
  die "Der Image-Build ist fehlgeschlagen." \
      "" \
      "Die Ursache steht in den Zeilen direkt über dieser Meldung." \
      "Häufig: keine Netzverbindung beim \`npm install\`, oder zu wenig" \
      "Plattenplatz. Danach aufräumen und neu versuchen:" \
      "  docker builder prune -f"
fi
ok "Image gebaut: $IMAGE_NAME"

# ---------------------------------------------------------------------------
# 3. Audio-Ordner
# ---------------------------------------------------------------------------

step "Audio-Ordner anlegen"

if [ -d "$AUDIO_DIR" ]; then
  ok "Existiert schon: $AUDIO_DIR"
else
  if ! mkdir -p "$AUDIO_DIR"; then
    die "Konnte $AUDIO_DIR nicht anlegen." \
        "" \
        "Prüf die Schreibrechte auf dem übergeordneten Ordner, oder gib einen" \
        "anderen Pfad vor:" \
        "  TELNYX_TTS_OUTPUT_DIR=\"\$HOME/Music/telnyx\" bash install.sh"
  fi
  ok "Angelegt: $AUDIO_DIR"
fi

if [ ! -w "$AUDIO_DIR" ]; then
  die "$AUDIO_DIR ist nicht beschreibbar." \
      "" \
      "Der Container schreibt die MP3s dorthin. Rechte korrigieren:" \
      "  chmod u+rwx \"$AUDIO_DIR\""
fi
dim "Hier landen später die MP3s aus speak und render_script."

# ---------------------------------------------------------------------------
# 4. API-Schlüssel
# ---------------------------------------------------------------------------

# Liest einen Wert aus einer .env-Datei, ohne sie auszuführen.
read_env_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 1
  # Letzte Zuweisung gewinnt, wie bei dotenv üblich.
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n 1 || true)"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  # Umgebende Anführungszeichen und Leerraum entfernen.
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  [ -n "$value" ] || return 1
  printf '%s' "$value"
}

step "API-Schlüssel besorgen"

if [ "$DO_REGISTER" -eq 0 ]; then
  if [ -n "${TELNYX_API_KEY:-}" ]; then
    API_KEY="$TELNYX_API_KEY"
    KEY_SOURCE="Umgebungsvariable"
    ok "Aus \$TELNYX_API_KEY übernommen."
  else
    API_KEY="install-sh-smoke-test"
    KEY_SOURCE="Platzhalter (--no-register)"
    dim "--no-register: kein echter Schlüssel nötig, der Rauchtest braucht keinen."
  fi
else
  if [ -n "${TELNYX_API_KEY:-}" ]; then
    API_KEY="$TELNYX_API_KEY"
    KEY_SOURCE="Umgebungsvariable \$TELNYX_API_KEY"
    ok "Aus \$TELNYX_API_KEY übernommen."
  elif API_KEY="$(read_env_value "$ENV_FILE" TELNYX_API_KEY)"; then
    KEY_SOURCE=".env im Repo"
    ok "Aus $ENV_FILE übernommen."
  elif [ "$NON_INTERACTIVE" -eq 1 ]; then
    die "Kein API-Schlüssel gefunden, und --non-interactive verbietet die Rückfrage." \
        "" \
        "Setz ihn einmalig als Variable:" \
        "  TELNYX_API_KEY=\"KEY...\" bash install.sh --non-interactive" \
        "" \
        "Oder leg ihn vorher in $ENV_FILE ab:" \
        "  printf 'TELNYX_API_KEY=KEY...\\n' > \"$ENV_FILE\" && chmod 600 \"$ENV_FILE\"" \
        "" \
        "Den Schlüssel findest du im Telnyx-Portal unter Auth -> API Keys."
  else
    info "Telnyx-Portal -> Auth -> API Keys. Die Eingabe wird nicht angezeigt."
    printf '      %sTelnyx API Key:%s ' "$C_BOLD" "$C_RESET"
    if ! IFS= read -rs API_KEY; then
      printf '\n'
      die "Keine Eingabe gelesen." \
          "" \
          "Läuft das Skript in einer Pipe (z. B. \`curl ... | bash\`)? Dann gibt es" \
          "kein Terminal für die Rückfrage. Nimm stattdessen:" \
          "  TELNYX_API_KEY=\"KEY...\" bash install.sh"
    fi
    printf '\n'
    if [ -z "$API_KEY" ]; then
      die "Der Schlüssel war leer." \
          "" \
          "Ohne Schlüssel kann der Server keine Sprache erzeugen (er beendet sich" \
          "mit Exit-Code 78). Starte das Skript erneut, oder nur bauen:" \
          "  bash install.sh --no-register"
    fi
    KEY_SOURCE="deiner Eingabe"
    ok "Schlüssel übernommen (${#API_KEY} Zeichen)."
  fi

  # .env schreiben, ohne fremde Zeilen zu verlieren.
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telnyx-mcp-install.XXXXXX")"
  env_tmp="$TMP_DIR/env"
  : > "$env_tmp"
  if [ -f "$ENV_FILE" ]; then
    grep -vE '^[[:space:]]*(export[[:space:]]+)?(TELNYX_API_KEY|TELNYX_TTS_OUTPUT_DIR)=' \
      "$ENV_FILE" >> "$env_tmp" 2>/dev/null || true
  fi
  printf 'TELNYX_API_KEY=%s\n' "$API_KEY" >> "$env_tmp"
  printf 'TELNYX_TTS_OUTPUT_DIR=%s\n' "$AUDIO_DIR" >> "$env_tmp"
  mv "$env_tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "Gesichert in $ENV_FILE (chmod 600, von .gitignore ausgenommen)."
fi

# ---------------------------------------------------------------------------
# 5. Registrieren
# ---------------------------------------------------------------------------

# Die docker-run-Argumente, die in jede MCP-Konfiguration gehören.
#
#   --rm   Der Client startet pro Sitzung einen Container; ohne --rm bleibt bei
#          jedem Neustart eine Leiche liegen.
#   -i     stdin offen halten, aber *kein* -t: ein TTY würde Echo und
#          Steuersequenzen in den Strom schreiben und die JSON-RPC-Frames zerlegen.
#   -v DIR:DIR  Innen und außen derselbe absolute Pfad, weil speak und
#          render_script Dateipfade zurückgeben und kein Audio.
#   -e NAME ohne Wert reicht die Variable aus dem env-Block durch, damit der
#          Schlüssel nicht in der Argumentliste eines docker-Prozesses steht.
DOCKER_ARGS="run --rm -i"
if [ "$(uname -s)" = "Linux" ] && [ "$(id -u)" != "1000" ]; then
  # Das Image läuft als uid 1000; auf Linux mit abweichender uid wäre der
  # Bind-Mount sonst nicht beschreibbar. Auf macOS gehört er ohnehin dem Nutzer.
  DOCKER_ARGS="$DOCKER_ARGS --user $(id -u):$(id -g)"
fi
DOCKER_ARGS="$DOCKER_ARGS -e TELNYX_API_KEY -e TELNYX_TTS_OUTPUT_DIR -v $AUDIO_DIR:$AUDIO_DIR $IMAGE_NAME"

# Dieselben Argumente als JSON-Array, für die Desktop-Konfiguration.
docker_args_json() {
  local out="" arg
  for arg in $DOCKER_ARGS; do
    if [ -n "$out" ]; then out="$out, "; fi
    out="$out\"$arg\""
  done
  printf '%s' "$out"
}

print_manual_config() {
  cat <<EOF

{
  "mcpServers": {
    "$SERVER_NAME": {
      "command": "docker",
      "args": [$(docker_args_json)],
      "env": {
        "TELNYX_API_KEY": "$API_KEY",
        "TELNYX_TTS_OUTPUT_DIR": "$AUDIO_DIR"
      }
    }
  }
}

EOF
}

registered_code=0
registered_desktop=0

step "In Claude registrieren"

if [ "$DO_REGISTER" -eq 0 ]; then
  dim "--no-register: übersprungen."
else

  # --- Claude Code ---------------------------------------------------------
  if command -v claude >/dev/null 2>&1; then
    info "Claude Code gefunden: $(command -v claude)"

    if claude mcp get "$SERVER_NAME" >/dev/null 2>&1 \
      || claude mcp list 2>/dev/null | grep -q "^[[:space:]]*${SERVER_NAME}[[:space:]:]"; then
      info "Ein Eintrag \"$SERVER_NAME\" existiert — wird ersetzt."
      claude mcp remove "$SERVER_NAME" -s user >/dev/null 2>&1 || true
    fi

    # shellcheck disable=SC2086  # DOCKER_ARGS soll absichtlich in Wörter zerfallen
    if claude mcp add "$SERVER_NAME" -s user \
        -e "TELNYX_API_KEY=$API_KEY" \
        -e "TELNYX_TTS_OUTPUT_DIR=$AUDIO_DIR" \
        -- docker $DOCKER_ARGS >/dev/null 2>&1; then
      registered_code=1
      ok "Claude Code: \"$SERVER_NAME\" registriert (Scope: user)."
    else
      warn "Claude Code: \`claude mcp add\` ist fehlgeschlagen."
      dim  "Die Desktop-Variante unten greift unabhängig davon."
    fi
  else
    dim "Claude Code (CLI \`claude\`) nicht im PATH — übersprungen."
  fi

  # --- Claude Desktop ------------------------------------------------------
  if [ -f "$DESKTOP_CONFIG" ]; then
    info "Claude Desktop gefunden."

    backup="$DESKTOP_CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
    if ! cp "$DESKTOP_CONFIG" "$backup"; then
      die "Konnte keine Sicherungskopie der Claude-Desktop-Konfiguration anlegen." \
          "" \
          "Ohne Sicherung fasse ich die Datei nicht an. Prüf die Rechte auf:" \
          "  $(dirname "$DESKTOP_CONFIG")"
    fi
    ok "Sicherungskopie: $(basename "$backup")"

    [ -n "$TMP_DIR" ] || TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telnyx-mcp-install.XXXXXX")"
    patch_script="$TMP_DIR/patch-config.mjs"

    # Liest die bestehende Konfiguration, setzt genau einen Schlüssel und
    # schreibt atomar zurück. Kaputtes JSON => Exit 3, nichts wird geschrieben.
    cat > "$patch_script" <<'NODE_EOF'
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const file = process.env.CFG_PATH;
const audioDir = process.env.AUDIO_DIR;
const apiKey = process.env.API_KEY;
const serverName = process.env.SERVER_NAME;
const dockerArgs = process.env.DOCKER_ARGS.trim().split(/\s+/);

let raw;
try {
  raw = readFileSync(file, "utf8");
} catch (err) {
  console.error("Datei nicht lesbar: " + err.message);
  process.exit(2);
}

let config;
try {
  config = raw.trim() === "" ? {} : JSON.parse(raw);
} catch (err) {
  console.error("Die Datei enthält kein gültiges JSON: " + err.message);
  process.exit(3);
}

if (config === null || typeof config !== "object" || Array.isArray(config)) {
  console.error("Die Datei enthält kein JSON-Objekt.");
  process.exit(3);
}

if (
  config.mcpServers !== undefined &&
  (config.mcpServers === null ||
    typeof config.mcpServers !== "object" ||
    Array.isArray(config.mcpServers))
) {
  console.error('"mcpServers" ist vorhanden, aber kein Objekt.');
  process.exit(3);
}

const before = Object.keys(config.mcpServers ?? {});
const replaced = before.includes(serverName);

// Nur diesen einen Schlüssel setzen — alles andere bleibt, wie es war.
config.mcpServers = { ...(config.mcpServers ?? {}) };
config.mcpServers[serverName] = {
  command: "docker",
  args: dockerArgs,
  env: {
    TELNYX_API_KEY: apiKey,
    TELNYX_TTS_OUTPUT_DIR: audioDir,
  },
};

const tmp = file + ".telnyx-mcp.tmp";
writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
renameSync(tmp, file);

const kept = before.filter((name) => name !== serverName);
console.log(
  (replaced ? "ersetzt" : "neu") +
    "|" +
    kept.length +
    "|" +
    kept.join(", ")
);
NODE_EOF

    patch_out=""
    patch_rc=0
    if command -v node >/dev/null 2>&1; then
      patch_out="$(CFG_PATH="$DESKTOP_CONFIG" AUDIO_DIR="$AUDIO_DIR" API_KEY="$API_KEY" \
        SERVER_NAME="$SERVER_NAME" DOCKER_ARGS="$DOCKER_ARGS" \
        node "$patch_script" 2>&1)" || patch_rc=$?
    else
      dim "Kein lokales node — erledige das in einem node:20-alpine-Container."
      cfg_dir="$(dirname "$DESKTOP_CONFIG")"
      cfg_base="$(basename "$DESKTOP_CONFIG")"
      patch_out="$(docker run --rm -i \
        -e CFG_PATH="/cfg/$cfg_base" \
        -e AUDIO_DIR="$AUDIO_DIR" \
        -e API_KEY="$API_KEY" \
        -e SERVER_NAME="$SERVER_NAME" \
        -e DOCKER_ARGS="$DOCKER_ARGS" \
        --user "$(id -u):$(id -g)" \
        -v "$cfg_dir:/cfg" \
        -v "$patch_script:/patch.mjs:ro" \
        node:20-alpine node /patch.mjs 2>&1)" || patch_rc=$?
    fi

    if [ "$patch_rc" -eq 0 ]; then
      mode="${patch_out%%|*}"
      rest="${patch_out#*|}"
      kept_count="${rest%%|*}"
      kept_names="${rest#*|}"
      registered_desktop=1
      if [ "$mode" = "ersetzt" ]; then
        ok "Claude Desktop: bestehender Eintrag \"$SERVER_NAME\" aktualisiert."
      else
        ok "Claude Desktop: \"$SERVER_NAME\" hinzugefügt."
      fi
      if [ "$kept_count" -gt 0 ]; then
        ok "$kept_count andere Server unverändert erhalten: $kept_names"
      else
        dim "Es waren keine anderen Server eingetragen."
      fi
    elif [ "$patch_rc" -eq 3 ]; then
      warn "Claude Desktop: die Konfigurationsdatei ist kein gültiges JSON."
      dim  "$patch_out"
      dim  "Ich habe nichts geschrieben. Deine Sicherungskopie:"
      dim  "  $backup"
      dim  "Reparier die Datei (oder lösch sie, Claude legt sie neu an) und starte das Skript erneut."
    else
      warn "Claude Desktop: Konfiguration konnte nicht geschrieben werden."
      dim  "$patch_out"
      dim  "Unverändert — Sicherungskopie liegt unter $backup"
    fi
  else
    dim "Claude Desktop nicht gefunden (keine Datei unter \"$DESKTOP_CONFIG\") — übersprungen."
  fi

  if [ "$registered_code" -eq 0 ] && [ "$registered_desktop" -eq 0 ]; then
    warn "Weder Claude Code noch Claude Desktop gefunden."
    info "Trag das in deinen MCP-Client ein:"
    print_manual_config
  fi
fi

# ---------------------------------------------------------------------------
# 6. Rauchtest
# ---------------------------------------------------------------------------

SMOKE_TIMEOUT=60

# Startet genau die Befehlszeile, die oben registriert wurde — ein Rauchtest mit
# anderen Flags würde etwas anderes prüfen als das, was Claude später startet.
# shellcheck disable=SC2086  # DOCKER_ARGS soll absichtlich in Wörter zerfallen
smoke_run() {
  TELNYX_API_KEY="$API_KEY" TELNYX_TTS_OUTPUT_DIR="$AUDIO_DIR" \
    docker $DOCKER_ARGS < "$smoke_in" > "$smoke_out" 2> "$smoke_err"
}

step "Rauchtest"

[ -n "$TMP_DIR" ] || TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/telnyx-mcp-install.XXXXXX")"
smoke_in="$TMP_DIR/smoke-in.jsonl"
smoke_out="$TMP_DIR/smoke-out.jsonl"
smoke_err="$TMP_DIR/smoke-err.log"

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"telnyx-mcp-install.sh","version":"1.0.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} > "$smoke_in"

info "Container starten und per JSON-RPC nach den Werkzeugen fragen …"
dim  "docker $DOCKER_ARGS"

: > "$smoke_out"
: > "$smoke_err"

smoke_run &
smoke_pid=$!

# Auf die *Antwort* warten, nicht auf das Prozessende: ein stdio-Server darf
# nach dem Antworten weiter auf stdin lauschen. So ist der Test in einer
# Sekunde durch, statt in jedem Lauf gegen das Timeout zu laufen.
waited=0
while [ "$waited" -lt "$SMOKE_TIMEOUT" ]; do
  if grep -q '"estimate_cost"' "$smoke_out" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$smoke_pid" 2>/dev/null; then
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

if kill -0 "$smoke_pid" 2>/dev/null; then
  kill -TERM "$smoke_pid" 2>/dev/null || true
fi
wait "$smoke_pid" 2>/dev/null || true

# Bewertet wird, was zurückkam — nicht der Exit-Code, denn der Container wird
# oben womöglich absichtlich abgeräumt.
if grep -q '"serverInfo"' "$smoke_out" 2>/dev/null \
  && grep -q '"estimate_cost"' "$smoke_out" 2>/dev/null; then
  ok "Der Server antwortet und meldet alle vier Werkzeuge."
  dim "list_voices, speak, render_script, estimate_cost"
elif grep -q '"result"' "$smoke_out" 2>/dev/null; then
  ok "Der Server antwortet auf JSON-RPC."
  warn "Die Werkzeugliste sah anders aus als erwartet — schau einmal selbst hinein."
elif [ "$waited" -ge "$SMOKE_TIMEOUT" ]; then
  warn "Der Container hat in $SMOKE_TIMEOUT Sekunden nicht geantwortet."
  dim  "Image und Konfiguration stehen trotzdem. Prüf es von Hand:"
  dim  "  docker run --rm -i -e TELNYX_API_KEY=\"…\" $IMAGE_NAME"
else
  warn "Keine verwertbare Antwort vom Container."
  if grep -q 'TELNYX_API_KEY' "$smoke_err" 2>/dev/null; then
    dim "Dem Server fehlte der API-Schlüssel (er beendet sich dann mit Code 78)."
  fi
  if [ -s "$smoke_err" ]; then
    dim "Letzte Zeilen von stderr:"
    sed -e 's/^/        /' "$smoke_err" | tail -n 5
  fi
  dim "Image und Konfiguration stehen trotzdem; der Test ist kein Installationsschritt."
fi

# ---------------------------------------------------------------------------
# 7. Abschluss
# ---------------------------------------------------------------------------

step "Fertig"

printf '\n%s%s  telnyx-mcp ist einsatzbereit.%s\n\n' "$C_BOLD" "$C_GREEN" "$C_RESET"
printf '  %sAudiodateien%s   %s\n' "$C_BOLD" "$C_RESET" "$AUDIO_DIR"
printf '  %sImage%s          %s\n' "$C_BOLD" "$C_RESET" "$IMAGE_NAME"

if [ "$DO_REGISTER" -eq 1 ]; then
  printf '  %sSchlüssel%s      aus %s, gesichert in .env\n' "$C_BOLD" "$C_RESET" "$KEY_SOURCE"
  if [ "$registered_code" -eq 1 ] || [ "$registered_desktop" -eq 1 ]; then
    printf '  %sRegistriert%s    ' "$C_BOLD" "$C_RESET"
    if [ "$registered_code" -eq 1 ]; then printf 'Claude Code'; fi
    if [ "$registered_code" -eq 1 ] && [ "$registered_desktop" -eq 1 ]; then printf ' + '; fi
    if [ "$registered_desktop" -eq 1 ]; then printf 'Claude Desktop'; fi
    printf '\n'
    printf '\n  %s→ Claude einmal komplett beenden und neu starten%s, damit der Server\n' "$C_BOLD" "$C_RESET"
    printf '    geladen wird. Dann sind list_voices, speak, render_script und\n'
    printf '    estimate_cost da.\n'
  fi
else
  printf '  %sRegistrierung%s  übersprungen (--no-register)\n' "$C_BOLD" "$C_RESET"
fi

printf '\n  %sNach einem "git pull" einfach erneut laufen lassen:%s\n' "$C_DIM" "$C_RESET"
printf '  %s  cd %s && ./install.sh%s\n\n' "$C_DIM" "$SCRIPT_DIR" "$C_RESET"
