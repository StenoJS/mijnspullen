# Changelog

Alle versies van Mijn Spullen, nieuwste bovenaan. Hoe je de app gebruikt staat in [HANDLEIDING.md](HANDLEIDING.md).

## 0.10.0 — release candidate voor 1.0 (2026-11-23)

Geen nieuwe functies: deze versie gaat over zekerheid. Als er een week lang geen bugs opduiken, wordt dit 1.0.

**Herstel getest**
- Een echte back-up van de live database (458 spullen, 19 tags, 384 foto's, 4 dingen in de prullenbak) is teruggezet in
  een losse testcontainer zonder netwerk. Alles kwam terug: integriteitscontrole "ok", dezelfde aantallen en alle 384
  foto's laadden. De live gegevens zijn daarbij alleen gelezen.
- Nieuwe automatische test die een los `.db`-bestand én de volledige `.tar` terugzet in een verse map, een nieuwe server
  start en controleert of inloggen, spullen, tags, NFC-koppelingen, foto's, avatars en de prullenbak het nog doen.
- `node server/check-backup.js <bestand.db>` controleert een back-up vóór het terugzetten (alleen-lezen). Het
  stappenplan voor terugzetten staat in de README onder *Back-up terugzetten*.

**Beveiliging**
- Foto's, thumbnails en avatars worden op hun inhoud gecontroleerd (echte JPEG, PNG of WebP), niet alleen op het
  opgegeven type. Ook foto's uit een Find my stuff-back-up, Open Food Facts en Rebrickable. Een nepfoto wordt geweigerd
  of overgeslagen.
- Inloggen: naast de grens per gebruikersnaam nu ook een grens per IP-adres (30 mislukte pogingen per 15 minuten),
  en de responstijd verraadt niet meer of een gebruikersnaam bestaat.
- De eerste installatie kan niet meer door twee gelijktijdige verzoeken twee beheerders opleveren.
- Live-updates (SSE) stoppen vanzelf als iemand uitlogt, geblokkeerd wordt of een nieuw wachtwoord krijgt.
- Wachtwoorden mogen maximaal 256 tekens zijn; een kapot adres geeft een nette 400 in plaats van een interne fout.

**Tests**
- Van 13 naar 26 tests: tags (direct opslaan, vervangen, leegmaken, subtags, kringen, bulk), veegacties (Op 0,
  ongedaan maken, verwijderen en terugzetten met inhoud, tags en foto's), rechten per rol, CSRF, API-tokens, rate limit,
  en de Find my stuff-import met lastige gevallen (getallen en strings als id, kringverwijzingen, ontbrekende ouders,
  nepfoto's, doelcontainer).

**Opgeruimd**
- README bijgewerkt en ingekort; geschiedenis staat nu in dit bestand, gebruik in [HANDLEIDING.md](HANDLEIDING.md).

## 0.8.0 – 0.9.3

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
- 0.8.5: avatars in de activiteit kloppen weer voor elke regel; lange geplakte teksten worden afgebroken en in de
  activiteit ingekort.
- 0.8.6: **live zoeken** op het startscherm (resultaten verschijnen tijdens het typen); bij "Kies een locatie" is de
  boom ingeklapt met een **+** per plek (de weg naar de huidige plek staat open) en kun je bovenin op naam filteren.
- 0.8.7: **lang indrukken** op een ding of doos zet selecteren aan met dat ding al aangevinkt (naast het vinkjes-icoon).
- 0.8.8: vink je het laatste geselecteerde ding uit, dan gaat selecteren vanzelf weer uit.
- 0.9.0: **onderhoud na code review**: id's van spullen en foto's worden nooit hergebruikt (een oud QR-label of NFC-tag wijst niet meer naar iets nieuws, geen verkeerde foto uit de cache; vóór de omzetting wordt automatisch een back-up gemaakt), houdbaarheid rekent met de lokale datum, losse back-ups (imports, samenvoegen) drukken de dagelijkse niet meer weg, de volledige back-up bevat ook foto's uit de prullenbak, een mislukte barcode-opzoeking wordt niet meer onthouden, en een paar ongeldige verzoeken geven een nette melding in plaats van "Interne fout".
- 0.9.1: tags met een lichte kleur (geel, lichtblauw…) krijgen donkere tekst, zodat ze leesbaar zijn.
- 0.9.3: in de lijst kun je een ding naar links vegen voor twee snelle knoppen: **Op 0** (aantal op nul, bijvoorbeeld als iets op is) en **Verwijderen** (naar de prullenbak). Beide met "Ongedaan maken" in de melding; een doos met inhoud vraagt eerst om bevestiging.
- 0.9.2: tags kiezen is overzichtelijk: alleen gekozen tags staan bij een item, met een paar slimme suggesties (wat er op dezelfde plek vaak op zit) en een doorzoekbare kiezer waarin subtags onder hun hoofdtag ingeklapt staan en de meest gebruikte bovenaan. Ook het tagfilter bij Zoeken en de bulk-tagknop gebruiken die kiezer.

## 0.7

- **Lego-sets op nummer**: typ een setnummer als naam (bijv. `31077` of `Lego 60050`) en tik "Lego-set opzoeken": naam,
  omschrijving (thema, jaar, aantal onderdelen), de tag Lego en een foto worden ingevuld. *Meer → Lego-sets aanvullen* doet
  dit in één keer voor alle bestaande spullen met alleen een nummer als naam. Bron: de gratis database-download van
  [Rebrickable](https://rebrickable.com) (geen account nodig), maandelijks ververst in `/data/lego`.

## 0.6

- **Doos met inhoud fotograferen** (*Toevoegen → Foto van een open doos of la (AI)*): de AI stelt een naam voor de
  doos en een lijst met alles wat erin zit voor. Vink af wat niet klopt, pas namen/aantallen aan en sla op: de
  container (met de foto) en de items worden in één keer aangemaakt. Vanuit een container kun je ook kiezen om de
  spullen direct daarin te zetten.
- Fotoherkenning probeert het bij drukte bij Google zelf opnieuw en kan uitwijken naar een tweede AI-taak (0.5.1).

## 0.5

- **Fotoherkenning (AI)**: *Toevoegen → Foto maken, AI vult in*, of de AI-knop bij de foto's van een item. De app stuurt
  de foto naar Home Assistant (`image/upload`), laat `ai_task.generate_data` (standaard `ai_task.google_ai_task`) een
  naam, omschrijving, tags en aantal voorstellen, en ruimt de foto in HA daarna op. Instellen: *Meer → Koppelingen →
  Fotoherkenning*: plak een langlevend HA-token (wordt alleen op de server bewaard). HA wordt bereikt via de host van
  `HA_WEBHOOK_URL` of `HA_URL`; `HA_TOKEN` en `HA_AI_ENTITY` mogen ook als omgevingsvariabele.

## 0.4

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

## 0.3

- **Find my stuff-back-up importeren** (*Meer → Find my stuff importeren*, beheerder): upload het `.bckp`-bestand
  (zip met `backup.txt` + foto's), bekijk het overzicht en importeer. Containers, items, tags (kleur benaderd),
  barcodes, prijzen (centen → euro), houdbaarheid, aankoopdatum (in notities) en alle foto's komen mee.
  Thumbnails worden daarna in de browser gemaakt. Zet in NPM `client_max_body_size 200m;` voor grote back-ups.

## 0.2

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

## 0.1.0-alpha.1 — eerste versie

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
