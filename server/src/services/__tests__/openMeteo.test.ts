import { openMeteoWeather } from '../providers/weather';

const getCurrentWeather = (lat: number, lon: number) => openMeteoWeather.current(lat, lon);

describe('open-meteo provider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('fetches and parses current temperature and condition', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 21.6, weather_code: 3 },
      }),
    }) as unknown as typeof fetch;

    const result = await getCurrentWeather(27.7, 85.3);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('latitude=27.7&longitude=85.3'),
    );
    expect(result).toEqual({ tempC: 22, condition: 'Overcast', emoji: '☁️' });
  });

  it('falls back to Unknown for an unmapped weather code', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 10, weather_code: 999 },
      }),
    }) as unknown as typeof fetch;

    const result = await getCurrentWeather(0, 0);

    expect(result).toEqual({ tempC: 10, condition: 'Unknown', emoji: '🌡️' });
  });

  it('throws when the upstream response is not ok', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as unknown as typeof fetch;

    await expect(getCurrentWeather(0, 0)).rejects.toThrow('Weather lookup failed: 500');
  });

  it('throws when the network request itself fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    await expect(getCurrentWeather(0, 0)).rejects.toThrow('Weather lookup failed: network down');
  });

  it('throws when the response shape is unexpected', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ current: {} }),
    }) as unknown as typeof fetch;

    await expect(getCurrentWeather(0, 0)).rejects.toThrow('unexpected shape');
  });
});
