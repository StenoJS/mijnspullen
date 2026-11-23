# Mijn Spullen — 0.10.1 (release candidate voor 1.0)

Zelf gehoste, multiuser inventaris-app: weet waar al je spullen liggen. Webapp (PWA, installeerbaar op je telefoon)
met een eigen server en database. Geen cloud van derden, **geen npm-dependencies**.

Functionele inspiratie: de Android-app *Find my stuff* (geneste containers, tags, aantallen met drempel,
houdbaarheidsdatums, barcode/QR, foto's). Er is geen code of materiaal uit die app overgenomen.

## Wat kan het

Containers onbeperkt nesten (huis → kamer → kast → doos), items met aantal, drempel, prijs, houdbaarheid, barcode,
foto's en tags, live bijgewerkt voor iedereen in huis. Verder: scannen (barcode/QR), NFC-tags, QR-labels printen,
Open Food Facts, Lego-sets op nummer, fotoherkenning via Home Assistant, prullenbak, uitlenen, boodschappenlijst,
dubbelen opruimen, imports (CSV, dozenlijst, Find my stuff-back-up) en dagelijkse back-ups.

- **Gebruiken:** zie [HANDLEIDING.md](HANDLEIDING.md)
- **Wat is er veranderd:** zie [CHANGELOG.md](CHANGELOG.md)
- **Koppelingen** (Home Assistant, AI, Rebrickable): zie [KOPPELINGEN.md](KOPPELINGEN.md)

Instellingen (omgevingsvariabelen in de stack): `APP_URL`, `HA_WEBHOOK_URL`, `NOTIFY_DAYS` (7), `NOTIFY_HOUR` (8),
`BACKUP_HOUR` (3), `BACKUP_KEEP` (14).

**Bewust niet (voor nu):** offline gebruik, meerdere gescheiden inventarissen. Iedereen met een account ziet en bewerkt
dezelfde spullen; beheerders regelen gebruikers, back-ups, imports, koppelingen en definitief weggooien.

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

Automatisch: elke nacht om `BACKUP_HOUR` een kopie van de database in `/data/backups` (de laatste 14 dagelijkse,
plus de laatste 14 losse van vóór imports en samenvoegen). Onder *Meer → Back-ups* (beheerder) download je een los
`.db`-bestand of de **volledige `.tar`** (database + alle foto's + avatars + foto's in de prullenbak).

Een los `.db`-bestand bevat géén foto's. Bewaar dus af en toe een `.tar` buiten de server.

Handmatig het hele volume kopiëren kan ook:

```bash
docker stop mijn-spullen
docker run --rm -v mijn-spullen_mijn-spullen-data:/data -v "$PWD":/backup alpine tar czf /backup/mijn-spullen-backup-$(date +%F).tgz -C /data .
docker start mijn-spullen
```

## Back-up terugzetten

Getest in 0.10 met een echte back-up in een losse testcontainer (zie CHANGELOG). Zet altijd eerst een verse back-up
van de huidige staat opzij, dan kun je terug als het terugzetten niet bevalt.

**1. Controleer de back-up** (alleen-lezen, wijzigt niets):

```bash
docker exec mijn-spullen node server/check-backup.js /data/backups/mijn-spullen-2026-11-23.db
```

`"ok": true` en minstens één beheerder? Dan is het bestand bruikbaar. Je ziet ook hoeveel spullen, tags en foto's erin zitten.

**2a. Alleen de database terugzetten** (foto's op de server blijven staan):

```bash
docker stop mijn-spullen
docker run --rm -v mijn-spullen_mijn-spullen-data:/data alpine sh -c '
  cp /data/mijn-spullen.db /data/backups/mijn-spullen-voor-herstel.db &&
  cp /data/backups/mijn-spullen-2026-11-23.db /data/mijn-spullen.db &&
  rm -f /data/mijn-spullen.db-wal /data/mijn-spullen.db-shm &&
  chown 1000:1000 /data/mijn-spullen.db'
docker start mijn-spullen
```

Haal de `-wal`- en `-shm`-bestanden echt weg: die horen bij de oude database en kunnen de teruggezette anders beschadigen.

**2b. Volledige `.tar` terugzetten** (database + foto's), met het bestand in de huidige map:

```bash
docker stop mijn-spullen
docker run --rm -v mijn-spullen_mijn-spullen-data:/data -v "$PWD":/backup alpine sh -c '
  mkdir -p /data/voor-herstel && mv /data/mijn-spullen.db* /data/images /data/voor-herstel/ &&
  tar xf /backup/mijn-spullen-volledig-2026-11-23.tar -C /data && chown -R 1000:1000 /data'
docker start mijn-spullen
```

**3. Controleer** in de containerlog dat de app opstart (`Mijn Spullen … luistert op :3000`), log in en kijk of je
spullen en foto's er zijn. Alles goed? Dan mag `/data/voor-herstel` weg.

Spullen, foto's en NFC-/QR-koppelingen houden na herstel hun oude nummers. Wachtwoorden zijn die van het moment van
de back-up. Een back-up van een oudere versie wordt bij het opstarten vanzelf bijgewerkt naar het nieuwe schema.

## Opbouw

```
server/index.js   HTTP-server, API-routes, SSE, statische bestanden
server/db.js      SQLite-schema + migraties (node:sqlite)
server/auth.js    wachtwoorden (scrypt), sessies, rate limit
public/           PWA: index.html, app.js (views), lib.js (hulpfuncties), style.css, sw.js
server/check-backup.js  controle van een back-up vóór het terugzetten
test/             API- en hersteltests (node --test)
```

Beveiliging: wachtwoorden met scrypt, sessiecookie `HttpOnly; SameSite=Lax; Secure`, CSRF-header op alle schrijfacties,
login rate limit (10 pogingen per naam en 30 per IP-adres per 15 min, gelijke responstijd voor onbekende namen),
foto's worden op inhoud gecontroleerd (JPEG/PNG/WebP), strikte Content-Security-Policy en `nosniff`, API-tokens alleen
als hash opgeslagen, CSV-export beschermd tegen formule-injectie, live-updates stoppen bij uitloggen of blokkeren.

## Op weg naar 1.0

0.10 is de release candidate: een week gewoon gebruiken zonder nieuwe functies. Duiken er geen bugs op, dan wordt dit
1.0. Nieuwe wensen (zoals een Android-app via Capacitor) komen in 1.1.
