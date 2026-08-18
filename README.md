# Fresh Knowledge Manager

Lokale Web-App zum Verwalten der Freshservice-Knowledge-Base (Solutions) mit

- **Übersicht**: Kategorien → Ordner → Artikel, Suche, Tag-Cloud, Status-/Sortierfilter, Artikelansicht inkl. HTML-Quelltext
- **Add KB**: eigener Editor (TinyMCE, WYSIWYG + HTML-Quellcode-Ansicht), speichert sauberes HTML ins Freshservice-Feld `description`
- **Add by AI**: grobe Beschreibung → ChatGPT (OpenAI API, System-Prompt = dein bestehender „Freshservice KB“-GPT) erstellt Titel, Artikel im Freshservice-HTML-Format, Tags, Keywords + Ordnervorschlag → Review, Änderungen anfragen (Chat) → per API als Entwurf/veröffentlicht einfügen oder im Editor weiterbearbeiten

## Start

```bash
npm install
npm start
# → http://127.0.0.1:3847
```

Beim ersten Start öffnet sich das Einstellungsfenster:

| Feld | Woher |
|---|---|
| Freshservice-Domain | z. B. `meinefirma` oder `meinefirma.freshservice.com` |
| Freshservice-API-Key | Freshservice → Profilbild → *Profileinstellungen* → rechts *„Ihr API-Schlüssel“* |
| Workspace-ID | nur nötig, wenn dein Account mehrere Workspaces hat |
| OpenAI-API-Key | https://platform.openai.com/api-keys |
| Modell / Reasoning-Effort | Standard `gpt-5.5` / `medium` (Modell frei editierbar; Effort nur für gpt-5*/o-Modelle) |

Die Keys werden lokal in `data/config.json` gespeichert (gitignored) und ausschließlich vom lokalen Node-Server verwendet — der Browser sieht sie nie. Alternativ per Umgebungsvariablen: `FRESHSERVICE_DOMAIN`, `FRESHSERVICE_API_KEY`, `FRESHSERVICE_WORKSPACE_ID`, `OPENAI_API_KEY` (ENV hat Vorrang). Port/Host über `PORT` / `HOST`.

## KI-Agent

Ein Custom GPT aus ChatGPT lässt sich nicht direkt per API aufrufen; deshalb stehen seine Instruktionen wörtlich als System-Prompt in `lib/ai.js` (`AGENT_INSTRUCTIONS`). Ergänzt ist nur ein kurzer Integrationsblock: die Antwort kommt als JSON (`title`, `description_html`, `tags`, `keywords`, `suggested_folder_id`, `notes_for_reviewer`) via OpenAI Structured Outputs — die HTML-Formatregeln des Agents gelten unverändert für `description_html` (Intro `<p id="isPasted">`, Abschnittstitel `<p><strong>…</strong></p>`, nur `<ul>`, Code-Blöcke im Freshservice-`<pre code-brush>`-Format, Übersetzung nach Englisch als Standard). Über „Sprache“ in der KI-Ansicht kann die Übersetzung übersteuert werden. Prompt-Änderungen: einfach `AGENT_INSTRUCTIONS` anpassen.

## Hinweise

- **„Alle Artikel laden“** holt jeden Artikel aller Ordner (viele API-Calls, Freshservice-Rate-Limit beachten). Danach funktionieren Tag-Cloud, Tag-Filter und lokale Volltextsuche. Ohne das wird die Freshservice-Suche (`/solutions/articles/search`) verwendet.
- Freshservice erwartet im Feld `description` HTML. Der Editor behält die Freshservice-spezifischen Attribute der Code-Blöcke bei (`extended_valid_elements`). Bilder bitte per URL einbinden — Base64-Bilder werden beim Einfügen bewusst nicht erzeugt.
- Die KI liefert immer den **kompletten** Artikel zurück (auch bei kleinen Änderungswünschen); der Verlauf wird pro Sitzung im Browser gehalten. Titel in der Vorschau ist direkt editierbar.
- Freshservice-Werte: `status` 1 = Entwurf, 2 = Veröffentlicht; `article_type` 1 = Permanent, 2 = Workaround.

## Ohne echtes Freshservice ausprobieren

```bash
npm run mock      # Mock-Freshservice auf http://127.0.0.1:3901 (Demo-Daten, in-memory)
npm start
```
In den Einstellungen als Domain `http://127.0.0.1:3901` und einen beliebigen API-Key eintragen.

## Struktur

```
server.js            Express-Server: Config, Freshservice-Proxy, KI-Endpunkt
lib/freshservice.js  Freshservice API v2 Client (Solutions)
lib/ai.js            OpenAI-Aufruf (Chat Completions, Structured Output) + Agent-Prompt
lib/config.js        Speichern/Laden der Einstellungen
public/              Frontend (index.html, app.js, styles.css)
scripts/             Mock-Freshservice für lokale Tests
```
