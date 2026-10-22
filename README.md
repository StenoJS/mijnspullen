# Mijn Spullen — 0.8.4

Zelf gehoste, multiuser inventaris-app: weet waar al je spullen liggen. Webapp (PWA, installeerbaar op je telefoon)
met een eigen server en database. Geen cloud van derden, **geen npm-dependencies**.

Functionele inspiratie: de Android-app *Find my stuff* (geneste containers, tags, aantallen met drempel,
houdbaarheidsdatums, barcode/QR, foto's). Er is geen code of materiaal uit die app overgenomen.

## Wat zit er in 0.1 alpha

- Inloggen met gebruikersaccounts (eerste account = beheerder; beheerder voegt anderen toe, blokkeert, reset wachtwoorden)
- Eén gedeelde inventaris voor iedereen, **live bijgewerkt** bij wijzigingen van anderen (SSE)
- Onbeperkt geneste containers (huis → kamer → kast → doos) met items erin
- Items: naam, aantal (+/− direct in de lijst), "bijna op"-drempel, prijs, houdbaar tot, barcode/QR, omschrijving, notities, favoriet
- Tags met hiërarchie en kleur; filteren op een tag neemt subtags mee
- Zoeken (woorden in naam/omschrijving/notities/barcode/tag) + filters: bijna op, verloopt binnen 30 dagen, favoriet, tag
- Barcode/QR scannen met de camera (browser `BarcodeDetector`, handmatige invoer als terugval)
- Tot 10 foto's per item, in de browser verkleind (max 1600 px) + thumbnail
- Verplaatsen van items/containers, cascade-verwijderen (met bevestiging)
- Conflictdetectie bij gelijktijdig bewerken (versienummer per item)
- Activiteitenlog, CSV-export, donker thema (volgt systeem)

### Nieuw in 0.8

- **Dozenlijst importeren** (*Meer → Dozenlijst importeren*): een .ods- of .csv-sheet met per regel een doosnummer en in
  de cellen ernaast de inhoud. Bestaande dozen ("Box 101", "Doos 101") en spullen worden herkend (Lego op setnummer, de
  rest op naam), dus alleen wat ontbreekt staat aangevinkt; wat al op een andere plek staat wordt gemeld maar niet
  aangevinkt. Lego-setnummers krijgen naam, thema, tag en foto. Er wordt vooraf een back-up gemaakt.
- Dozen heten consequent **"Doos 101"** (0.8.1): bestaande "101" en "Box 101" worden eenmalig hernoemd en dubbele
  dozen met hetzelfde nummer op dezelfde plek samengevoegd (back-up vooraf).
- 0.8.2: **ster** in de bovenbalk toont alleen favorieten (in de huidige plek en alles eronder); bij bewerken staat
  **Opslaan** ook rechtsboven; Omschrijving staat direct onder Naam; "Boodschappen" heet nu **Lijst**; de tegels op
  het startscherm passen op een smalle telefoon.
- 0.8.3: **avatar** per gebruiker: een gekleurd rondje met je eerste letter, of een eigen foto (*Meer → tik op je
  rondje*). Zichtbaar bij Gebruikers en in de activiteit.
- 0.8.4: lange namen lopen door op een tweede regel in plaats van af te kappen; in een doos of kamer staat de titel
  onder de knoppen in de bovenbalk.

### Nieuw in 0.7

- **Lego-sets op nummer**: typ een setnummer als naam (bijv. `31077` of `Lego 60050`) en tik "Lego-set opzoeken": naam,
  omschrijving (thema, jaar, aantal onderdelen), de tag Lego en een foto worden ingevuld. *Meer → Lego-sets aanvullen* doet
  dit in één keer voor alle bestaande spullen met alleen een nummer als naam. Bron: de gratis database-download van
  [Rebrickable](https://rebrickable.com) (geen account nodig), maandelijks ververst in `/data/lego`.

### Nieuw in 0.6

- **Doos met inhoud fotograferen** (*Toevoegen → Foto van een open doos of la (AI)*): de AI stelt een naam voor de
  doos en een lijst met alles wat erin zit voor. Vink af wat niet klopt, pas namen/aantallen aan en sla op: de
  container (met de foto) en de items worden in één keer aangemaakt. Vanuit een container kun je ook kiezen om de
  spullen direct daarin te zetten.
- Fotoherkenning probeert het bij drukte bij Google zelf opnieuw en kan uitwijken naar een tweede AI-taak (0.5.1).

### Nieuw in 0.5

- **Fotoherkenning (AI)**: *Toevoegen → Foto maken, AI vult in*, of de AI-knop bij de foto's van een item. De app stuurt
  de foto naar Home Assistant (`image/upload`), laat `ai_task.generate_data` (standaard `ai_task.google_ai_task`) een
  naam, omschrijving, tags en aantal voorstellen, en ruimt de foto in HA daarna op. Instellen: *Meer → Koppelingen →
  Fotoherkenning*: plak een langlevend HA-token (wordt alleen op de server bewaard). HA wordt bereikt via de host van
  `HA_WEBHOOK_URL` of `HA_URL`; `HA_TOKEN` en `HA_AI_ENTITY` mogen ook als omgevingsvariabele.

### Nieuw in 0.4

- **Prullenbak met ongedaan maken**: verwijderen zet een item (met inhoud, tags en foto's) 30 dagen in *Meer → Prullenbak*
  (`TRASH_DAYS`). Direct na verwijderen staat er "Ongedaan maken" in de melding. Terugzetten gebeurt op de oude plek.
- **Meerdere tegelijk selecteren** (knop met vinkjes in een container of bij zoeken): verplaatsen, tag geven,
  op de boodschappenlijst zetten of verwijderen in één keer.
- **Uitlenen**: bij een item "Uitgeleend aan" + terugbrengdatum. Badge "Bij …" in lijsten, filter *Uitgeleend*,
  teller op het startscherm, en een Home Assistant-melding (`lend_overdue`) als de datum verstreken is.
- **Boodschappenlijst** (*Meer → Lijst* of de tegel op het startscherm): alles wat bijna op is plus wat je
  zelf op de lijst zet. "Gekocht" hoogt het aantal op. Delen/kopiëren, of naar Home Assistant sturen (event `shopping`).
- **Dubbelen opruimen** (0.4.1, *Meer → Dubbelen opruimen*): vindt spullen met dezelfde naam op dezelfde plek (en items
  met dezelfde barcode). Kies welke blijft; tags, foto's en lege velden komen mee, containers worden inclusief inhoud
  samengevoegd en de lege kopie gaat naar de prullenbak. Beheerder: "Alles samenvoegen" (met back-up vooraf).
- **Serie-scannen** (bij *Toevoegen → Scannen in serie*): camera blijft open, elke scan in deze container doet +1 bij
  een bekend product of maakt een nieuw item aan (met naam en foto uit Open Food Facts).

### Nieuw in 0.3

- **Find my stuff-back-up importeren** (*Meer → Find my stuff importeren*, beheerder): upload het `.bckp`-bestand
  (zip met `backup.txt` + foto's), bekijk het overzicht en importeer. Containers, items, tags (kleur benaderd),
  barcodes, prijzen (centen → euro), houdbaarheid, aankoopdatum (in notities) en alle foto's komen mee.
  Thumbnails worden daarna in de browser gemaakt. Zet in NPM `client_max_body_size 200m;` voor grote back-ups.

### Nieuw in 0.2

- **NFC-tags** (Chrome op Android, Web NFC): koppel een tag aan een item of container. De app zet de link op de tag, dus
  tag aantikken opent het juiste item ook als de app dicht is. Alleen-lezen tags werken via de scanknop (serienummer).
- **QR-labels printen** voor een container en alles eronder (klein/middel/groot, optioneel ook items). Scannen opent de plek.
- **Betere scanner**: hoge resolutie, continu scherpstellen, lamp en zoom (als de telefoon dat kan), controle op het
  EAN-controlegetal en twee gelijke lezingen voor streepjescodes (minder misreads), trilt bij succes.
- **Product opzoeken** bij een EAN: naam, omschrijving en productfoto uit Open Food Facts / Open Products Facts.
- **Foto's**: aparte knoppen voor camera en galerij.
- **CSV-import** met proefrun (eigen export, of andere CSV met kolommen naam, locatie "A > B", aantal, …).
- **Automatische back-ups**: elke nacht een kopie van de database in `/data/backups` (laatste 14), plus downloads
  (los bestand of volledige `.tar` met foto's) onder *Meer → Back-ups*.
- **Home Assistant**: webhook-meldingen bij "bijna op" en bij houdbaarheid (dagelijks), en `GET /api/summary` voor sensoren.
- **API-tokens** (`Authorization: Bearer ms_…`) voor HA, scripts of een latere native app.

Instellingen (omgevingsvariabelen in de stack): `APP_URL`, `HA_WEBHOOK_URL`, `NOTIFY_DAYS` (7), `NOTIFY_HOUR` (8),
`BACKUP_HOUR` (3), `BACKUP_KEEP` (14).

**Nog niet:** offline gebruik, meerdere inventarissen/rechten per gebruiker, Find my stuff-specifiek importformaat.

## Draaien in Portainer (patroon: `*.steno.nl`, netwerk `hassio`, NPM)

### 1. Image bouwen
Kies één van deze twee:

**A. Vanuit een Git-repository (aanbevolen)** — zet de map in een (privé) repo en maak in Portainer een stack:
*Stacks → Add stack → Repository*, Compose path `docker-compose.yml`, daarna *Deploy the stack*.

**B. Zonder Git** — op de Docker-host (of via Portainer → *Images → Build a new image → Upload*, tar van deze map):

```bash
cd /pad/naar/mijn-spullen
docker build -t mijn-spullen:0.1.0-alpha.1 .
```

Maak daarna in Portainer een stack (*Web editor*) met de inhoud van `docker-compose.yml` (de regel `build: .` mag dan weg).

### 2. Reverse proxy (Nginx Proxy Manager)
Nieuwe Proxy Host:

| Veld | Waarde |
|---|---|
| Domain Names | `spullen.steno.nl` (of een andere naam) |
| Scheme / Forward Hostname / Port | `http` / `mijn-spullen` / `3000` (hostnaam, **geen** container-IP) |
| Websockets Support | aan (niet verplicht; SSE werkt ook zonder) |
| SSL | Request new Let's Encrypt certificate, Force SSL aan |

Voor live-updates (SSE) mag NPM de respons niet bufferen. Zet in het tabblad *Advanced*:

```nginx
proxy_buffering off;
proxy_read_timeout 1h;
```

### 3. Eerste keer
Open `https://spullen.steno.nl`, maak het beheerdersaccount aan, voeg daarna de gezinsleden toe onder *Meer → Gebruiker toevoegen*.
Camera (scannen/foto's) werkt alleen via HTTPS.

## Lokaal ontwikkelen / testen

Vereist Node ≥ 22.13.

```bash
cd mijn-spullen
npm test
DATA_DIR=./data PORT=3000 COOKIE_SECURE=0 node --disable-warning=ExperimentalWarning server/index.js
```

Open http://localhost:3000.

## Back-up

Alles staat in het volume `mijn-spullen-data` (SQLite-bestand + map `images`). Stop de container kort en kopieer het volume:

```bash
docker stop mijn-spullen
docker run --rm -v mijn-spullen-data:/data -v "$PWD":/backup alpine tar czf /backup/mijn-spullen-backup-$(date +%F).tgz -C /data .
docker start mijn-spullen
```

## Opbouw

```
server/index.js   HTTP-server, API-routes, SSE, statische bestanden
server/db.js      SQLite-schema + migraties (node:sqlite)
server/auth.js    wachtwoorden (scrypt), sessies, rate limit
public/           PWA: index.html, app.js (views), lib.js (hulpfuncties), style.css, sw.js
test/             API-test (node --test)
```

Beveiliging: wachtwoorden met scrypt, sessiecookie `HttpOnly; SameSite=Lax; Secure`, CSRF-header op alle schrijfacties,
login rate limit (10 pogingen / 15 min), strikte Content-Security-Policy, CSV-export beschermd tegen formule-injectie.

## Roadmap (voorstel)

1. 0.2 — CSV-import (ook voor een FindMyStuff-export), automatische back-up naar een tweede locatie
2. 0.3 — Herinneringen (houdbaarheid/voorraad) via Home Assistant of Telegram, labels/QR-stickers printen
3. 0.4 — Prullenbak, bulkacties, uitlenen, boodschappenlijst, serie-scannen (klaar)
4. 0.5 — Offline-modus met synchronisatie, telmodus, garantie/bonnetjes, rechten per gebruiker
5. Optioneel — PostgreSQL in plaats van SQLite
