import {
  ArgumentsHost, CallHandler, StreamableFile, Catch, ExceptionFilter, ExecutionContext, HttpException, Injectable, Logger,
  NestInterceptor, NestMiddleware,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { map } from 'rxjs';
import { clock } from './clock';
import { DomainError } from './errors';
import { MoneyFormatError } from './money';

/** Sérialise BigInt/Decimal en chaînes exactes, dates en ISO UTC (backend.md §4, §18.1). */
export function toJsonSafe(v: any): any {
  if (v === null || v === undefined) return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toString();
  if (Array.isArray(v)) return v.map(toJsonSafe);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJsonSafe(x);
    return out;
  }
  return v;
}

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void) {
    const h = req.headers['x-correlation-id'];
    req.correlationId = typeof h === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(h) ? h : randomUUID();
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
  }
}

/** Marque une réponse déjà enveloppée (collections paginées). */
export class Paged<T> {
  constructor(public data: T[], public nextCursor: string | null, public hasMore: boolean) {}
}
export class Raw {
  constructor(public body: any) {}
}

@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest();
    return next.handle().pipe(
      map((result) => {
        if (result instanceof StreamableFile) return result;
        if (result instanceof Raw) return Buffer.isBuffer(result.body) ? new StreamableFile(result.body) : result.body;
        const meta: any = { correlationId: req.correlationId, serverTime: clock.now().toISOString() };
        if (result instanceof Paged) {
          return { data: toJsonSafe(result.data), page: { nextCursor: result.nextCursor, hasMore: result.hasMore }, meta };
        }
        if (result && typeof result === 'object' && 'version' in result && typeof result.version === 'number') meta.version = result.version;
        return { data: toJsonSafe(result ?? null), meta };
      }),
    );
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('API');
  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest();
    const res = ctx.getResponse();
    let status = 500;
    let body: any = { code: 'INTERNAL_ERROR', message: 'Erreur interne', details: {}, retryable: true };

    if (exception instanceof DomainError) {
      status = exception.status;
      body = { code: exception.code, message: exception.message, details: toJsonSafe(exception.details), retryable: exception.retryable };
    } else if (exception instanceof MoneyFormatError) {
      status = 400;
      body = { code: 'VALIDATION_FAILED', message: exception.message, details: { field: exception.field }, retryable: false };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r: any = exception.getResponse();
      const code = status === 404 ? 'NOT_FOUND' : status === 401 ? 'AUTH_REQUIRED' : status === 429 ? 'RATE_LIMITED' : status === 403 ? 'FORBIDDEN' : 'VALIDATION_FAILED';
      body = { code, message: typeof r === 'string' ? r : Array.isArray(r?.message) ? 'Requête invalide' : (r?.message ?? 'Erreur'), details: Array.isArray(r?.message) ? { violations: r.message } : {}, retryable: status === 429 };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2002') {
      status = 409;
      body = { code: 'ALREADY_EXISTS', message: 'Ressource déjà existante (contrainte d’unicité)', details: {}, retryable: false };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError && exception.code === 'P2025') {
      status = 404;
      body = { code: 'NOT_FOUND', message: 'Ressource introuvable', details: {}, retryable: false };
    } else {
      // Pas de stack, ni secret, ni détail interne au client (backend.md §18.1)
      this.log.error(JSON.stringify({ correlationId: req.correlationId, path: req.route?.path, error: String(exception?.message ?? exception).slice(0, 500) }));
    }
    if (status === 429) res.setHeader('Retry-After', '30');
    res.status(status).json({ error: body, meta: { correlationId: req.correlationId, serverTime: clock.now().toISOString() } });
  }
}
