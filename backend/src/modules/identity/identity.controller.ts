import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateNested, IsEmail, IsInt } from 'class-validator';
import { AllowPendingDevice, Auth, AuthContext, Public, RequireTrustedDevice } from '../../common/auth';
import { WithApproval } from '../../common/dto';
import { DomainError } from '../../common/errors';
import { Paged } from '../../common/http';
import { decodeCursor, encodeCursor, pageSize } from '../../common/pagination';
import { PrismaService } from '../../common/prisma.service';
import { IdentityService } from './identity.service';
import { StepUpService } from './step-up.service';

class DeviceInfo {
  @IsString() @MaxLength(200) publicKey: string;
  @IsString() @MaxLength(80) name: string;
  @IsIn(['macos', 'ios', 'android', 'test']) platform: string;
}
class LoginDto {
  @IsEmail() @MaxLength(200) email: string;
  @IsString() @MinLength(1) @MaxLength(200) password: string;
  @ValidateNested() @Type(() => DeviceInfo) device: DeviceInfo;
}
class RefreshDto { @IsString() @MaxLength(100) refreshToken: string }
class BootstrapEnrollDto { @IsString() @MaxLength(20) code: string }
class ApproveEnrollDto extends WithApproval { @IsString() @MaxLength(10) code: string }
class RecoveryStartDto { @IsEmail() email: string }
class RecoveryVerifyDto {
  @IsString() recoveryId: string;
  @IsString() @MaxLength(100) challenge: string;
  @IsString() @MaxLength(30) recoveryCode: string;
  @IsOptional() @IsString() @MinLength(12) @MaxLength(200) newPassword?: string;
  @ValidateNested() @Type(() => DeviceInfo) device: DeviceInfo;
}
const STEP_UP_ACTIONS = ['device.revoke', 'device.approve', 'session.revoke', 'recovery.regenerate', 'ledger.correction', 'limits.change', 'exception.request', 'exception.cancel', 'savings.withdrawal.request', 'savings.withdrawal.confirm', 'reconciliation.resolve', 'payment.cancel', 'export.sensitive'];
class ChallengeDto {
  @IsIn(STEP_UP_ACTIONS) action: string;
  @IsObject() params: Record<string, unknown>;
}
class PrefsDto { @IsObject() preferences: Record<string, unknown>; @IsOptional() @IsInt() expectedVersion?: number }

@Controller()
export class IdentityController {
  constructor(private id: IdentityService, private stepUp: StepUpService, private prisma: PrismaService) {}

  @Public() @Throttle({ default: { limit: 10, ttl: 60_000 } }) @Post('identity/login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Req() req: any) { return this.id.login(dto, { ip: req.ip, ua: req.headers['user-agent'] }); }

  @Public() @Throttle({ default: { limit: 30, ttl: 60_000 } }) @Post('identity/refresh') @HttpCode(200)
  refresh(@Body() dto: RefreshDto) { return this.id.refresh(dto.refreshToken); }

  @AllowPendingDevice() @Post('identity/logout') @HttpCode(204)
  async logout(@Auth() a: AuthContext) { await this.id.logout(a); }

  @AllowPendingDevice() @Get('identity/me')
  me(@Auth() a: AuthContext) { return this.id.me(a); }

  @Patch('identity/preferences')
  prefs(@Auth() a: AuthContext, @Body() dto: PrefsDto) { return this.id.updatePreferences(a, dto.preferences, dto.expectedVersion); }

  // ─── Step-up générique ───
  @RequireTrustedDevice() @Post('security/challenges')
  challenge(@Auth() a: AuthContext, @Body() dto: ChallengeDto) { return this.stepUp.createChallenge(a, dto.action, dto.params); }

  // ─── Appareils ───
  @Get('devices') devices(@Auth() a: AuthContext) { return this.id.listDevices(a); }

  @AllowPendingDevice() @Post('devices/enrollment-requests')
  enroll(@Auth() a: AuthContext) { return this.id.createEnrollmentRequest(a); }

  @AllowPendingDevice() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('devices/enrollment-requests/bootstrap') @HttpCode(200)
  bootstrap(@Auth() a: AuthContext, @Body() dto: BootstrapEnrollDto) { return this.id.bootstrapEnroll(a, dto.code); }

  @Get('devices/enrollment-requests') pending(@Auth() a: AuthContext) { return this.id.pendingEnrollments(a); }

  @RequireTrustedDevice() @Post('devices/enrollment-requests/:id/approve') @HttpCode(200)
  approve(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApproveEnrollDto) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'device.approve', { requestId: id });
      return this.id.approveEnrollment(tx, a, id, dto.code);
    });
  }

  @RequireTrustedDevice() @Post('devices/:id/revoke') @HttpCode(200)
  revoke(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithApproval) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'device.revoke', { deviceId: id });
      return this.id.revokeDevice(tx, a, id);
    });
  }

  @Get('sessions') sessions(@Auth() a: AuthContext) { return this.id.listSessions(a); }

  @RequireTrustedDevice() @Delete('sessions/:id') @HttpCode(204)
  async revokeSession(@Auth() a: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithApproval) {
    await this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto?.approval, 'session.revoke', { sessionId: id });
      await this.id.revokeSession(tx, a, id);
    });
  }

  // ─── Récupération ───
  @Public() @Throttle({ default: { limit: 3, ttl: 60_000 } }) @Post('recovery/start') @HttpCode(200)
  recoveryStart(@Body() dto: RecoveryStartDto) { return this.id.startRecovery(dto.email); }

  @Public() @Throttle({ default: { limit: 5, ttl: 60_000 } }) @Post('recovery/verify') @HttpCode(200)
  recoveryVerify(@Body() dto: RecoveryVerifyDto) { return this.id.verifyRecovery(dto); }

  @RequireTrustedDevice() @Post('recovery/codes/regenerate') @HttpCode(200)
  regen(@Auth() a: AuthContext, @Body() dto: WithApproval) {
    return this.prisma.tx(async (tx) => {
      await this.stepUp.verifyAndConsume(tx, a, dto.approval, 'recovery.regenerate', {});
      return this.id.regenerateRecoveryCodes(tx, a);
    });
  }

  @AllowPendingDevice() @Get('security/status') status(@Auth() a: AuthContext) { return this.id.securityStatus(a); }

  @Get('security/events')
  async securityEvents(@Auth() a: AuthContext, @Query('cursor') cursor?: string, @Query('limit') limit?: string, @Query('type') type?: string) {
    const take = pageSize(limit);
    const c = decodeCursor(cursor);
    const rows = await this.prisma.securityEvent.findMany({
      where: { ownerId: a.ownerId, ...(type ? { type } : {}), ...(c ? { OR: [{ at: { lt: new Date(c.at) } }, { at: new Date(c.at), id: { lt: c.id } }] } : {}) },
      orderBy: [{ at: 'desc' }, { id: 'desc' }], take: take + 1,
    });
    const more = rows.length > take;
    const page = rows.slice(0, take).map(({ ipMetadata, evidenceHash, ...r }) => r);
    return new Paged(page, more ? encodeCursor({ at: page[page.length - 1].at.toISOString(), id: page[page.length - 1].id }) : null, more);
  }

  @Get('audit/events')
  async audit(@Auth() a: AuthContext, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const take = pageSize(limit);
    const c = decodeCursor(cursor);
    const rows = await this.prisma.auditEvent.findMany({
      where: { ownerId: a.ownerId, ...(c ? { OR: [{ at: { lt: new Date(c.at) } }, { at: new Date(c.at), id: { lt: c.id } }] } : {}) },
      orderBy: [{ at: 'desc' }, { id: 'desc' }], take: take + 1,
    });
    const more = rows.length > take;
    const page = rows.slice(0, take);
    return new Paged(page, more ? encodeCursor({ at: page[page.length - 1].at.toISOString(), id: page[page.length - 1].id }) : null, more);
  }
}
