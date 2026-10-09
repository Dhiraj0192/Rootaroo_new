jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn() } }));
jest.mock('../../shared/utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import redis from '../../config/redis';
import logger from '../../shared/utils/logger';
import { initServices, getEmail, getSms, getErrorReporter, getWeather, __setServicesForTests, __resetServicesForTests } from '..';
import { sendEmail } from '../../shared/utils/mailer';
import { sendSms } from '../../shared/utils/sms';
import { getCurrentWeather } from '../../modules/weather/service';

const base = { email: 'log', sms: 'log', push: 'log', storage: 's3', weather: 'open-meteo', monitoring: 'console', keyVault: 'local' } as const;

beforeEach(() => {
  jest.clearAllMocks();
  __resetServicesForTests();
});

describe('log and disabled providers', () => {
  it('log email resolves and logs the recipient and subject, not the body', async () => {
    initServices({ ...base });
    await getEmail().send({ to: 'a@example.com', subject: 'Your code', text: 'code 123456' });
    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(logged).toContain('a@example.com');
    expect(logged).toContain('Your code');
    expect(logged).not.toContain('123456');
    expect(getEmail().name).toBe('log');
  });

  it('disabled SMS rejects so callers can surface an error', async () => {
    initServices({ ...base, sms: 'disabled' });
    await expect(getSms().send('+15550001111', 'hi')).rejects.toThrow('SMS is disabled');
  });

  it('console error reporter logs the error', () => {
    initServices({ ...base });
    getErrorReporter().capture(new Error('boom'), { route: '/x' });
    expect(logger.error).toHaveBeenCalled();
  });

  it('getters throw a clear error before initServices', () => {
    expect(() => getEmail()).toThrow('Services not initialised');
  });
});

describe('callers go through the providers', () => {
  it('sendEmail delegates to the email provider', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    __setServicesForTests({ email: { name: 'fake', send } });
    await sendEmail('a@example.com', 'Hi', 'Body');
    expect(send).toHaveBeenCalledWith({ to: 'a@example.com', subject: 'Hi', text: 'Body' });
  });

  it('sendSms delegates to the SMS provider', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    __setServicesForTests({ sms: { name: 'fake', send } });
    await sendSms('+15550001111', 'code');
    expect(send).toHaveBeenCalledWith('+15550001111', 'code');
  });
});

describe('weather', () => {
  const forecast = jest.fn();
  beforeEach(() => {
    __setServicesForTests({ weather: { name: 'fake', current: forecast } });
  });

  it('serves a cached reading without calling the provider', async () => {
    (redis.get as jest.Mock).mockResolvedValue(JSON.stringify({ tempC: 21, condition: 'Clear sky', emoji: '☀️' }));
    const result = await getCurrentWeather(27.717245, 85.323961);
    expect(result).toEqual({ tempC: 21, condition: 'Clear sky', emoji: '☀️' });
    expect(redis.get).toHaveBeenCalledWith('weather:27.72:85.32');
    expect(forecast).not.toHaveBeenCalled();
  });

  it('fetches on a miss and caches for 10 minutes', async () => {
    (redis.get as jest.Mock).mockResolvedValue(null);
    forecast.mockResolvedValue({ tempC: 18, condition: 'Rain', emoji: '🌧️' });
    const result = await getCurrentWeather(27.717245, 85.323961);
    expect(result.tempC).toBe(18);
    expect(forecast).toHaveBeenCalledWith(27.717245, 85.323961);
    expect(redis.set).toHaveBeenCalledWith('weather:27.72:85.32', JSON.stringify(result), 'EX', 600);
  });

  it('still answers when Redis is down', async () => {
    (redis.get as jest.Mock).mockRejectedValue(new Error('down'));
    (redis.set as jest.Mock).mockRejectedValue(new Error('down'));
    forecast.mockResolvedValue({ tempC: 18, condition: 'Rain', emoji: '🌧️' });
    await expect(getCurrentWeather(1, 2)).resolves.toEqual({ tempC: 18, condition: 'Rain', emoji: '🌧️' });
  });

  it('the default weather provider is Open-Meteo', () => {
    initServices({ ...base });
    expect(getWeather().name).toBe('open-meteo');
  });
});
