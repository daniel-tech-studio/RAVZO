import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { execSync } from 'child_process';
import { generateKeyPairSync, KeyObject, sign } from 'crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap-app';
import { clock } from '../src/common/clock';
import { PrismaService } from '../src/common/prisma.service';
import { IdentityService } from '../src/modules/identity/identity.service';

let migrated = false;
export function migrateTestDb() {
  if (migrated) return;
  execSync('npx prisma migrate deploy', { env: { ...process.env }, stdio: 'ignore' });
  migrated = true;
}

export async function resetDb(prisma: PrismaService) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
}

export class TestDevice {
  readonly privateKey: KeyObject;
  readonly publicKeyB64: string;
  constructor(public name = 'Test Mac') {
    const kp = generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKeyB64 = (kp.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
  }
  info() { return { publicKey: this.publicKeyB64, name: this.name, platform: 'test' }; }
  signChallenge(ch: { challengeId: string; message: string; nonce: string }) {
    return { challengeId: ch.challengeId, signature: `${sign(null, Buffer.from(ch.message), this.privateKey).toString('base64')}.${ch.nonce}` };
  }
}

export interface Ctx { app: INestApplication; prisma: PrismaService; http: () => any; token: string; device: TestDevice; recoveryCodes: string[]; ownerId: string }

let keyCounter = 0;
export const idemKey = () => `test-key-${Date.now()}-${++keyCounter}`;

export async function createTestApp(): Promise<{ app: INestApplication; prisma: PrismaService }> {
  migrateTestDb();
  const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = mod.createNestApplication({ bodyParser: false, logger: ['error'] });
  configureApp(app);
  await app.init();
  // Un seul serveur à l'écoute réutilisé par supertest (évite l'ouverture/fermeture par requête, source de « socket hang up »).
  await app.listen(0, '127.0.0.1');
  return { app, prisma: app.get(PrismaService) };
}

export const EMAIL = 'owner@ravzo.test';
export const PASSWORD = 'correct horse battery staple';

/** Propriétaire + premier appareil enrôlé par code de bootstrap. */
export async function setupOwner(app: INestApplication, prisma: PrismaService): Promise<Ctx> {
  clock.reset();
  await resetDb(prisma);
  const boot = await app.get(IdentityService).bootstrapOwner(EMAIL, PASSWORD, 'Test Owner');
  const device = new TestDevice();
  const login = await request(app.getHttpServer()).post('/api/v1/identity/login').send({ email: EMAIL, password: PASSWORD, device: device.info() }).expect(200);
  const token = login.body.data.accessToken;
  await request(app.getHttpServer()).post('/api/v1/devices/enrollment-requests/bootstrap').set('Authorization', `Bearer ${token}`).send({ code: boot.bootstrapCode }).expect(200);
  return { app, prisma, http: () => request(app.getHttpServer()), token, device, recoveryCodes: boot.recoveryCodes, ownerId: boot.ownerId };
}

export function api(ctx: { app: INestApplication; token: string }) {
  const s = () => request(ctx.app.getHttpServer());
  const auth = (r: any) => r.set('Authorization', `Bearer ${ctx.token}`);
  return {
    get: (p: string) => auth(s().get(`/api/v1${p}`)),
    post: (p: string, body?: any, key?: string) => { const r = auth(s().post(`/api/v1${p}`)); if (key) r.set('Idempotency-Key', key); return r.send(body ?? {}); },
    patch: (p: string, body?: any) => auth(s().patch(`/api/v1${p}`)).send(body ?? {}),
    del: (p: string, body?: any) => auth(s().delete(`/api/v1${p}`)).send(body ?? {}),
  };
}

/** Obtient un challenge et le signe avec la clé de l'appareil. */
export async function approve(ctx: Ctx, action: string, params: Record<string, unknown>, device = ctx.device, token = ctx.token) {
  const r = await request(ctx.app.getHttpServer()).post('/api/v1/security/challenges').set('Authorization', `Bearer ${token}`).send({ action, params }).expect(201);
  return device.signChallenge(r.body.data);
}

export async function createAccount(ctx: Ctx, name = 'Compte MTN MoMo', opening = '200000') {
  const r = await api(ctx).post('/accounts', { name, type: 'EXTERNAL_TRACKED', openingBalanceMinor: opening }).expect(201);
  return r.body.data;
}

/** Avance l'horloge serveur puis rouvre une session (le jeton d'accès de 15 min a expiré, comme pour un vrai client). */
export async function advance(ctx: { app: INestApplication; token: string; device: TestDevice }, ms: number) {
  clock.advance(ms);
  const l = await request(ctx.app.getHttpServer()).post('/api/v1/identity/login').send({ email: EMAIL, password: PASSWORD, device: ctx.device.info() }).expect(200);
  ctx.token = l.body.data.accessToken;
}
