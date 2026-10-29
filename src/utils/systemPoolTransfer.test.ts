import assert from 'node:assert/strict';
import test from 'node:test';
import type { MonolineMember, SystemPoolTransactionRecord, SystemWalletRecord, WalletTransactionRecord } from '../types/monoline';
import {
  applySystemPoolTransfer,
  getSystemPoolUsdBalances,
  SystemPoolTransferError,
} from './systemPoolTransfer';
import type { SystemPoolTransferInput } from './systemPoolTransfer';

const createMember = (wallets = {}): MonolineMember => ({
  id: 2,
  user_id: 'USR-2',
  full_name: 'Test Bayi',
  country_code: 'TR',
  wallets: { wallet_domestic_usd: 10, wallet_international_usd: 20, ...wallets },
} as MonolineMember);

const createSystemWallet = (): SystemWalletRecord => ({
  id: 1,
  system_pool_balance: 0,
  system_pool_domestic_usd: 100,
  system_pool_international_usd: 50,
  unclaimed_pool_balance: 0,
  updated_at: '2026-01-01T00:00:00.000Z',
});

const createInput = (overrides: Partial<SystemPoolTransferInput> = {}): SystemPoolTransferInput => ({
  systemWallet: createSystemWallet(),
  member: createMember(),
  walletTransactions: [] as WalletTransactionRecord[],
  systemPoolTransactions: [] as SystemPoolTransactionRecord[],
  amountUsd: 25.5,
  currency: 'DOMESTIC_USD' as const,
  transferType: 'BONUS' as const,
  description: 'Kampanya bonusu',
  adminUid: 'admin-1',
  requestId: 'pool-req-1',
  walletTransactionId: 1,
  systemPoolTransactionId: 1,
  transactionId: 'WLT-1',
  createdAt: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

test('system pool transfer decreases regional pool and credits matching member wallet with both logs', () => {
  const input = createInput();
  const result = applySystemPoolTransfer(input);

  assert.equal(input.systemWallet.system_pool_domestic_usd, 74.5);
  assert.equal(input.systemWallet.system_pool_international_usd, 50);
  assert.equal(input.member.wallets.wallet_domestic_usd, 35.5);
  assert.equal(input.member.wallets.wallet_international_usd, 20);
  assert.equal(input.walletTransactions[0].transaction_type, 'SYSTEM_BONUS');
  assert.equal(input.walletTransactions[0].description, 'Kampanya bonusu');
  assert.equal(input.systemPoolTransactions[0].target_user_id, 'USR-2');
  assert.equal(result.poolTransaction.balance_after_usd, 74.5);
});

test('international transfer uses international pool and wallet', () => {
  const input = createInput({ currency: 'INTERNATIONAL_USD' as const, transferType: 'GIFT' as const });
  applySystemPoolTransfer(input);

  assert.equal(input.systemWallet.system_pool_domestic_usd, 100);
  assert.equal(input.systemWallet.system_pool_international_usd, 24.5);
  assert.equal(input.member.wallets.wallet_international_usd, 45.5);
  assert.equal(input.walletTransactions[0].transaction_type, 'ADMIN_GIFT');
});

test('transfer rejects amount above the selected regional balance without changing state', () => {
  const input = createInput({ amountUsd: 100.01 });

  assert.throws(
    () => applySystemPoolTransfer(input),
    (error) => error instanceof SystemPoolTransferError && error.code === 'INSUFFICIENT_SYSTEM_POOL_BALANCE'
  );
  assert.equal(input.member.wallets.wallet_domestic_usd, 10);
  assert.equal(input.systemWallet.system_pool_domestic_usd, 100);
  assert.equal(input.walletTransactions.length, 0);
  assert.equal(input.systemPoolTransactions.length, 0);
});

test('transfer rejects zero and fractional-cent amounts', () => {
  for (const amountUsd of [0, 1.001]) {
    assert.throws(
      () => applySystemPoolTransfer(createInput({ amountUsd })),
      (error) => error instanceof SystemPoolTransferError && error.code === 'INVALID_TRANSFER_AMOUNT'
    );
  }
});

test('pool summary reports domestic, international, and combined USD balances', () => {
  assert.deepEqual(getSystemPoolUsdBalances(createSystemWallet()), {
    domestic: 100,
    international: 50,
    total: 150,
  });
});
