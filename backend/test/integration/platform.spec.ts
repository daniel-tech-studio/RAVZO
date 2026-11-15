import { createHash } from 'crypto';
import request from 'supertest';
import { clock } from '../../src/common/clock';
import { digestOf } from '../../src/common/crypto';
import { OutboxConsumers } from '../../src/worker/outbox';
import { api, createAccount, createTestApp, Ctx, idemKey, setupOwner } from '../helpers';

describe('Sync, imports, documents, opérations, exports', () => {
  let ctx: Ctx;
  let base: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => { base = await createTestApp(); });
  afterAll(async () => { await base.app.close(); });
  beforeEach(async () => { ctx = await setupOwner(base.app, base.prisma); });
  afterEach(() => clock.reset());

  async function upload(content: string | Buffer, mime: string, name = 'f.csv') {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const req = (await api(ctx).post('/documents/upload-requests', { originalName: name, mimeDeclared: mime, sizeBytes: buf.length }).expect(201)).body.data;
    const put = await request(ctx.app.getHttpServer()).put(`/api/v1/documents/${req.documentId}/content`).set('Authorization', `Bearer ${ctx.token}`).set('X-Upload-Token', req.uploadToken).set('Content-Type', 'application/octet-stream').send(buf);
    if (put.status !== 200) return { id: req.documentId, put };
    await api(ctx).post(`/documents/${req.documentId}/complete`, { sha256: createHash('sha256').update(buf).digest('hex') }).expect(201);
    return { id: req.documentId, put };
  }

  it('T17 — cinq brouillons hors ligne ; deux confirmés individuellement → deux mutations, trois en attente', async () => {
    const acc = await createAccount(ctx);
    const drafts = Array.from({ length: 5 }, (_, i) => ({ clientDraftId: `draft-${i}`, targetResource: 'EXPENSE', operation: 'CREATE', payload: { accountId: acc.id, amountMinor: String(1000 * (i + 1)), label: `Achat ${i}` } }));
    const prepared = (await api(ctx).post('/sync/drafts/prepare', { drafts }).expect(201)).body.data;
    expect(prepared.every((d: any) => d.state === 'REVIEW_REQUIRED')).toBe(true);
    expect(await ctx.prisma.expense.count()).toBe(0); // rien appliqué
    for (const d of prepared.slice(0, 2)) await api(ctx).post(`/sync/drafts/${d.id}/confirm`, { payloadHash: d.canonicalPayloadHash }).expect(201);
    await api(ctx).post(`/sync/drafts/${prepared[0].id}/confirm`, { payloadHash: prepared[0].canonicalPayloadHash }).expect(201); // rejeu sans effet
    expect(await ctx.prisma.expense.count()).toBe(2);
    expect((await api(ctx).get('/sync/drafts')).body.data).toHaveLength(3);
    // Confirmation d'un contenu différent de celui présenté : refus
    expect((await api(ctx).post(`/sync/drafts/${prepared[2].id}/confirm`, { payloadHash: digestOf({ x: 1 }) }).expect(409)).body.error.code).toBe('SYNC_CONFIRMATION_REQUIRED');
    // Paiement hors ligne refusé dès la préparation
    const pay = (await api(ctx).post('/sync/drafts/prepare', { drafts: [{ clientDraftId: 'pay-1', targetResource: 'PAYOUT', operation: 'CREATE', payload: {} }] })).body.data[0];
    expect(pay.state).toBe('REJECTED');
    const ops = (await api(ctx).get('/operations')).body.data;
    expect(ops.items.filter((i: any) => i.kind === 'OFFLINE_DRAFT')).toHaveLength(3);
  });

  it('conflit de version : les deux versions sont présentées, aucune écrasée', async () => {
    await createAccount(ctx);
    const g = (await api(ctx).post('/savings/goals', { name: 'Voyage', targetMinor: '100000', deadline: '2027-06-30', plan: { triggerType: 'CALENDAR', amountRule: 'FIXED:10000', scheduleRule: 'MONTHLY:1' } }).expect(201)).body.data;
    const prep = await api(ctx).post('/sync/drafts/prepare', { drafts: [{ clientDraftId: 'goal-1', targetResource: 'SAVINGS_GOAL_META', operation: 'UPDATE', targetId: g.id, baseVersion: g.version, payload: { name: 'Voyage Dakar' } }] });
    if (prep.status !== 201) console.log(JSON.stringify(prep.body));
    const [d] = prep.body.data;
    await api(ctx).patch(`/savings/goals/${g.id}`, { name: 'Voyage Lomé' }).expect(200);
    const c = await api(ctx).post(`/sync/drafts/${d.id}/confirm`, { payloadHash: d.canonicalPayloadHash }).expect(409);
    expect(c.body.error.code).toBe('SYNC_CONFLICT');
    expect(c.body.error.details.server.name).toBe('Voyage Lomé');
    expect((await api(ctx).get(`/savings/goals/${g.id}`)).body.data.name).toBe('Voyage Lomé');
    await api(ctx).post(`/sync/drafts/${d.id}/confirm`, { payloadHash: d.canonicalPayloadHash, resolution: 'APPLY_ON_LATEST' }).expect(201);
    expect((await api(ctx).get(`/savings/goals/${g.id}`)).body.data.name).toBe('Voyage Dakar');
  });

  it('T18 — reprise par curseur après coupure : deltas complets et ordonnés', async () => {
    const acc = await createAccount(ctx);
    const c0 = (await api(ctx).get('/sync/changes')).body.data.nextCursor;
    for (let i = 0; i < 3; i++) await api(ctx).post('/expenses', { accountId: acc.id, amountMinor: '500', label: `x${i}` }, idemKey()).expect(201);
    const d = (await api(ctx).get(`/sync/changes?cursor=${c0}`)).body.data;
    expect(d.resyncRequired).toBe(false);
    expect(d.events.filter((e: any) => e.resourceType === 'Expense')).toHaveLength(3);
    const seqs = d.events.map((e: any) => BigInt(e.sequence));
    expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
    expect((await api(ctx).get(`/sync/changes?cursor=${d.nextCursor}`)).body.data.events).toHaveLength(0);
  });

  it('T22 — même événement outbox traité par deux workers : livraisons dédupliquées par canal', async () => {
    const cy = (await api(ctx).post('/budget-cycles', { durationDays: 30 }).expect(201)).body.data;
    await api(ctx).post(`/budget-cycles/${cy.id}/close`).expect(201);
    const ev = await ctx.prisma.outboxEvent.findFirstOrThrow({ where: { eventType: 'notification.created' } });
    const consumers = new OutboxConsumers(ctx.prisma);
    const results = await Promise.all([consumers.handle(ev as any), consumers.handle(ev as any), consumers.handle(ev as any)]);
    expect(results).toHaveLength(3);
    const ds = await ctx.prisma.notificationDelivery.findMany({ where: { notificationId: ev.aggregateId } });
    expect(ds).toHaveLength(2);
    expect(ds.every((d) => d.attempts === 1 && d.status === 'NOT_CONFIGURED')).toBe(true);
    expect(await ctx.prisma.processedEvent.count({ where: { eventId: ev.id } })).toBe(1);
  });

  it('documents : MIME usurpé refusé ; accès temporaire à usage unique', async () => {
    const fake = await upload('%PDF-1.4 pas vraiment', 'image/png', 'x.png');
    expect(fake.put.status).toBe(400);
    const ok = await upload('date;libelle;montant;reference\n', 'text/csv');
    const g = (await api(ctx).get(`/documents/${ok.id}/access`).expect(200)).body.data;
    await request(ctx.app.getHttpServer()).get(g.accessPath).expect(200);
    await request(ctx.app.getHttpServer()).get(g.accessPath).expect(403);
  });

  it('T14 — import d’un relevé et d’avis d’opéré deux fois : un seul effet comptable', async () => {
    const acc = await createAccount(ctx, 'Banque', '100000');
    const csv = 'date;libelle;montant;reference\n10/11/2026;Pharmacie du marché;-4 500;TX-1\n11/11/2026;Virement salaire;250000;TX-2\n12/11/2026;=cmd|calc;abc;TX-3\n';
    const d1 = await upload(csv, 'text/csv');
    const b1 = (await api(ctx).post('/imports', { documentId: d1.id, sourceType: 'BANK_CSV', targetAccountId: acc.id }).expect(201)).body.data;
    expect(b1.summary).toEqual({ NEW: 2, INVALID: 1 });
    await api(ctx).post(`/imports/${b1.id}/confirm`, { decisions: [1, 2, 3].map((n) => ({ rowNumber: n, decision: 'COMMIT' })) }).expect(201);
    await api(ctx).post(`/imports/${b1.id}/confirm`, { decisions: [1, 2, 3].map((n) => ({ rowNumber: n, decision: 'COMMIT' })) }).expect(201);
    expect(await ctx.prisma.expense.count({ where: { source: 'IMPORT' } })).toBe(1);
    const d2 = await upload(csv, 'text/csv');
    const b2 = (await api(ctx).post('/imports', { documentId: d2.id, sourceType: 'BANK_CSV', targetAccountId: acc.id }).expect(201)).body.data;
    expect(b2.summary.MATCHED).toBe(2);
    await api(ctx).post(`/imports/${b2.id}/confirm`, { decisions: [1, 2].map((n) => ({ rowNumber: n, decision: 'COMMIT' })) }).expect(201);
    expect(await ctx.prisma.expense.count({ where: { source: 'IMPORT' } })).toBe(1);
    expect(await ctx.prisma.income.count()).toBe(1);
    // Avis d'opéré SGI
    const br = (await api(ctx).post('/investments/brokers', { name: 'SGI', accountAlias: 'CT', openingCashMinor: '500000' }).expect(201)).body.data;
    const tcsv = 'date;sens;symbole;quantite;prix;frais;taxes;reference\n2026-11-05;ACHAT;SNTS;10;19500;1000;0;AVIS-77\n';
    for (let k = 0; k < 2; k++) {
      const d = await upload(tcsv, 'text/csv', `avis${k}.csv`);
      const b = (await api(ctx).post('/imports', { documentId: d.id, sourceType: 'SGI_TRADES_CSV', targetAccountId: br.brokerageAccount.id }).expect(201)).body.data;
      await api(ctx).post(`/imports/${b.id}/confirm`, { decisions: [{ rowNumber: 1, decision: 'COMMIT' }] }).expect(201);
    }
    expect(await ctx.prisma.trade.count()).toBe(1);
    expect(await ctx.prisma.ledgerTransaction.count({ where: { businessType: 'TRADE' } })).toBe(1);
  });

  it('exports CSV/PDF avec provenance, masquage et audit ; recherche globale ; analyses', async () => {
    const acc = await createAccount(ctx, 'Wave', '50000');
    await api(ctx).post('/expenses', { accountId: acc.id, amountMinor: '3500', label: 'Taxi Gozem' }, idemKey()).expect(201);
    const csv = await api(ctx).get('/activity/export?format=csv').expect(200);
    expect(csv.text).toMatch(/confidentiel/);
    expect(csv.text).toMatch(/Taxi Gozem/);
    expect(csv.text).toMatch(/-3500/);
    const masked = await api(ctx).get('/activity/export?format=csv&masked=true').expect(200);
    expect(masked.text).not.toMatch(/-3500/);
    const pdf = await api(ctx).get('/activity/export?format=pdf').buffer(true).parse((res: any, cb: any) => { const ch: Buffer[] = []; res.on('data', (c: Buffer) => ch.push(c)); res.on('end', () => cb(null, Buffer.concat(ch))); }).expect(200);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'EXPORT_GENERATED' } })).toBe(3);
    const s = (await api(ctx).get('/search?q=gozem').expect(200)).body.data;
    expect(s.results[0].type).toBe('EXPENSE');
    const s2 = (await api(ctx).get('/search?q=3500').expect(200)).body.data;
    expect(s2.results.some((r: any) => r.type === 'EXPENSE')).toBe(true);
    const an = (await api(ctx).get('/analytics/finance').expect(200)).body.data;
    expect(an.byCategory[0].name).toBe('Transport');
    const act = (await api(ctx).get('/activity?limit=1').expect(200)).body.data;
    expect(act.hasMore).toBe(true);
    const act2 = (await api(ctx).get(`/activity?limit=1&cursor=${encodeURIComponent(act.nextCursor)}`).expect(200)).body.data;
    expect(act2.items[0].id).not.toBe(act.items[0].id);
  });
});
