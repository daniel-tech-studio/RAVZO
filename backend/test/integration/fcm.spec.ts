import { generateKeyPairSync, createVerify } from 'crypto';
import { writeFileSync } from 'fs';
import { config } from '../../src/common/config';
import { FcmPushService } from '../../src/modules/platform/fcm-push.service';
import { api, approve, createTestApp, Ctx, setupOwner } from '../helpers';

describe('Push FCM (réseau intercepté)', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const realFetch = global.fetch;
  beforeAll(async () => {
    base = await createTestApp();
    writeFileSync('/tmp/ravzo-test-sa.json', JSON.stringify({ client_email: 'svc@ravzo-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
    Object.assign(config.fcm, { projectId: 'ravzo-test', serviceAccountFile: '/tmp/ravzo-test-sa.json' });
  });
  afterAll(async () => { global.fetch = realFetch; Object.assign(config.fcm, { projectId: '', serviceAccountFile: '' }); await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); });

  it('jeton OAuth signé, montants masqués, jeton invalide supprimé, révocation = jetons effacés', async () => {
    const calls: { url: string; body: any }[] = [];
    global.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('oauth2')) {
        const assertion = new URLSearchParams(init.body).get('assertion')!;
        const [h, p, s] = assertion.split('.');
        expect(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
        expect(JSON.parse(Buffer.from(p, 'base64url').toString()).scope).toContain('firebase.messaging');
        return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
      }
      const body = JSON.parse(init.body);
      calls.push({ url: u, body });
      if (body.message.token.startsWith('dead')) return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      return new Response(JSON.stringify({ name: 'projects/x/messages/1' }), { status: 200 });
    }) as any;
    await api(ctx).post('/notifications/push-devices', { token: 'good-token-aaaaaaaaaaaaaaaaaaaa', platform: 'macos' }).expect(201);
    await ctx.prisma.pushDeviceToken.create({ data: { ownerId: ctx.ownerId, deviceId: (await ctx.prisma.trustedDevice.findFirstOrThrow()).id, token: 'dead-token-bbbbbbbbbbbbbbbbbbbbb', platform: 'android' } }).catch(async () => {
      // un appareil = un jeton : on simule un 2e appareil
      const d2 = await ctx.prisma.trustedDevice.create({ data: { ownerId: ctx.ownerId, name: 'Android', platform: 'android', publicKey: 'x', fingerprint: 'fp-2', status: 'ACTIVE' } });
      await ctx.prisma.pushDeviceToken.create({ data: { ownerId: ctx.ownerId, deviceId: d2.id, token: 'dead-token-bbbbbbbbbbbbbbbbbbbbb', platform: 'android' } });
    });
    const svc = base.app.get(FcmPushService);
    const r = await svc.send(ctx.ownerId, { id: '11111111-2222-3333-4444-555555555555', type: 'payment.succeeded', priority: 'HIGH', title: 'Paiement confirmé', body: 'Paiement de 10 150 FCFA à Awa', link: '/money/payments/x' });
    expect(r.status).toBe('SENT');
    const good = calls.find((c) => c.body.message.token.startsWith('good'))!;
    expect(good.url).toBe('https://fcm.googleapis.com/v1/projects/ravzo-test/messages:send');
    expect(good.body.message.notification.body).toBe('Paiement de ••• à Awa');
    expect(good.body.message.data.link).toBe('/money/payments/x');
    expect(await ctx.prisma.pushDeviceToken.count({ where: { token: { startsWith: 'dead' } } })).toBe(0);
    // Révocation de l'appareil → jeton supprimé
    const me = await ctx.prisma.trustedDevice.findFirstOrThrow({ where: { fingerprint: { not: 'fp-2' } } });
    const other = await ctx.prisma.trustedDevice.create({ data: { ownerId: ctx.ownerId, name: 'iPhone', platform: 'ios', publicKey: 'y', fingerprint: 'fp-3', status: 'ACTIVE' } });
    await ctx.prisma.pushDeviceToken.create({ data: { ownerId: ctx.ownerId, deviceId: other.id, token: 'ios-token-cccccccccccccccccccccc', platform: 'ios' } });
    await api(ctx).post(`/devices/${other.id}/revoke`, { approval: await approve(ctx, 'device.revoke', { deviceId: other.id }) }).expect(200);
    expect(await ctx.prisma.pushDeviceToken.count({ where: { deviceId: other.id } })).toBe(0);
    expect(await ctx.prisma.pushDeviceToken.count({ where: { deviceId: me.id } })).toBe(1);
  });

  it('sans compte de service : NOT_CONFIGURED, aucun appel', async () => {
    Object.assign(config.fcm, { serviceAccountFile: '/nonexistent.json' });
    global.fetch = (async () => { throw new Error('ne doit pas être appelé'); }) as any;
    expect((await base.app.get(FcmPushService).send(ctx.ownerId, { id: 'a', type: 't', priority: 'LOW', title: 't', body: 'b', link: null })).status).toBe('NOT_CONFIGURED');
    Object.assign(config.fcm, { serviceAccountFile: '/tmp/ravzo-test-sa.json' });
  });
});
