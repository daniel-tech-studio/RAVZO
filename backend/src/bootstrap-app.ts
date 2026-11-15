import { BadRequestException, INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, raw } from 'express';
import { AppModule } from './app.module';
import { config } from './common/config';

/** Configuration HTTP commune (API et tests). */
export function configureApp(app: INestApplication) {
  app.setGlobalPrefix('api/v1');
  // Corps brut conservé pour la vérification HMAC des webhooks (backend.md §10.5).
  app.use('/api/v1/integrations/psp/webhooks', raw({ type: '*/*', limit: '256kb' }));
  app.use('/api/v1/documents', raw({ type: 'application/octet-stream', limit: '10mb' }));
  app.use(json({ limit: '1mb' }));
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true, forbidNonWhitelisted: true, transform: true,
    exceptionFactory: (errors) => new BadRequestException(errors.flatMap((e) => flatten(e))),
  }));
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  (app as any).getHttpAdapter().getInstance().disable('x-powered-by');
  (app as any).getHttpAdapter().getInstance().set('trust proxy', process.env.TRUST_PROXY ?? 'loopback');
}
function flatten(e: any, path = ''): string[] {
  const p = path ? `${path}.${e.property}` : e.property;
  const own = e.constraints ? Object.values(e.constraints).map((m) => `${p}: ${m}`) : [];
  return [...own, ...(e.children ?? []).flatMap((c: any) => flatten(c, p))];
}

export async function createApp() {
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  configureApp(app);
  return app;
}

export function setupOpenApi(app: INestApplication) {
  const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('RAVZO API').setVersion('1.0').setDescription('API privée mono-utilisateur — backend.md').addBearerAuth().build());
  SwaggerModule.setup('api/docs', app, doc, { jsonDocumentUrl: 'api/openapi.json' });
  return doc;
}
