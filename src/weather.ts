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
