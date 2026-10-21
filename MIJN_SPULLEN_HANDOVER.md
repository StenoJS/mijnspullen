# Mijn Spullen — Handover (v0.1.0-alpha.1)

**Eigenaar/context:** Steno (Jeroen Steenhagen), Hengelo. Eigen self-hosted omgeving op `*.steno.nl`: Portainer-beheerde Docker-host (gedeeld netwerk `hassio`), Nginx Proxy Manager (NPM) met Let's Encrypt, Tailscale als achtervang. Eigen code staat op GitHub onder `StenoJS/*` en wordt via Portainer-stacks "from repository" uitgerold (bijv. `vault-broker-mcp`, `lidl-mcp`, `npm-mcp`).

## Doel

Een eigen multiuser inventaris-app om spullen thuis bij te houden ("waar ligt wat"), met een database en server in Steno's eigen omgeving (geen cloud van derden). Functioneel geïnspireerd op de Android-app *Find my stuff* (Home Organizer, package `com.miquelcms.homeorganizer`, v1.26.2, de APK was de aanleiding). **Er is geen code of materiaal uit die app overgenomen** (de APK bevat advertenties, billing en een licentiecheck). Naam: **Mijn Spullen**. Eerder idee onder de naam "Stockpile" (React single-file app); dit project vervangt dat.

De 0.1 alpha is gebouwd, geslaagd getest, maar **nog niet uitgerold**. Dat is de eerste taak (zie Volgende stappen).

## Context — bestaande setup ter vergelijking

- Voorbeeld-app (Find my stuff) heeft: geneste containers, tags met kleur en hiërarchie, aantallen met drempels (kritiek/laag), houdbaarheidsdatum met meldingen, barcode/QR/NFC, foto's, CSV/spreadsheet-import-export, back-ups/snapshots, eigen sync-server, favorieten, geavanceerd zoeken, rollen, profielen met aanpasbare velden.
- Steno's andere services (`ah-mcp`, `lidl-mcp`, `supermarkt-mcp`, `ical-fix`, `bambuddy`, `spoolman`, …) draaien als Portainer-stacks op endpoint id 1 ("primary") en zijn bereikbaar via NPM-proxyhosts naar **containernaam:poort** (bijv. `http://ical-fix:8000`).
- Mijn Spullen volgt hetzelfde patroon: container `mijn-spullen`, netwerk `hassio`, poort 3000, gewenst domein `spullen.steno.nl` (nog niet bevestigd; zie stappen).

## Technische lessen (niet opnieuw ontdekken)

Infra (uit Steno's vaste patroon):
- Altijd containernamen als hostnaam in NPM, nooit container-IP's (IP's wisselen na update/reboot, geeft 502).
- Nieuwe containers op extern netwerk `hassio`; beheer via Portainer, niet via losse `docker run`.
- Geen secrets in chat/logs plakken; NPM-access-logs bevatten query-strings.

Deze build:
- **Runtime:** Node ≥ 22.13. SQLite via ingebouwde `node:sqlite` (geeft een ExperimentalWarning; in Docker onderdrukt met `--disable-warning=ExperimentalWarning`). Daardoor **nul npm-dependencies**; geen `npm install` nodig.
- **Tests:** `node --test test/` (alleen mapnaam) faalt op Node 22; gebruik de glob `node --test "test/*.test.js"` (staat in `npm test`).
- **DOM-helper:** in `public/lib.js` flattent `h()` arrays, maar `Element.replaceChildren(array)` doet dat **niet** (maakt er "[object HTMLDivElement]" van). Gebruik `replaceChildren(...flat(...))`. Dit was een echte bug (foto's/tags verschenen niet).
- **CSP:** strikte Content-Security-Policy (`script-src 'self'`, geen inline scripts, geen eval). Playwright's `wait_for_function` met string werkt daardoor niet; gebruik locators (`wait_for_selector('.x:text-is("3")')`).
- **Live-updates (SSE):** client stuurt `X-Client-Id` mee; server zet die als `src` in het event; de client negeert alleen events met zijn eigen `src`. (Eerst filter op user-id: dan zag je wijzigingen van je eigen telefoon niet op je laptop.) In NPM moet buffering uit voor `/api/events`: `proxy_buffering off; proxy_read_timeout 1h;` in het tabblad Advanced.
- **CSRF:** alle schrijfacties vereisen header `X-Requested-With: mijn-spullen` (+ `SameSite=Lax` cookie). Wie een externe client/script bouwt moet die header meesturen.
- **Cookies:** `COOKIE_SECURE=1` is default in de Dockerfile (HTTPS via NPM). Voor een test op `http://IP:3000` op `0` zetten, anders blijft inloggen "niet ingelogd".
- **Camera/barcode:** `BarcodeDetector` + `getUserMedia` vereisen HTTPS; Safari/iOS ondersteunt `BarcodeDetector` niet → handmatige invoer is de terugval (staat erin).
- **Sessie-omgeving (Claude cloud-chat):** kan geen GitHub-repo's aanmaken (`gh api user/repos` → 403, "sessions are bound to their configured repositories"); GraphQL is geblokkeerd, alleen REST op gekoppelde repo's. DNS voor `*.steno.nl` is vanuit die sandbox niet te testen. In een Claude Code-sessie met de repo gekoppeld speelt dit niet.
- **Portainer-MCP:** `StackCreateDockerStandaloneRepository` (RepositoryURL, Name, endpointId=1, ComposeFile) bestaat; env-waarden van stacks worden geredacteerd getoond; `StackUpdate` vervangt de héle Env.

## Systeemoverzicht

Repo-indeling:

```
server/index.js   HTTP-server (node:http), router, alle API-routes, SSE, statische bestanden, security headers
server/db.js      node:sqlite schema + migraties (meta.schema_version), tx()-helper
server/auth.js    scrypt-wachtwoorden, sessies (sha256 van token in DB), cookies, login rate limit
public/           PWA zonder build-stap: index.html, app.js (views/router), lib.js (h(), api(), iconen, dialogs, foto-verkleinen), style.css, sw.js, manifest, icons/
test/api.test.js  end-to-end API-test (setup, users, boom, zoeken, conflict 409, foto, export, cascade-delete, logout)
Dockerfile        node:22-alpine, USER node, volume /data, healthcheck op /api/health
docker-compose.yml  service mijn-spullen, extern netwerk hassio, volume mijn-spullen-data, geen gepubliceerde poort
README.md         uitrol- en back-upinstructies
```

Omgevingsvariabelen: `PORT` (3000), `DATA_DIR` (`/data` in Docker, `./data` lokaal), `TRUST_PROXY=1` (X-Forwarded-For voor rate limit), `COOKIE_SECURE=1`, `TZ`.

Data (in `DATA_DIR`): `mijn-spullen.db` (SQLite, WAL) + `images/<id>.<ext>` en `images/<id>.thumb.<ext>`.

Schema (v1): `users` (admin/member, disabled), `sessions`, `things` (één tabel voor containers én items: `parent_id`, `is_container`, `name`, `description`, `notes`, `quantity`, `min_quantity`, `barcode`, `price`, `expires_on`, `favourite`, `version`, created/updated by/at), `tags` (`parent_id`, `color`), `thing_tags`, `images` (`has_thumb`, `position`), `activity` (laatste 5000), `meta`.

API (alles onder `/api`, JSON, cookie `ms_session`):
- Auth: `GET setup-status`, `POST setup` (alleen als er nog geen users zijn → eerste admin), `POST login`, `POST logout`, `GET me`, `POST me/password`.
- Users: `GET users`, `POST users` (admin), `PATCH users/:id` (admin: naam/rol/blokkeren/wachtwoord reset).
- Things: `GET things?parent=root|id&q=&tag=&low=1&expiring=N&favourite=1&barcode=&scope=id&sort=&limit=`, `GET things/:id` (incl. breadcrumb `path`, images, namen), `POST things`, `PATCH things/:id` (meesturen `version`; mismatch → 409 met `current`), `POST things/:id/adjust {delta}`, `DELETE things/:id` (cascade), `GET tree`.
- Tags: `GET/POST tags`, `PATCH/DELETE tags/:id` (filteren op tag neemt subtags mee).
- Images: `POST things/:id/images` (raw body, image/jpeg|png|webp, max 8 MB, max 10 per item), `PUT images/:id/thumb`, `GET images/:id[?thumb=1]` (auth vereist), `DELETE images/:id`.
- Overig: `GET stats`, `GET activity`, `GET events` (SSE), `GET export.csv`, `GET health`.

Frontend: hash-router (`#/` = root-container lijst, `#/c/:id` container, `#/t/:id` item bewerken, `#/new?container=0|1&parent=&barcode=`, `#/search?q=&low=1&expiring=30&favourite=1&tag=`, `#/tags`, `#/more`). Nederlandse UI, mobile-first, donker thema via `prefers-color-scheme`.

## Scope — wel / niet (fase 0.1)

Wel (klaar en getest): accounts + beheer, gedeelde inventaris, live-updates, geneste containers/items, aantallen + drempel, houdbaarheid, prijs, barcode/QR-scan, foto's (client-side verkleind), tags met hiërarchie, zoeken + filters, verplaatsen, activiteitenlog, CSV-export, PWA-installeerbaar, conflictdetectie.

Niet in 0.1 (bewust): CSV-import (ook Find my stuff-export; formaat onbekend, voorbeeld nodig), offline/sync, push-/herinneringsmeldingen, NFC, meerdere inventarissen of rechten per gebruiker, automatische back-up, labels/QR-stickers printen, PostgreSQL, native Android-app (zou dezelfde API kunnen gebruiken, bijv. met Capacitor).

## Volgende stappen

1. Repo `StenoJS/mijn-spullen` (privé) aanmaken/koppelen aan de Claude Code-sessie en deze map erin zetten (zonder `data/` en `node_modules/`; `.gitignore` staat erin). Commit en push.
2. Lokaal verifiëren: `npm test` en `DATA_DIR=./data PORT=3000 COOKIE_SECURE=0 node --disable-warning=ExperimentalWarning server/index.js`.
3. Portainer-stack `mijn-spullen` aanmaken vanuit de repo (endpoint 1, `docker-compose.yml`; `build: .` bouwt de image). Controleer dat de container op netwerk `hassio` draait en gezond is (`/api/health`). Git-credentials voor een privé-repo: gebruik een bestaande Portainer Git-credential of vraag Steno om een token (niet in documenten opslaan).
4. DNS/NPM: bevestig met Steno de domeinnaam (voorstel `spullen.steno.nl`) en dat er een DNS-record/wildcard is. NPM-proxyhost → `http://mijn-spullen:3000`, nieuw Let's Encrypt-certificaat, Force SSL, `proxy_buffering off; proxy_read_timeout 1h;` in Advanced. Geen access list nodig (de app heeft eigen login).
5. Eerste keer: `https://<domein>` openen, beheerdersaccount aanmaken, gezinsleden toevoegen (Meer → Gebruiker toevoegen). Testen op telefoon: installeren als PWA, scannen, foto, live-update tussen twee apparaten.
6. Daarna 0.2: CSV-import (vraag Steno om een voorbeeldexport uit Find my stuff), automatische back-up van het volume naar een tweede locatie, eventueel herinneringen via Home Assistant of Telegram.

Open vraag aan Steno: blijft SQLite voldoende, of liever PostgreSQL (bijv. als er al een Postgres-container draait)? Standaard: SQLite.
