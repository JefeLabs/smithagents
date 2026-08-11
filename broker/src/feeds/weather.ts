/**
 * Open-Meteo: no key, no account, no quota worth worrying about.
 *
 * Weather is not an item (spec §3) — it is one current reading rendered
 * straight into the digest, because a temperature is not a document.
 */

/** WMO weather codes, collapsed to words a person would actually say. */
function sky(code: number): string {
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code >= 95) return 'storms';
  if (code >= 80) return 'showers';
  if (code >= 61) return 'rain';
  if (code >= 45) return 'fog';
  return 'clear';
}

export function weatherUrl(lat: number, lon: number): string {
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,weather_code&hourly=precipitation_probability&forecast_days=1`
  );
}

export function weatherLine(body: unknown): string | null {
  const b = body as {
    current?: { temperature_2m?: number; weather_code?: number };
    hourly?: { time?: string[]; precipitation_probability?: number[] };
  } | null;
  const temp = b?.current?.temperature_2m;
  if (typeof temp !== 'number') return null;

  const base = `${Math.round(temp)}°C, ${sky(b?.current?.weather_code ?? 0)}`;
  const times = b?.hourly?.time ?? [];
  const probs = b?.hourly?.precipitation_probability ?? [];
  const idx = probs.findIndex((p) => p >= 60);
  if (idx === -1 || !times[idx]) return `${base}.`;
  return `${base}; rain likely ${times[idx]!.slice(11, 16)}.`;
}
