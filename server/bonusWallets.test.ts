import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommissionLogRecord, MonolineMember } from '../src/types/monoline';
import { adjustCommissionCounters, claimBonusCredit, creditMemberWallet, type BonusLedger } from './bonusWallets';

function emptyMember(): Pick<MonolineMember, 'wallets'> {
  return {
    wallets: {
      sponsor_wallet: 0,
      fast_roi_wallet: 0,
      monoline_wallet: 0,
      infinity_wallet: 0,
      matching_wallet: 0,
      career_pool_wallet: 0,
    } as MonolineMember['wallets'],
  };
}

test('FAST_ROI bonusu hem sponsor hem fast_roi sayacına yazılır, monoline değişmez', () => {
  const member = emptyMember();
  adjustCommissionCounters(member, 'FAST_ROI_BONUS', 15);

  assert.equal(member.wallets.sponsor_wallet, 15);
  assert.equal(member.wallets.fast_roi_wallet, 15);
  assert.equal(member.wallets.monoline_wallet, 0);
});

test('sponsor-only tutar, üst sayaç eksi alt bonus formülüyle ayrılır', () => {
  const member = emptyMember();
  adjustCommissionCounters(member, 'SPONSOR', 10);
  adjustCommissionCounters(member, 'FAST_ROI_BONUS', 5);

  assert.equal(member.wallets.sponsor_wallet, 15);
  assert.equal(member.wallets.fast_roi_wallet, 5);
  assert.equal(member.wallets.sponsor_wallet - member.wallets.fast_roi_wallet, 10);
});

test('UNILEVEL_INFINITY bonusu infinity ve monoline sayaçlarına yazılır', () => {
  const member = emptyMember();
  adjustCommissionCounters(member, 'UNILEVEL_INFINITY', 7);

  assert.equal(member.wallets.infinity_wallet, 7);
  assert.equal(member.wallets.monoline_wallet, 7);
  assert.equal(member.wallets.sponsor_wallet, 0);
});

test('MATCHING_BONUS bonusu matching ve career_pool sayaçlarına yazılır', () => {
  const member = emptyMember();
  adjustCommissionCounters(member, 'MATCHING_BONUS', 3);

  assert.equal(member.wallets.matching_wallet, 3);
  assert.equal(member.wallets.career_pool_wallet, 3);
  assert.equal(member.wallets.monoline_wallet, 0);
});

test('aynı idempotency anahtarı ikinci kez talep edilemez', () => {
  const claimed = new Set<string>();

  assert.equal(claimBonusCredit(claimed, 'ORD-1|SPONSOR|5'), true);
  assert.equal(claimBonusCredit(claimed, 'ORD-1|SPONSOR|5'), false);
  assert.equal(claimBonusCredit(claimed, 'ORD-1|MONOLINE_DEPTH|5|1'), true);
});

test('creditMemberWallet aynı anahtarla ikinci çağrıda null döner ve DUPLICATE_SKIPPED loglar', () => {
  const logs: Array<Omit<CommissionLogRecord, 'id'>> = [];
  const ledger: BonusLedger = {
    claimedKeys: new Set<string>(),
    onDuplicateSkip: (entry) => logs.push(entry),
  };
  const member = {
    id: 5,
    user_id: 'USR-5',
    full_name: 'Test Bayi',
    country_code: 'TR',
    wallets: {
      sponsor_wallet: 0,
      fast_roi_wallet: 0,
      monoline_wallet: 0,
      infinity_wallet: 0,
      matching_wallet: 0,
      career_pool_wallet: 0,
      total_earnings: 0,
      wallet_domestic_usd: 0,
      wallet_international_usd: 0,
      pending_domestic_usd: 0,
      pending_international_usd: 0,
    },
  } as unknown as MonolineMember;
  const idem = { key: 'MANUAL_CAREER|5|BATCH-0001', orderId: 'BONUS-0001' };

  const first = creditMemberWallet(ledger, member, 'CAREER_POOL', 100, false, 'DOMESTIC', idem);
  const second = creditMemberWallet(ledger, member, 'CAREER_POOL', 100, false, 'DOMESTIC', idem);

  assert.equal(first, 100);
  assert.equal(second, null);
  assert.equal(member.wallets.career_pool_wallet, 100);
  assert.equal(member.wallets.wallet_domestic_usd, 100);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, 'DUPLICATE_SKIPPED');
  assert.equal(logs[0].order_id, 'BONUS-0001');
  assert.equal(logs[0].commission_type, 'CAREER_POOL');
  assert.equal(logs[0].amount, 100);
});
