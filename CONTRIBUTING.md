# Mitarbeiten

## Die eine Regel: `dist/` gehört in den Commit

Dieses Repository wird über `npx -y git+ssh://git@github.com/m8rzel/telnyx-mcp.git`
direkt aus GitHub gestartet. Damit dabei auf dem Zielrechner **nichts kompiliert werden
muss**, liegt das Build-Ergebnis im Repository und `package.json` hat bewusst _kein_
`prepare`-Script.

Der Preis dafür: Wer `src/` ändert, muss `dist/` mitliefern. Sonst läuft bei allen, die
den Server per `npx` einbinden, weiter der alte Code — ohne jede Fehlermeldung.

Vor jedem Commit:

```bash
npm run check        # lint + build + tests
git add -A           # dist/ nicht vergessen
```

Vor jedem Push prüfen, dass Quelle und Build zusammenpassen:

```bash
npm run verify:dist  # baut neu, bricht mit Exit-Code 1 ab, wenn dist/ abweicht
```

`npm run verify:dist` ist die ehrliche Variante von „ich hab bestimmt gebaut“. Läuft es
durch, ist der Commit konsistent.

## Release

1. `npm version <major|minor|patch>` — Version in `package.json`.
2. `npm run check` und `npm run verify:dist`.
3. Commit, PR gegen `main`, Merge.
4. Tag auf `main` setzen und pushen: `git tag v1.0.1 && git push origin v1.0.1`.
5. Den Tag in den produktiven MCP-Config-Einträgen hochziehen
   (`…telnyx-mcp.git#v1.0.1`), Client neu starten.

Der Tag ist nicht Kosmetik: Ohne Pin zieht jeder `npx`-Start den aktuellen Stand von
`main`: ein Push würde ungefragt die laufende Installation anderer ändern.

## Was nicht ins Repository gehört

- Echte API-Schlüssel. Der Server liest `TELNYX_API_KEY` ausschließlich aus der
  Umgebung; `.env` ist ignoriert, `.env.example` ist die Vorlage.
- MP3-Dateien und sonstige Build-Nebenprodukte außer `dist/`.
- `node_modules/`.

## Tests

`npm test` läuft offline und ohne API-Schlüssel: Die HTTP-Schicht ist gemockt, die
MP3-Fixtures sind als Base64 in `tests/fixtures/index.ts` eingebettet. Neue Fixtures
erzeugt `node scripts/make-fixtures.mjs` (braucht ffmpeg).
