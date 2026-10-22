# Mijn Spullen: wat staat waar

Overzicht van alle koppelingen en waar je ze beheert. Hier staan geen geheimen in, alleen waar ze bewaard worden.

| Onderdeel | Waar | Wat | Geheim? Waar bewaard |
|---|---|---|---|
| App | https://spullen.steno.nl | De webapp (PWA). Het eerste account is beheerder. | Wachtwoorden: in de app-database |
| Code | GitHub `StenoJS/mijnspullen` (publiek), branch `claude/project-thread-12qyas` | Broncode, README | Nee |
| Container | Portainer → Stacks → `mijn-spullen` (id 27, endpoint 1) | Bouwt uit Git, netwerk `hassio`, poort 3000. Data in volume `mijn-spullen-data` (`/data`). | Stack-env: `APP_URL`, `HA_WEBHOOK_URL` (bevat het webhook-id) |
| Uitrollen | Portainer → stack → "Pull and redeploy" (met "Re-pull image") | Automatisch bijwerken staat niet aan, dus uitrollen gaat met de hand | — |
| Proxy en SSL | Nginx Proxy Manager → Proxy host 32 → `mijn-spullen:3000` | Let's Encrypt-certificaat 43. Uploads tot 200 MB, buffering uit (live updates). | Nee |
| Meldingen naar Telegram | HA → Automatiseringen → "Mijn Spullen: meldingen (bijna op, houdbaarheid)" | Webhook (alleen lokaal) → `notify.telegram_jeroen`. Ontvangt: bijna op, houdbaarheid, te laat terug, boodschappenlijst. | Webhook-id: in de automation en in de stack-env |
| Fotoherkenning (AI) | App: Meer → Koppelingen → Fotoherkenning | De app stuurt een foto naar HA, en HA vraagt Gemini om naam, omschrijving en tags. De foto wordt daarna in HA weer verwijderd. | HA-token: alleen in de app-database. Intrekken: HA → profiel → Beveiliging → Langlevende toegangstokens → "Mijn Spullen" |
| Gemini | HA → Integraties → Google Generative AI → "Google AI Task" (`ai_task.google_ai_task`, aanbevolen model) | Het AI-model achter de fotoherkenning (en je HA-assistent) | Google API-sleutel: in de HA-integratie, aangemaakt in Google AI Studio |
| API-tokens van de app | App: Meer → Koppelingen → API-tokens | Voor scripts en HA-sensoren (`Authorization: Bearer ms_…`) | Alleen een hash in de app-database |
| Back-ups | App: Meer → Back-ups, en elke nacht automatisch om 03:00 in `/data/backups` (laatste 14) | Database, plus een volledige download met foto's | — |

## Kosten

- **Gemini**: hangt af van je Google AI Studio-project. Kijk op https://aistudio.google.com/apikey: de kolom "Plan" toont "Free" of "Paid"/"Tier 1".
  - **Free**: kost niets, maar heeft limieten. Bij drukte geeft Google vaker "high demand"-fouten.
  - **Paid**: betaling per gebruik. Een fotoherkenning kost een fractie van een cent.
- De rest (app, Portainer, NPM, HA) draait op je eigen server en kost niets extra.

## Bij problemen

- **"De AI-dienst (Google) is nu overbelast"**: de app probeert het zelf drie keer en geeft dan een knop "Opnieuw". Wil je een uitwijkmogelijkheid, maak dan in HA bij Google Generative AI een tweede AI Task aan met een ander model, bijvoorbeeld een "flash-lite"-model. Zet die als tweede in Meer → Koppelingen → Fotoherkenning → AI-entiteit, bijvoorbeeld `ai_task.google_ai_task, ai_task.google_ai_task_2`.
- **Geen Telegram-meldingen**: controleer of de automation aan staat, en of `HA_WEBHOOK_URL` in de stack begint met `http://172.30.32.1:8123` (`homeassistant` werkt niet vanuit Portainer-containers).
