import 'reflect-metadata';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { CORE_PROVIDERS } from './app.module';
import { config } from './common/config';
import { PrismaService } from './common/prisma.service';
import { ScheduledJobs } from './worker/jobs';
import { claimOutbox, OutboxConsumers } from './worker/outbox';

@Module({ providers: [...CORE_PROVIDERS, OutboxConsumers, ScheduledJobs] })
class WorkerModule {}

/** Processus worker isolé (B02, B30) : relais outbox → BullMQ, consommateurs idempotents, planification. Redis n'est jamais l'autorité comptable. */
async function main() {
  const log = new Logger('Worker');
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn', 'log'] });
  const prisma = app.get(PrismaService);
  const consumers = app.get(OutboxConsumers);
  const jobs = app.get(ScheduledJobs);
  const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  const outboxQ = new Queue('ravzo-outbox', { connection });
  const jobsQ = new Queue('ravzo-jobs', { connection });

  jobs.schedule['notifications.retry-failed'] = { everyMs: 5 * 60_000, run: () => consumers.retryFailed() };
  for (const [name, j] of Object.entries(jobs.schedule)) await jobsQ.upsertJobScheduler(name, { every: j.everyMs }, { name, opts: { removeOnComplete: 100, removeOnFail: 500 } });

  new Worker('ravzo-outbox', async (job) => consumers.handle(job.data), { connection, concurrency: 4 })
    .on('failed', (job, err) => log.error(JSON.stringify({ queue: 'outbox', jobId: job?.id, attempts: job?.attemptsMade, error: err.message.slice(0, 200) })));
  new Worker('ravzo-jobs', async (job) => jobs.run(job.name), { connection, concurrency: 1 });

  let stopping = false;
  const relay = async () => {
    while (!stopping) {
      try {
        const evs = await claimOutbox(prisma);
        for (const e of evs) {
          await outboxQ.add(e.eventType, { id: e.id, eventType: e.eventType, aggregateId: e.aggregateId, ownerId: e.ownerId }, { jobId: e.id, attempts: 8, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: false });
          await prisma.outboxEvent.update({ where: { id: e.id }, data: { publishedAt: new Date() } });
        }
        if (!evs.length) await new Promise((r) => setTimeout(r, 1000));
      } catch (e: any) {
        log.error(JSON.stringify({ relay: 'error', error: String(e?.message).slice(0, 200) })); // Redis indisponible : l'outbox conserve tout
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  relay();
  log.log(JSON.stringify({ service: 'ravzo-worker', event: 'started', jobs: Object.keys(jobs.schedule).length }));
  const shutdown = async () => { stopping = true; await outboxQ.close(); await jobsQ.close(); await connection.quit(); await app.close(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main();
