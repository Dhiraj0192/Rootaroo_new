import redis from '../../config/redis';
import logger from '../../shared/utils/logger';
import { getWeather } from '../../services';
import type { WeatherResponse } from './types';

const CACHE_TTL_SECONDS = 600;

// Redis is an optimisation here: any failure falls through to the provider.
export async function getCurrentWeather(lat: number, lon: number): Promise<WeatherResponse> {
  const key = `weather:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  try {
    const cached = await redis.get(key);
    if (cached) return JSON.parse(cached) as WeatherResponse;
  } catch (e) {
    logger.warn('[Weather] cache read failed:', (e as Error).message);
  }

  const result = await getWeather().current(lat, lon);
  try {
    await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS);
  } catch (e) {
    logger.warn('[Weather] cache write failed:', (e as Error).message);
  }
  return result;
}
