import type {
  MonolineMember,
  SystemPoolCurrency,
  SystemPoolTransactionRecord,
  SystemPoolTransferType,
  SystemWalletRecord,
  WalletTransactionRecord,
} from '../types/monoline';

export interface SystemPoolTransferInput {
  systemWallet: SystemWalletRecord;
  member: MonolineMember;
  walletTransactions: WalletTransactionRecord[];
  systemPoolTransactions: SystemPoolTransactionRecord[];
  amountUsd: number;
  currency: SystemPoolCurrency;
  transferType: SystemPoolTransferType;
  description: string;
  adminUid: string;
  requestId: string;
  walletTransactionId: number;
  systemPoolTransactionId: number;
  transactionId: string;
  createdAt: string;
}

export class SystemPoolTransferError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_TRANSFER_AMOUNT' | 'INSUFFICIENT_SYSTEM_POOL_BALANCE',
    readonly statusCode: number
  ) {
    super(message);
  }
}

export function getSystemPoolUsdBalances(systemWallet: SystemWalletRecord) {
  const domestic = systemWallet.system_pool_domestic_usd ?? 0;
  const international = systemWallet.system_pool_international_usd ?? 0;
  return {
    domestic,
    international,
    total: Math.round((domestic + international + Number.EPSILON) * 100) / 100,
  };
}

export function applySystemPoolTransfer(input: SystemPoolTransferInput) {
  const { amountUsd, currency, member, systemWallet } = input;
  if (
    !Number.isFinite(amountUsd) ||
    amountUsd <= 0 ||
    Math.abs(amountUsd * 100 - Math.round(amountUsd * 100)) > 1e-7
  ) {
    throw new SystemPoolTransferError('Tutar pozitif ve en fazla iki ondalık basamaklı olmalıdır.', 'INVALID_TRANSFER_AMOUNT', 400);
  }

  const region = currency === 'DOMESTIC_USD' ? 'DOMESTIC' : 'INTERNATIONAL';
  const poolKey = region === 'DOMESTIC' ? 'system_pool_domestic_usd' : 'system_pool_international_usd';
  const walletKey = region === 'DOMESTIC' ? 'wallet_domestic_usd' : 'wallet_international_usd';
  const poolBalanceBefore = systemWallet[poolKey] ?? 0;
  if (amountUsd > poolBalanceBefore) {
    throw new SystemPoolTransferError('Seçilen bölgesel sistem havuzunda yeterli bakiye yok.', 'INSUFFICIENT_SYSTEM_POOL_BALANCE', 422);
  }

  const walletBalanceBefore = member.wallets[walletKey] ?? 0;
  const poolBalanceAfter = Math.round((poolBalanceBefore - amountUsd + Number.EPSILON) * 100) / 100;
  const walletBalanceAfter = Math.round((walletBalanceBefore + amountUsd + Number.EPSILON) * 100) / 100;
  const walletTransactionType = input.transferType === 'GIFT' || input.transferType === 'MANUAL_ADJUSTMENT'
    ? 'ADMIN_GIFT'
    : 'SYSTEM_BONUS';
  const walletTransaction: WalletTransactionRecord = {
    id: input.walletTransactionId,
    transaction_id: input.transactionId,
    user_id: member.id,
    external_user_id: member.user_id,
    user_full_name: member.full_name,
    transaction_type: walletTransactionType,
    request_id: input.requestId,
    direction: 'CREDIT',
    amount: amountUsd,
    balance_before: walletBalanceBefore,
    balance_after: walletBalanceAfter,
    order_id: input.requestId,
    related_user_id: input.adminUid,
    package_id: '',
    description: input.description,
    status: 'COMPLETED',
    created_at: input.createdAt,
  };
  const poolTransaction: SystemPoolTransactionRecord = {
    id: input.systemPoolTransactionId,
    request_id: input.requestId,
    direction: 'DEBIT',
    type: input.transferType,
    currency,
    region,
    amount_usd: amountUsd,
    balance_before_usd: poolBalanceBefore,
    balance_after_usd: poolBalanceAfter,
    target_user_id: member.user_id,
    target_user_name: member.full_name,
    admin_uid: input.adminUid,
    description: input.description,
    created_at: input.createdAt,
  };

  systemWallet[poolKey] = poolBalanceAfter;
  systemWallet.updated_at = input.createdAt;
  member.wallets[walletKey] = walletBalanceAfter;
  input.walletTransactions.unshift(walletTransaction);
  input.systemPoolTransactions.unshift(poolTransaction);

  return { walletTransaction, poolTransaction };
}
