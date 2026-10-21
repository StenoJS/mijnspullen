// Web NFC (Chrome op Android). Tags krijgen een gewone URL, zodat ze ook werken als de app dicht is:
// Android opent dan direct het juiste item of de juiste container.

export const nfcSupported = () => 'NDEFReader' in window;
export const normSerial = (s) => String(s || '').toLowerCase();

export function urlFromMessage(message) {
  const dec = new TextDecoder();
  for (const r of (message && message.records) || []) {
    if (r.recordType === 'url' || r.recordType === 'absolute-url') return dec.decode(r.data);
    if (r.recordType === 'text') { const t = dec.decode(r.data); if (/^https?:\/\//.test(t)) return t; }
  }
  return null;
}

// Wacht op één tag. Geeft { serial, url } terug, of gooit een fout (geen toestemming, afgebroken).
export async function readTag(signal) {
  const reader = new NDEFReader();
  await reader.scan({ signal });
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Afgebroken', 'AbortError')), { once: true });
    reader.onreadingerror = () => { /* tag niet leesbaar (leeg of onbekend formaat): blijf wachten */ };
    reader.onreading = (e) => resolve({ serial: normSerial(e.serialNumber), url: urlFromMessage(e.message), reader });
  });
}

// Lees het serienummer en schrijf meteen de URL op dezelfde tag.
export async function linkTag(url, signal) {
  const { serial, reader } = await readTag(signal);
  let wrote = false, writeError = null;
  try {
    await reader.write({ records: [{ recordType: 'url', data: url }] }, { overwrite: true, signal });
    wrote = true;
  } catch (e) { writeError = e; }
  return { serial, wrote, writeError };
}
