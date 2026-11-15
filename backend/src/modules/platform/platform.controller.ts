import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Auth, AuthContext, FinancialMutation, Public, RequireTrustedDevice } from '../../common/auth';
import { clock } from '../../common/clock';
import { DomainError } from '../../common/errors';
import { EventsService } from '../../common/events.service';
import { Raw } from '../../common/http';
import { PrismaService } from '../../common/prisma.service';
import { FcmPushService } from './fcm-push.service';
import { DocumentsService } from './documents.service';
import { ImportsService } from './imports.service';
import { InsightsService } from './insights.service';
import { SyncService } from './sync.service';

class DraftDto { @IsString() @Length(4, 80) clientDraftId: string; @IsString() @MaxLength(40) targetResource: string; @IsIn(['CREATE', 'UPDATE']) operation: string; @IsOptional() @IsUUID() targetId?: string; @IsOptional() @IsInt() baseVersion?: number; @IsObject() payload: Record<string, any> }
class PrepareDto { @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => DraftDto) drafts: DraftDto[] }
class ConfirmDraftDto { @IsString() @Length(64, 64) payloadHash: string; @IsOptional() @IsIn(['APPLY_ON_LATEST']) resolution?: 'APPLY_ON_LATEST' }
class UploadReqDto { @IsString() @Length(1, 200) originalName: string; @IsIn(['application/pdf', 'image/png', 'image/jpeg', 'text/csv']) mimeDeclared: string; @IsInt() @Min(1) @Max(10 * 1024 * 1024) sizeBytes: number; @IsOptional() @IsString() @MaxLength(80) linkedResource?: string }
class CompleteDto { @Matches(/^[a-fA-F0-9]{64}$/) sha256: string }
class ImportDto { @IsUUID() documentId: string; @IsIn(['BANK_CSV', 'SGI_TRADES_CSV']) sourceType: any; @IsUUID() targetAccountId: string }
class DecisionDto { @IsInt() @Min(1) rowNumber: number; @IsIn(['COMMIT', 'SKIP']) decision: any; @IsOptional() @IsUUID() categoryId?: string }
class ImportConfirmDto { @IsArray() @ArrayMaxSize(5000) @ValidateNested({ each: true }) @Type(() => DecisionDto) decisions: DecisionDto[] }
class PushDeviceDto { @IsString() @Length(20, 4096) token: string; @IsIn(['android', 'ios', 'macos']) platform: string }
class NotifPrefsDto { @IsArray() @IsIn(['BUDGET', 'SAVINGS', 'MARKET', 'LIABILITY', 'SYSTEM'], { each: true }) mutedCategories: string[]; @IsOptional() @IsBoolean() hideAmountsOnLockScreen?: boolean }

@Controller()
export class PlatformController {
  constructor(private prisma: PrismaService, private sync: SyncService, private insights: InsightsService, private docs: DocumentsService, private imports: ImportsService, private events: EventsService, private push: FcmPushService) {}

  /** Inscription du jeton FCM de cet appareil de confiance. */
  @RequireTrustedDevice() @Post('notifications/push-devices') async pushRegister(@Auth() a: AuthContext, @Body() dto: PushDeviceDto) {
    const r = await this.push.register(a, dto.token, dto.platform);
    await this.prisma.tx((tx) => this.events.security(tx, { ownerId: a.ownerId, actorDeviceId: a.deviceId, type: 'PUSH_DEVICE_REGISTERED', decision: 'ALLOWED' }));
    return r;
  }
  @Delete('notifications/push-devices/current') pushUnregister(@Auth() a: AuthContext) { return this.push.unregister(a); }

  @Get('sync/changes') changes(@Auth() a: AuthContext, @Query('cursor') cursor?: string) { return this.sync.changes(a, cursor); }
  @Post('sync/drafts/prepare') prepare(@Auth() a: AuthContext, @Body() dto: PrepareDto) { return this.sync.prepare(a, dto.drafts); }
  @Get('sync/drafts') drafts(@Auth() a: AuthContext) { return this.sync.list(a); }
  @Get('sync/drafts/:id') draft(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sync.diff(a, id); }
  @FinancialMutation() @Post('sync/drafts/:id/confirm') confirmDraft(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ConfirmDraftDto) { return this.sync.confirm(a, id, dto); }
  @Post('sync/drafts/:id/discard') discard(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.sync.discard(a, id); }

  @Get('notifications') notifications(@Auth() a: AuthContext, @Query('unreadOnly') u?: string, @Query('category') c?: string) { return this.insights.notifications(a, { unreadOnly: u === 'true', category: c }); }
  @Post('notifications/:id/read') read(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.insights.markRead(a, id); }
  @Post('notifications/read-all') readAll(@Auth() a: AuthContext) { return this.insights.markAllRead(a); }
  @Post('notifications/preferences') async prefs(@Auth() a: AuthContext, @Body() dto: NotifPrefsDto) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: a.ownerId } });
    const p = { ...(u.preferences as any), notifications: { mutedCategories: dto.mutedCategories, hideAmountsOnLockScreen: dto.hideAmountsOnLockScreen ?? true } };
    return (await this.prisma.user.update({ where: { id: a.ownerId }, data: { preferences: p, version: { increment: 1 } } })).preferences;
  }

  @Get('operations') ops(@Auth() a: AuthContext) { return this.insights.operations(a); }
  @Get('activity') activity(@Auth() a: AuthContext, @Query() q: any) { return this.insights.activity(a, q); }
  @Get('search') search(@Auth() a: AuthContext, @Query('q') q = '') { return this.insights.search(a, q); }
  @Get('analytics/finance') analytics(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) { return this.insights.analytics(a, { from, to }); }

  @Get('activity/export') async exportActivity(@Auth() a: AuthContext, @Query() q: any, @Res({ passthrough: true }) res: any) {
    const format = q.format === 'pdf' ? 'pdf' : 'csv';
    const masked = q.masked === 'true';
    const { format: _f, masked: _m, ...filters } = q;
    const rows = await this.insights.exportRows(a, filters);
    await this.prisma.tx((tx) => this.events.audit(tx, { ownerId: a.ownerId, actorId: a.deviceId, action: 'EXPORT_GENERATED', context: { format, rows: rows.length, masked } }));
    const stamp = clock.now().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="ravzo-historique-${stamp}.${format}"`);
    res.setHeader('Cache-Control', 'no-store');
    if (format === 'pdf') { res.setHeader('Content-Type', 'application/pdf'); return new Raw(this.insights.toPdf(rows, masked)); }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return new Raw(this.insights.toCsv(rows, masked));
  }

  @Post('documents/upload-requests') uploadReq(@Auth() a: AuthContext, @Body() dto: UploadReqDto) { return this.docs.requestUpload(a, dto); }
  @Put('documents/:id/content') async upload(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Headers('x-upload-token') token: string, @Req() req: any) {
    if (!Buffer.isBuffer(req.body)) throw new DomainError('VALIDATION_FAILED', 'Contenu binaire attendu (application/octet-stream)');
    return this.docs.upload(a, id, token ?? '', req.body);
  }
  @Post('documents/:id/complete') complete(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CompleteDto) { return this.docs.complete(a, id, dto.sha256); }
  @Get('documents/:id/access') access(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.docs.grantAccess(a, id); }
  @Delete('documents/:id') remove(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.docs.remove(a, id); }
  @Public() @Get('documents/access/:token') async download(@Param('token') token: string, @Res({ passthrough: true }) res: any) {
    const { doc, content } = await this.docs.consumeAccess(token);
    res.setHeader('Content-Type', doc.mimeDetected);
    res.setHeader('Content-Disposition', `attachment; filename="${doc.originalName}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new Raw(content);
  }

  @Get('imports') importsList(@Auth() a: AuthContext) { return this.imports.list(a); }
  @FinancialMutation() @Post('imports') createImport(@Auth() a: AuthContext, @Body() dto: ImportDto) { return this.imports.create(a, dto); }
  @Get('imports/:id') getImport(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.imports.get(a, id); }
  @Get('imports/:id/rows') rows(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string) { return this.imports.rows(a, id); }
  @FinancialMutation() @Post('imports/:id/confirm') confirmImport(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportConfirmDto) { return this.imports.confirm(a, id, dto.decisions); }
}
