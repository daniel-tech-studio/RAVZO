import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** Charge .env (sans dépendance externe) puis expose une configuration typée et validée. */
function loadDotEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    // Un « # » n'ouvre un commentaire que s'il est précédé d'un espace (les secrets peuvent contenir « # »).
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)(\s+#.*)?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
loadDotEnv();

function optInt(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  if (!/^\d+$/.test(v.trim())) throw new Error(`Entier attendu, reçu « ${v} »`);
  return Number(v.trim());
}

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Configuration manquante : ${name}`);
  return v;
}

export const config = {
  appEnv: process.env.APP_ENV ?? 'local',
  port: Number(process.env.PORT ?? 3000),
  corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
  paymentsLiveEnabled: process.env.PAYMENTS_LIVE_ENABLED === 'true',
  pspProvider: process.env.PSP_PROVIDER ?? 'none',
  marketProvider: process.env.MARKET_PROVIDER ?? 'manual',
  mansa: { base: process.env.MANSA_API_BASE ?? 'https://mansaapi.com/api/v1', key: process.env.MANSA_API_KEY ?? '', dailyQuota: Number(process.env.MANSA_DAILY_QUOTA ?? 100) },
  smtp: { host: process.env.SMTP_HOST ?? '', port: Number(process.env.SMTP_PORT ?? 465), user: process.env.SMTP_USER ?? '', password: process.env.SMTP_PASSWORD ?? '', fromName: process.env.SMTP_FROM_NAME ?? 'RAVZO', fromAddress: process.env.SMTP_FROM_ADDRESS ?? '' },
  feexpay: {
    base: process.env.FEEXPAY_API_BASE ?? 'https://api-v2.feexpay.me',
    apiKey: process.env.FEEXPAY_API_KEY ?? '',
    shopId: process.env.FEEXPAY_SHOP_ID ?? '',
    webhookSecret: process.env.FEEXPAY_WEBHOOK_SECRET ?? '',
    payoutFeeBp: optInt(process.env.FEEXPAY_PAYOUT_FEE_BP),
    payoutFeeMinMinor: BigInt(optInt(process.env.FEEXPAY_PAYOUT_FEE_MIN) ?? 0),
    payinFeeBp: optInt(process.env.FEEXPAY_PAYIN_FEE_BP),
    timeoutMs: Number(process.env.FEEXPAY_TIMEOUT_MS ?? 30_000),
  },
  fcm: { projectId: process.env.FCM_PROJECT_ID ?? '', serviceAccountFile: process.env.FCM_SERVICE_ACCOUNT_FILE ?? '' },
  storageDir: process.env.STORAGE_DIR ?? './storage',
  notificationChannels: (process.env.NOTIFICATION_CHANNELS ?? '').split(',').filter(Boolean),
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:56390',
  dbPrimaryUrl: req('DB_PRIMARY_URL'),
  dbReadUrl: process.env.DB_READ_URL || undefined,
  tokenSecret: req('TOKEN_SECRET'),
  cursorSecret: req('CURSOR_SECRET'),
  documentMasterKey: process.env.DOCUMENT_MASTER_KEY ?? '',
  webhookVerifySecret: process.env.WEBHOOK_VERIFY_SECRET ?? '',
  sseRetentionDays: Number(process.env.SSE_RETENTION_WINDOW_DAYS ?? 30),
  accessTokenTtlSec: 15 * 60,
  refreshTokenTtlSec: 30 * 24 * 3600,
};

if (config.tokenSecret.length < 32) throw new Error('TOKEN_SECRET doit contenir au moins 32 caractères');
if (config.appEnv === 'production' && config.pspProvider === 'fake') {
  throw new Error('Le FakeProvider est interdit en production (backend.md §29)');
}
