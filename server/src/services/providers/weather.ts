import { AppError } from '../../shared/utils/errors';
import type { WeatherResponse } from '../../modules/weather/types';
import type { WeatherProvider } from '../types';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';

// WMO weather codes (https://open-meteo.com/en/docs), collapsed into the
// small set of conditions the dashboard pill actually shows.
const WMO_CONDITIONS: Record<number, { condition: string; emoji: string }> = {
  0: { condition: 'Clear sky', emoji: '☀️' },
  1: { condition: 'Mostly clear', emoji: '🌤️' },
  2: { condition: 'Partly cloudy', emoji: '⛅' },
  3: { condition: 'Overcast', emoji: '☁️' },
  45: { condition: 'Foggy', emoji: '🌫️' },
  48: { condition: 'Foggy', emoji: '🌫️' },
  51: { condition: 'Light drizzle', emoji: '🌦️' },
  53: { condition: 'Drizzle', emoji: '🌦️' },
  55: { condition: 'Dense drizzle', emoji: '🌦️' },
  56: { condition: 'Freezing drizzle', emoji: '🌦️' },
  57: { condition: 'Freezing drizzle', emoji: '🌦️' },
  61: { condition: 'Light rain', emoji: '🌧️' },
  63: { condition: 'Rain', emoji: '🌧️' },
  65: { condition: 'Heavy rain', emoji: '🌧️' },
  66: { condition: 'Freezing rain', emoji: '🌧️' },
  67: { condition: 'Freezing rain', emoji: '🌧️' },
  71: { condition: 'Light snow', emoji: '🌨️' },
  73: { condition: 'Snow', emoji: '🌨️' },
  75: { condition: 'Heavy snow', emoji: '🌨️' },
  77: { condition: 'Snow grains', emoji: '🌨️' },
  80: { condition: 'Light showers', emoji: '🌦️' },
  81: { condition: 'Showers', emoji: '🌦️' },
  82: { condition: 'Violent showers', emoji: '🌦️' },
  85: { condition: 'Snow showers', emoji: '🌨️' },
  86: { condition: 'Snow showers', emoji: '🌨️' },
  95: { condition: 'Thunderstorm', emoji: '⛈️' },
  96: { condition: 'Thunderstorm', emoji: '⛈️' },
  99: { condition: 'Thunderstorm', emoji: '⛈️' },
};

function resolveCondition(code: number): { condition: string; emoji: string } {
  return WMO_CONDITIONS[code] || { condition: 'Unknown', emoji: '🌡️' };
}

async function fetchCurrent(lat: number, lon: number): Promise<WeatherResponse> {
  const url = `${OPEN_METEO_URL}?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&temperature_unit=celsius`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new AppError(502, `Weather lookup failed: ${(error as Error).message}`);
  }
  if (!res.ok) {
    throw new AppError(502, `Weather lookup failed: ${res.status}`);
  }

  const data = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
  const tempC = data?.current?.temperature_2m;
  const weatherCode = data?.current?.weather_code;
  if (typeof tempC !== 'number' || typeof weatherCode !== 'number') {
    throw new AppError(502, 'Weather lookup returned an unexpected shape');
  }

  const { condition, emoji } = resolveCondition(weatherCode);
  return { tempC: Math.round(tempC), condition, emoji };
}

export const openMeteoWeather: WeatherProvider = {
  name: 'open-meteo',
  current: fetchCurrent,
};
