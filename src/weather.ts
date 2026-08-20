// Open-Meteo weather integration — no API key required
// Coordinates for Cheltenham, UK
const LAT = 51.9;
const LON = -2.07;

export interface DayForecast {
  date: string; // YYYY-MM-DD
  maxTemp: number;
  minTemp: number;
  precipitationMm: number;
  description: string;
}

// WMO Weather interpretation codes → human-readable description
function wmoDescription(code: number): string {
  if (code === 0) return 'clear sky';
  if (code === 1) return 'mainly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'overcast';
  if (code <= 49) return 'foggy';
  if (code <= 59) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain showers';
  if (code <= 86) return 'snow showers';
  if (code <= 99) return 'thunderstorms';
  return 'mixed conditions';
}

export async function getWeatherForecast(days: number = 7): Promise<DayForecast[]> {
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', LAT.toString());
    url.searchParams.set('longitude', LON.toString());
    url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode');
    url.searchParams.set('timezone', 'Europe/London');
    url.searchParams.set('forecast_days', days.toString());

    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error('Open-Meteo API error:', response.status);
      return [];
    }

    const data = await response.json() as Record<string, unknown>;
    const daily = data.daily as Record<string, unknown[]>;

    const dates = daily.time as string[];
    const maxTemps = daily.temperature_2m_max as number[];
    const minTemps = daily.temperature_2m_min as number[];
    const precip = daily.precipitation_sum as number[];
    const codes = daily.weathercode as number[];

    return dates.map((date, i) => ({
      date,
      maxTemp: Math.round(maxTemps[i]),
      minTemp: Math.round(minTemps[i]),
      precipitationMm: Math.round(precip[i] * 10) / 10,
      description: wmoDescription(codes[i]),
    }));
  } catch (err) {
    console.error('Failed to fetch weather:', err);
    return [];
  }
}

// ── Detailed weather (for the TV dashboard) ─────────────────────────────────────

export interface HourForecast {
  hour: string;        // "14"
  temp: number;
  precipProb: number;  // %
  code: number;
}

export interface DetailedWeather {
  current: { temp: number; description: string; code: number } | null;
  hourly: HourForecast[];
  sunrise: string | null; // "HH:MM"
  sunset: string | null;
  uvMax: number | null;
  pollen: { level: 'Low' | 'Moderate' | 'High' | 'Very high'; type: string } | null;
}

function pollenLevel(grainsPerM3: number): 'Low' | 'Moderate' | 'High' | 'Very high' {
  if (grainsPerM3 < 30) return 'Low';
  if (grainsPerM3 < 50) return 'Moderate';
  if (grainsPerM3 < 150) return 'High';
  return 'Very high';
}

export async function getDetailedWeather(): Promise<DetailedWeather> {
  const empty: DetailedWeather = { current: null, hourly: [], sunrise: null, sunset: null, uvMax: null, pollen: null };
  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', LAT.toString());
    url.searchParams.set('longitude', LON.toString());
    url.searchParams.set('current', 'temperature_2m,weathercode');
    url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weathercode');
    url.searchParams.set('daily', 'sunrise,sunset,uv_index_max');
    url.searchParams.set('timezone', 'Europe/London');
    url.searchParams.set('forecast_days', '2');

    // Pollen comes from the separate air-quality API.
    const pollenUrl = new URL('https://air-quality-api.open-meteo.com/v1/air-quality');
    pollenUrl.searchParams.set('latitude', LAT.toString());
    pollenUrl.searchParams.set('longitude', LON.toString());
    pollenUrl.searchParams.set('hourly', 'grass_pollen,tree_pollen,weed_pollen');
    pollenUrl.searchParams.set('timezone', 'Europe/London');
    pollenUrl.searchParams.set('forecast_days', '1');

    const [wRes, pRes] = await Promise.all([
      fetch(url.toString()),
      fetch(pollenUrl.toString()).catch(() => null),
    ]);
    if (!wRes.ok) return empty;
    const data = await wRes.json() as Record<string, any>;

    const current = data.current
      ? { temp: Math.round(data.current.temperature_2m), description: wmoDescription(data.current.weathercode), code: data.current.weathercode }
      : null;

    const hTimes: string[] = data.hourly?.time ?? [];
    const hTemps: number[] = data.hourly?.temperature_2m ?? [];
    const hProb: number[] = data.hourly?.precipitation_probability ?? [];
    const hCode: number[] = data.hourly?.weathercode ?? [];
    const nowHour = new Date().toISOString().slice(0, 13); // approximate; we filter forward
    const nowIdx = Math.max(0, hTimes.findIndex((t) => t.slice(0, 13) >= nowHour));
    const hourly: HourForecast[] = [];
    for (let i = nowIdx; i < hTimes.length && hourly.length < 7; i += 2) {
      hourly.push({
        hour: hTimes[i]!.slice(11, 13),
        temp: Math.round(hTemps[i] ?? 0),
        precipProb: Math.round(hProb[i] ?? 0),
        code: hCode[i] ?? 0,
      });
    }

    const sunrise = data.daily?.sunrise?.[0]?.slice(11, 16) ?? null;
    const sunset = data.daily?.sunset?.[0]?.slice(11, 16) ?? null;
    const uvMax = data.daily?.uv_index_max?.[0] != null ? Math.round(data.daily.uv_index_max[0]) : null;

    let pollen: DetailedWeather['pollen'] = null;
    if (pRes && pRes.ok) {
      try {
        const pdata = await pRes.json() as Record<string, any>;
        const grass: number[] = pdata.hourly?.grass_pollen ?? [];
        const tree: number[] = pdata.hourly?.tree_pollen ?? [];
        const weed: number[] = pdata.hourly?.weed_pollen ?? [];
        const maxOf = (arr: number[]) => arr.filter((n) => n != null).reduce((m, n) => Math.max(m, n), 0);
        const g = maxOf(grass), t = maxOf(tree), w = maxOf(weed);
        const top = Math.max(g, t, w);
        if (top > 0) {
          const type = top === g ? 'grass' : top === t ? 'tree' : 'weed';
          pollen = { level: pollenLevel(top), type };
        }
      } catch { /* ignore pollen errors */ }
    }

    return { current, hourly, sunrise, sunset, uvMax, pollen };
  } catch (err) {
    console.error('Failed to fetch detailed weather:', err);
    return empty;
  }
}

export function weatherEmojiForCode(code: number): string {
  const d = wmoDescription(code);
  if (d.includes('thunder')) return '⛈';
  if (d.includes('snow')) return '❄️';
  if (d.includes('rain') || d.includes('drizzle') || d.includes('shower')) return '🌧';
  if (d.includes('fog')) return '🌫';
  if (d.includes('overcast')) return '☁️';
  if (d.includes('cloud')) return '⛅';
  if (d.includes('clear')) return '☀️';
  return '🌤';
}

export function formatDayWeather(day: DayForecast): string {
  const rain = day.precipitationMm > 0 ? `, ${day.precipitationMm}mm rain expected` : '';
  return `${day.description}, ${day.minTemp}–${day.maxTemp}°C${rain}`;
}

export function formatWeekWeather(days: DayForecast[]): string {
  return days.map(d => {
    const date = new Date(d.date + 'T12:00:00Z');
    const dayName = date.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });
    return `${dayName}: ${formatDayWeather(d)}`;
  }).join('\n');
}
