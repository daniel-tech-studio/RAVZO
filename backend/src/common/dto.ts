import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';

export class ApprovalDto {
  @IsString() @MaxLength(64) challengeId: string;
  @IsString() @MaxLength(300) signature: string;
}
export class WithApproval {
  @IsOptional() @ValidateNested() @Type(() => ApprovalDto) approval?: ApprovalDto;
}
export const MINOR_RE = /^\d{1,15}$/;
export const SIGNED_MINOR_RE = /^-?\d{1,15}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const AmountMinor = () => Matches(MINOR_RE, { message: 'montant en unités mineures (chaîne entière) attendu' });
export const DateOnly = () => Matches(DATE_RE, { message: 'date AAAA-MM-JJ attendue' });
export class VersionedDto {
  @IsOptional() @IsInt() @Min(1) expectedVersion?: number;
}
export function stripApproval<T extends { approval?: unknown }>(dto: T): Omit<T, 'approval'> {
  const { approval, ...rest } = dto;
  return rest;
}
