# Handleiding Mijn Spullen

Mijn Spullen onthoudt waar je spullen liggen. Iedereen in huis heeft een eigen account en ziet dezelfde spullen;
wijzigingen van anderen verschijnen meteen. Open de app op https://spullen.steno.nl en kies in je browser
*Toevoegen aan startscherm* (Chrome op Android: menu ⋮ → *App installeren*), dan werkt hij als een gewone app.

## In het kort

| Ik wil… | Zo doe je dat |
|---|---|
| iets opbergen | Ga naar de plek (kamer, kast, doos) en tik **+** → *Nieuw item* |
| een kamer, kast of doos maken | **+** → *Nieuwe container* |
| iets terugvinden | Typ in het zoekveld op het startscherm, of gebruik **Zoeken** voor filters |
| een product scannen | Scanknop in de bovenbalk (barcode of QR-label) |
| het aantal aanpassen | **−** en **+** in de lijst |
| iets snel op 0 zetten of weggooien | Veeg de rij naar links: **Op 0** of **Verwijderen** |
| iets terughalen | Tik *Ongedaan maken* in de melding, of *Meer → Prullenbak* (30 dagen) |
| meerdere dingen tegelijk aanpassen | Houd een rij lang ingedrukt en vink de rest aan |

## Spullen en plekken

- **Containers** zijn plekken: huis, kamer, kast, doos, la. Je kunt ze onbeperkt in elkaar zetten.
- **Items** zijn de spullen zelf. Een item heeft een naam, aantal, en naar wens een omschrijving, foto's (tot 10),
  tags, barcode, prijs, houdbaarheidsdatum, een "bijna op"-drempel en notities.
- **Verplaatsen**: open het item → *Wijzig* → kies een andere locatie. Voor meerdere tegelijk: selecteren en *Verplaatsen*.
- **Favorieten**: de ster bij een item. De ster in de bovenbalk toont alleen favorieten op de huidige plek en eronder.
- Bewerkt iemand anders hetzelfde item op hetzelfde moment, dan waarschuwt de app in plaats van stilletjes te overschrijven.

## Toevoegen

Tik **+** op de plek waar het ligt. Je kunt kiezen uit:

- **Nieuw item** of **Nieuwe container**: zelf invullen.
- **Foto maken, AI vult in**: maak een foto, de AI stelt naam, omschrijving, tags en aantal voor. Controleer en sla op.
- **Foto van een open doos of la (AI)**: één foto, en de AI maakt een lijst van alles wat erin zit. Vink af wat niet
  klopt en sla alles in één keer op.
- **Scannen in serie**: de camera blijft open. Elke scan doet +1 bij iets wat er al is, of maakt een nieuw item met
  naam en foto uit Open Food Facts.
- **Lego**: typ het setnummer als naam (bijvoorbeeld `31077`) en tik *Lego-set opzoeken*. Naam, thema, de tag Lego en
  een foto worden ingevuld.

## Tags

Tags zijn labels zoals *Kerst*, *Lego* of *Keuken*. Een tag kan subtags hebben (Lego → Treinen).

- Bij een item zie je alleen de gekozen tags, met een paar suggesties van wat op dezelfde plek vaak gebruikt wordt.
  Tik op *Tags kiezen* voor de doorzoekbare kiezer. Bij een bestaand item wordt een tag meteen opgeslagen.
- Onder **Tags** beheer je naam, kleur en hoofdtag. Filteren op een hoofdtag laat ook alles met een subtag zien.

## Zoeken

Het zoekveld op het startscherm zoekt al tijdens het typen in naam, omschrijving, notities, barcode en tagnamen.
**Zoeken** heeft daarnaast filters: bijna op, verloopt binnenkort, favoriet, uitgeleend en per tag.

## Scannen, NFC en labels

- **Scannen** werkt met barcodes van producten en met de QR-labels van de app. Een QR-label opent meteen die plek.
- **QR-labels printen**: *Meer → Labels printen* (of vanuit een container), in drie formaten.
- **NFC-tags** (Chrome op Android): koppel een tag aan een item of doos. Tag aantikken opent het, ook als de app dicht is.

## Boodschappen, uitlenen en houdbaarheid

- **Lijst**: alles wat onder de drempel zit, plus wat je zelf op de lijst zet. *Gekocht* hoogt het aantal op.
  De lijst kun je delen of naar Home Assistant sturen.
- **Uitlenen**: vul bij een item *Uitgeleend aan* en eventueel een terugbrengdatum in. Is die datum voorbij, dan komt
  er een melding.
- **Houdbaarheid**: items die binnenkort verlopen staan op het startscherm, en Home Assistant stuurt 's ochtends een melding.

## Opruimen

- **Prullenbak** (*Meer → Prullenbak*): verwijderde spullen, mét inhoud, tags en foto's, blijven 30 dagen bewaard en
  komen terug op hun oude plek. Alleen een beheerder kan definitief weggooien.
- **Dubbelen opruimen** (*Meer → Dubbelen opruimen*): vindt dingen met dezelfde naam op dezelfde plek of met dezelfde
  barcode. Je kiest welke blijft; tags, foto's en inhoud gaan mee.

## Importeren

- **Find my stuff importeren** (beheerder): upload het `.bckp`-bestand uit de Android-app. Je ziet eerst een overzicht,
  daarna importeer je alles (of vul je alleen foto's en tags aan bij een eerdere import).
- **Dozenlijst importeren**: een spreadsheet (.ods of .csv) met per regel een doosnummer en de inhoud ernaast.
  Wat er al is, wordt herkend en niet dubbel aangemaakt.
- **CSV**: *Meer → Gegevens → Exporteer als CSV* of *Importeer CSV* (met proefrun).

## Je account

Onder **Meer**: profielfoto, wachtwoord wijzigen, uitloggen en API-tokens (voor Home Assistant of scripts).

## Voor de beheerder

- **Gebruikers**: toevoegen, wachtwoord resetten, blokkeren (de gebruiker wordt dan meteen uitgelogd).
- **Back-ups**: elke nacht automatisch. Download af en toe de volledige `.tar` (met foto's) en bewaar die buiten de
  server. Hoe je een back-up terugzet staat in de [README](README.md#back-up-terugzetten).
- **Koppelingen**: Home Assistant-meldingen en fotoherkenning, zie [KOPPELINGEN.md](KOPPELINGEN.md).
- **Alle spullen wissen**: alleen na het typen van `WISSEN`, en altijd met een back-up vooraf.

## Iets werkt niet?

- **Camera of scannen doet niets**: dat kan alleen via https en met toestemming voor de camera in je browser.
- **Een oude versie blijft hangen**: sluit de app helemaal en open hem opnieuw.
- **"Te veel pogingen"** bij inloggen: wacht 15 minuten, of laat de beheerder je wachtwoord opnieuw instellen.
- **Fotoherkenning druk**: de AI probeert het zelf een paar keer opnieuw; lukt het niet, probeer het later nog eens.
