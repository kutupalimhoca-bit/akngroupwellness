import type { CommissionLogRecord, MemberRegion, MonolineMember } from '../src/types/monoline';
import {
  getRegionPendingKey,
  getRegionWalletKey,
  resolveMemberRegion,
} from '../src/utils/walletRegion';

export type CommissionWalletType =
  | 'SPONSOR'
  | 'MONOLINE_DEPTH'
  | 'CAREER_POOL'
  | 'UNILEVEL_INFINITY'
  | 'MATCHING_BONUS'
  | 'FAST_ROI_BONUS';

export type BonusIdempotency = { key: string; orderId: string };

export type BonusLedger = {
  claimedKeys: Set<string>;
  onDuplicateSkip: (entry: Omit<CommissionLogRecord, 'id'>) => void;
};

export function roundCurrency(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

export function toUsdForRegion(baseAmount: number, _region: MemberRegion): number {
  return roundCurrency(baseAmount);
}

export function adjustCommissionCounters(
  member: Pick<MonolineMember, 'wallets'>,
  walletType: CommissionWalletType,
  delta: number
) {
  const wallets = member.wallets;
  const bump = (current: number | undefined, change: number) =>
    Math.max(0, Math.round(((current || 0) + change + Number.EPSILON) * 100) / 100);
  if (walletType === 'SPONSOR') {
    wallets.sponsor_wallet = bump(wallets.sponsor_wallet, delta);
  } else if (walletType === 'FAST_ROI_BONUS') {
    wallets.sponsor_wallet = bump(wallets.sponsor_wallet, delta);
    wallets.fast_roi_wallet = bump(wallets.fast_roi_wallet, delta);
  } else if (walletType === 'MONOLINE_DEPTH') {
    wallets.monoline_wallet = bump(wallets.monoline_wallet, delta);
  } else if (walletType === 'UNILEVEL_INFINITY') {
    wallets.infinity_wallet = bump(wallets.infinity_wallet, delta);
    wallets.monoline_wallet = bump(wallets.monoline_wallet, delta);
  } else if (walletType === 'MATCHING_BONUS') {
    wallets.matching_wallet = bump(wallets.matching_wallet, delta);
    wallets.career_pool_wallet = bump(wallets.career_pool_wallet, delta);
  } else {
    wallets.career_pool_wallet = bump(wallets.career_pool_wallet, delta);
  }
}

export function claimBonusCredit(claimedKeys: Set<string>, key: string): boolean {
  if (claimedKeys.has(key)) return false;
  claimedKeys.add(key);
  return true;
}

function buildDuplicateSkipEntry(
  member: MonolineMember,
  walletType: CommissionWalletType,
  attemptedAmount: number,
  idem: BonusIdempotency
): Omit<CommissionLogRecord, 'id'> {
  return {
    order_id: idem.orderId,
    source_user_id: member.id,
    source_external_id: member.user_id,
    source_user_name: member.full_name,
    target_user_id: member.id,
    target_external_id: member.user_id,
    target_user_name: member.full_name,
    type: walletType === 'CAREER_POOL' ? 'SYSTEM_POOL' : walletType,
    commission_type: walletType,
    depth_level: null,
    amount: attemptedAmount,
    region: resolveMemberRegion(member.country_code),
    status: 'DUPLICATE_SKIPPED',
    clawback_status: undefined,
    release_at: null,
    transfer_reason_code: null,
    created_at: new Date().toISOString(),
  };
}

export function creditMemberWallet(
  ledger: BonusLedger,
  member: MonolineMember,
  walletType: CommissionWalletType,
  amount: number,
  usePendingClawback = false,
  region: MemberRegion = resolveMemberRegion(member.country_code),
  idem?: BonusIdempotency
): number | null {
  if (idem && !claimBonusCredit(ledger.claimedKeys, idem.key)) {
    ledger.onDuplicateSkip(buildDuplicateSkipEntry(member, walletType, amount, idem));
    return null;
  }
  const usdAmount = toUsdForRegion(amount, region);
  adjustCommissionCounters(member, walletType, amount);
  member.wallets.total_earnings = roundCurrency(member.wallets.total_earnings + amount);

  // 14 günlük cayma koruması: usePendingClawback ise komisyon bölgesel bekleyen USD'ye yazılır.
  const regionalKey = usePendingClawback ? getRegionPendingKey(region) : getRegionWalletKey(region);
  member.wallets[regionalKey] = roundCurrency((member.wallets[regionalKey] || 0) + usdAmount);
  return usdAmount;
}
