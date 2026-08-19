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

**Key-Speicherung: ausschließlich im Browser.** Alle Zugangsdaten liegen nur im `localStorage` des Browsers und werden bei jeder Anfrage als Header (`x-fs-domain`, `x-fs-key`, `x-fs-workspace`, `x-openai-key`, `x-ai-model`, `x-ai-effort`) an den App-Server geschickt, der sie nur an Freshservice/OpenAI durchreicht und **nichts persistiert** (kein Config-File, keine Datenbank). Damit auch `<img>`-Vorschauen von Freshservice-Anhängen funktionieren, ergänzt ein Service Worker (`public/sw.js`) diese Header im Browser. „Keys löschen“ in den Einstellungen entfernt alles wieder.

Optional kann der Betreiber Server-Standardwerte per Umgebungsvariablen setzen (`FRESHSERVICE_DOMAIN`, `FRESHSERVICE_API_KEY`, `FRESHSERVICE_WORKSPACE_ID`, `OPENAI_API_KEY`, `AI_MODEL`, `AI_EFFORT`) — im Browser eingetragene Werte haben Vorrang. Port/Host über `PORT` / `HOST`.

> Wird die App nicht nur lokal, sondern für mehrere Nutzer auf einem Server betrieben: unbedingt **HTTPS** verwenden (Keys gehen als Header über die Leitung; der Service Worker läuft nur in sicheren Kontexten — `localhost` gilt als sicher).

## KI-Agent

Ein Custom GPT aus ChatGPT lässt sich nicht direkt per API aufrufen; deshalb stehen seine Instruktionen wörtlich als System-Prompt in `lib/ai.js` (`AGENT_INSTRUCTIONS`). Ergänzt ist nur ein kurzer Integrationsblock: die Antwort kommt als JSON (`title`, `description_html`, `tags`, `keywords`, `suggested_folder_id`, `notes_for_reviewer`) via OpenAI Structured Outputs — die HTML-Formatregeln des Agents gelten unverändert für `description_html` (Intro `<p id="isPasted">`, Abschnittstitel `<p><strong>…</strong></p>`, nur `<ul>`, Code-Blöcke im Freshservice-`<pre code-brush>`-Format, Übersetzung nach Englisch als Standard). Über „Sprache“ in der KI-Ansicht kann die Übersetzung übersteuert werden. Prompt-Änderungen: einfach `AGENT_INSTRUCTIONS` anpassen.

## Identität / Autor

Nach der ersten erfolgreichen Freshservice-Verbindung fragt die App „Wer bist du?“ (Auswahl aus der Agentenliste, `GET /agents`). Bestehende Nutzer bekommen nach dem Update einmalig denselben Dialog mit Hinweis. Die Identität wird – wie alles andere – nur im Browser gespeichert und als **Autor** für neue Artikel vorbelegt; im Editor lässt sich pro Artikel ein anderer Autor wählen.

Technischer Hintergrund: Die Freshservice-API kennt kein schreibbares Autor-Feld; offiziell ist immer der Besitzer des API-Keys Autor. Die App schickt trotzdem `agent_id` mit (und wiederholt ohne, falls die Instanz das Feld ablehnt). Wird der Autor nativ übernommen, meldet der Speichern-Toast „nativ gesetzt“; sonst wird (abschaltbar) die Zeile `<p><em>Author: Name</em></p>` am Artikelende ergänzt und beim nächsten Bearbeiten als Autor erkannt. Sicher korrekt ist der Autor nur mit dem persönlichen API-Key des jeweiligen Nutzers.

## Hinweise

- **„Alle Artikel laden“** holt jeden Artikel aller Ordner (viele API-Calls, Freshservice-Rate-Limit beachten). Danach funktionieren Tag-Cloud, Tag-Filter und lokale Volltextsuche. Ohne das wird die Freshservice-Suche (`/solutions/articles/search`) verwendet.
- Freshservice erwartet im Feld `description` HTML. Der Editor behält die Freshservice-spezifischen Attribute der Code-Blöcke bei (`extended_valid_elements`).
- **Bilder**: Die Freshservice-API akzeptiert keine Base64-Bilder im Artikel-HTML. Deshalb werden Bilder aus dem Editor (Upload-Tab, Strg+V, Drag&Drop) zunächst lokal zwischengespeichert (`/api/uploads/<id>`, In-Memory, 24 h) und beim Speichern per Multipart als `attachments[]` an den Artikel gehängt; anschließend wird `<img src>` auf die dauerhafte `canonical_url` (`https://<domain>/helpdesk/attachments/<id>`) umgeschrieben. In der App-Vorschau werden diese Bilder über `/api/fs/attachment/<id>?article=<artikel-id>&orig=<url>` geproxyt: Der Server liest den Artikel per API, nimmt die signierte `attachment_url` des Anhangs und streamt sie (die Helpdesk-Route selbst akzeptiert keine API-Key-Auth und liefert nur die Login-Seite). Beim Speichern wird wieder exakt die Original-URL aus `orig` eingesetzt.
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
lib/config.js        Credentials pro Request aus Headern (+ ENV-Defaults) – nichts wird gespeichert
public/              Frontend (index.html, app.js, styles.css, sw.js)
scripts/             Mock-Freshservice für lokale Tests
```
