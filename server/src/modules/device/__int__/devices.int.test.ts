import request from 'supertest';
import app from '../../../app';
import { setupAssociations, Device, RefreshToken } from '../../../database/models';
import { resetDb, closeIntResources } from '../../../test/int/db';

beforeAll(() => setupAssociations());
beforeEach(() => resetDb());
afterAll(() => closeIntResources());

const PHONE = { 'X-Device-Id': '11111111-2222-4333-8444-555555555555', 'X-Device-Name': "Asha's iPhone", 'X-Platform': 'ios', 'X-App-Version': '1.4.0' };
const TABLET = { 'X-Device-Id': '66666666-7777-4888-9999-000000000000', 'X-Device-Name': 'Kitchen tablet', 'X-Platform': 'android', 'X-App-Version': '1.4.0' };
const creds = { email: 'asha@example.test', password: 'correct horse battery' };

async function signIn(headers: Record<string, string>) {
  const res = await request(app).post('/api/v1/auth/login').set(headers).send(creds);
  expect(res.status).toBe(200);
  return res.body.data.tokens as { accessToken: string; refreshToken: string };
}

describe('devices (real database)', () => {
  it('each sign-in is a device; the list marks this one; removing the other signs it out', async () => {
    const reg = await request(app).post('/api/v1/auth/register').set(PHONE).send({ ...creds, displayName: 'Asha' });
    expect(reg.status).toBe(201);
    const phone = await signIn(PHONE);
    const tablet = await signIn(TABLET);

    expect(await Device.count()).toBe(2);
    // One session per device: the phone's register + login left one refresh token, not two.
    expect(await RefreshToken.count()).toBe(2);

    const list = await request(app).get('/api/v1/devices').set('Authorization', `Bearer ${phone.accessToken}`);
    expect(list.status).toBe(200);
    const devices = list.body.data as Array<{ id: string; name: string; current: boolean }>;
    expect(devices.map((d) => [d.name, d.current]).sort()).toEqual([["Asha's iPhone", true], ['Kitchen tablet', false]]);

    const tabletId = devices.find((d) => d.name === 'Kitchen tablet')!.id;
    const del = await request(app).delete(`/api/v1/devices/${tabletId}`).set('Authorization', `Bearer ${phone.accessToken}`);
    expect([200, 204]).toContain(del.status);

    const refreshed = await request(app).post('/api/v1/auth/refresh').set(TABLET).send({ refreshToken: tablet.refreshToken });
    expect(refreshed.status).toBe(401);

    const stillOk = await request(app).post('/api/v1/auth/refresh').set(PHONE).send({ refreshToken: phone.refreshToken });
    expect(stillOk.status).toBe(200);
  });

  it("cannot remove someone else's device", async () => {
    await request(app).post('/api/v1/auth/register').set(PHONE).send({ ...creds, displayName: 'Asha' });
    const other = await request(app).post('/api/v1/auth/register').set(TABLET).send({ email: 'ravi@example.test', password: 'another long pass', displayName: 'Ravi' });
    const asha = await signIn(PHONE);
    const raviDevice = await Device.findOne({ where: { userId: other.body.data.user.id } });
    const res = await request(app).delete(`/api/v1/devices/${raviDevice!.id}`).set('Authorization', `Bearer ${asha.accessToken}`);
    expect(res.status).toBe(404);
  });
});
