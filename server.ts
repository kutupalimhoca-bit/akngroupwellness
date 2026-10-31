import express from 'express';
import 'dotenv/config';
import path from 'path';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { createPaymentProvider, PaymentProviderError } from './server/paymentProviders';
import {
  DEFAULT_ETHICS_GUIDELINES_CONTENT,
  normalizeEthicsGuidelinesContent,
} from './src/utils/ethicsGuidelinesContent';
import {
  convertTryToUsd,
  getMemberRegionalPendingUsd,
  getMemberRegionalUsdBalance,
  getRegionPendingKey,
  getActivationPriceForRegion,
  getPackagePriceForRegion,
  getRegionWalletKey,
  resolveMemberRegion,
} from './src/utils/walletRegion';
import {
  getPayoutChannelForRegion,
  normalizeBic,
  normalizeIban,
  validateWithdrawalPayout,
} from './src/utils/withdrawalPayout';
import {
  ActivationVoucherRecord,
  MemberRegion,
  ActivityLogRecord,
  BullMqJobRecord,
  CareerTier,
  CommissionLogRecord,
  CommissionLogStatusType,
  CommissionTransaction,
  CronJobExecutionRecord,
  DAILY_WITHDRAWAL_LIMITS_BY_CAREER,
  DealerFeedbackTicket,
  DepthPayoutDetail,
  FomoCountdownAlertRecord,
  FraudRiskAlertRecord,
  INITIAL_CAREER_TIERS,
  MonolineMember,
  NotificationOutboxRecord,
  OrderCommissionPayload,
  OrderLogRecord,
  P2PTransferRecord,
  PACKAGES,
  PackageId,
  PoolDistributionRecord,
  RANK_UP_REWARDS_BY_CAREER,
  SystemDistributionParameters,
  SystemStateResponse,
  SystemWalletRecord,
  TaxRefundInvoiceRecord,
  UNILEVEL_INFINITY_RULES,
  UnclaimedCommissionRecord,
  UnclaimedTransferReasonCode,
  UserRewardLogRecord,
  V2ArchitectureConfig,
  WebhookLogRecord,
  WalletTransactionRecord,
  WithdrawalChannel,
  WithdrawalRequestRecord,
  evaluateMemberOrganizationMetrics,
  getSubCareerCount,
} from './src/types/monoline.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ACTIVITY_PERIOD_DAYS = 30;
const CLAWBACK_PROTECTION_DAYS = 14;
const SYSTEM_FUND_PERCENT = 5;
const DIRECT_SPONSOR_PERCENT = 20;
const MONOLINE_DEPTH_PERCENTAGES = [7, 5, 4, 3, 2, 2, 2];

function roundCurrency(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

function getPackageOrderAmount(userId: string, packageId: Exclude<PackageId, 'CUSTOM'>): number {
  const member = members.find((m) => m.user_id === userId);
  return roundCurrency(
    getPackagePriceForRegion(PACKAGES[packageId].defaultPrice, resolveMemberRegion(member?.country_code))
  );
}

function getActivationOrderAmount(userId: string): number {
  const member = members.find((m) => m.user_id === userId);
  return getActivationPriceForRegion(resolveMemberRegion(member?.country_code));
}

function normalizePackageId(raw: string): Exclude<PackageId, 'CUSTOM'> | null {
  const upper = (raw || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (upper in PACKAGES) {
    return upper as Exclude<PackageId, 'CUSTOM'>;
  }
  const aliasMap: Record<string, Exclude<PackageId, 'CUSTOM'>> = {
    A: 'PKG_MINI_DENEME',
    B: 'PKG_GUMUS_STANDART',
    C: 'PKG_ALTIN_PRO',
    D: 'PKG_PLATIN_KLINIK',
    PKG_5K: 'PKG_MINI_DENEME',
    PKG_10K: 'PKG_BRONZ_BASLANGIC',
    PKG_15K: 'PKG_GUMUS_STANDART',
    PKG_20K: 'PKG_GUMUS_PLUS',
    PKG_25K: 'PKG_ALTIN_DANISMAN',
    PKG_30K: 'PKG_ALTIN_PRO',
    PKG_50K: 'PKG_PLATIN_KLINIK',
    PKG_60K: 'PKG_SAFIR_KURUMSAL',
    PKG_70K: 'PKG_ZUMRUT_MASTER',
    PKG_80K: 'PKG_YAKUT_ELIT',
    PKG_90K: 'PKG_TITANYUM_ENTEGRE',
    PKG_100K: 'PKG_ELMAS_BOLGE',
    PKG_200K: 'PKG_MASTER_FRANCHISE',
    PKG_300K: 'PKG_ENTERPRISE_MEGA',
    MINI_TRIAL_DEALER: 'PKG_MINI_DENEME',
    MINI_DEALER: 'PKG_MINI_DENEME',
    BRONZE_DEALER: 'PKG_BRONZ_BASLANGIC',
    SILVER_DEALER: 'PKG_GUMUS_STANDART',
    SILVER_PLUS_DEALER: 'PKG_GUMUS_PLUS',
    GOLD_DEALER: 'PKG_ALTIN_DANISMAN',
    GOLD_PRO_DEALER: 'PKG_ALTIN_PRO',
    PLATINUM_DEALER: 'PKG_PLATIN_KLINIK',
    SAPPHIRE_DEALER: 'PKG_SAFIR_KURUMSAL',
    EMERALD_DEALER: 'PKG_ZUMRUT_MASTER',
    RUBY_DEALER: 'PKG_YAKUT_ELIT',
    TITANIUM_DEALER: 'PKG_TITANYUM_ENTEGRE',
    DIAMOND_DEALER: 'PKG_ELMAS_BOLGE',
    MASTER_FRANCHISE_DEALER: 'PKG_MASTER_FRANCHISE',
    ENTERPRISE_MEGA_DEALER: 'PKG_ENTERPRISE_MEGA',
  };
  return aliasMap[upper] || null;
}

function getPackageItemsTotal(userId: string, rawItems: unknown): number | null {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return null;
  let total = 0;
  for (const item of rawItems) {
    const packageId = normalizePackageId(String(item?.package_id || ''));
    const quantity = Number(item?.quantity);
    if (!packageId || !Number.isInteger(quantity) || quantity <= 0) return null;
    total += getPackageOrderAmount(userId, packageId) * quantity;
  }
  return roundCurrency(total);
}

// Atomic Transaction Mutex Queue to prevent race conditions (simulating SQL BEGIN ... SELECT FOR UPDATE ... COMMIT)
let atomicLockPromise: Promise<any> = Promise.resolve();
function runInAtomicTransaction<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = atomicLockPromise.then(() => fn());
  atomicLockPromise = next.catch(() => {});
  return next;
}

// State stores
let ethicsGuidelinesContent = DEFAULT_ETHICS_GUIDELINES_CONTENT;
const ethicsGuidelinesClients = new Set<express.Response>();
let members: MonolineMember[] = [];
const memberCredentials = new Map<string, { salt: string; hash: string }>();
// Once a credit change happens on the server, Frekans sync must not overwrite that balance with a stale copy.
const creditsOwnedByServer = new Set<string>();
let careerTiers: CareerTier[] = structuredClone(INITIAL_CAREER_TIERS);
let distributionParams: SystemDistributionParameters = {
  system_fund_percent: SYSTEM_FUND_PERCENT,
  direct_sponsor_percent: DIRECT_SPONSOR_PERCENT,
  monoline_total_percent: 25,
  depth_percentages: [...MONOLINE_DEPTH_PERCENTAGES],
  unilevel_infinity_max_percent: 10,
  fast_roi_bonus_percent: 15,
  career_pool_percent: 5,
};
// Sabit kur (1 USD = X TRY). Admin panelinden güncellenir.
const DEFAULT_USD_TRY_RATE = 30;
let usdTryRate: number = DEFAULT_USD_TRY_RATE;
let usdTryRateUpdatedAt: string | null = null;
let usdTryRateUpdatedBy: string | null = null;
let adminAuditLogs: AdminAuditLogRecord[] = [];
let nextAdminAuditLogId = 1;

interface AdminAuditLogRecord {
  id: number;
  action: 'USD_TRY_RATE_UPDATED';
  admin_uid: string;
  previous_value: number;
  new_value: number;
  created_at: string;
}
let transactions: CommissionTransaction[] = [];
let commissionLogs: CommissionLogRecord[] = [];
let ordersLog: OrderLogRecord[] = [];
let systemWallet: SystemWalletRecord = {
  id: 1,
  system_pool_balance: 0,
  unclaimed_pool_balance: 0,
  updated_at: new Date().toISOString(),
};
let unclaimedCommissions: UnclaimedCommissionRecord[] = [];
let queueJobs: BullMqJobRecord[] = [];
let v2ArchitectureConfig: V2ArchitectureConfig = {
  use_rolling_30d_pgv: true,
  use_dynamic_active_career: true,
  async_queue_enabled: true,
  dynamic_compression_enabled: true,
  dynamic_compression_mode: 'FULL_COMPRESSION',
  unilevel_infinity_enabled: true,
  matching_bonus_enabled: true,
  fast_roi_3x15_enabled: true,
  fomo_48h_countdown_enabled: true,
  p2p_voucher_transfer_enabled: true,
  fast_start_window_days: 30,
  welcome_30d_double_bonus_enabled: true,
  whatsapp_business_push_enabled: true,
};
let withdrawalRequests: WithdrawalRequestRecord[] = [];
let taxRefundInvoices: TaxRefundInvoiceRecord[] = [];
let nextTaxRefundId = 1;
const sharedDocuments = new Map<string, {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
  data: Buffer;
}>();
let feedbackTickets: DealerFeedbackTicket[] = [];
let nextTicketNumber = 104;
let userRewardsLog: UserRewardLogRecord[] = [];
let notificationOutbox: NotificationOutboxRecord[] = [];
let fomoCountdownAlerts: FomoCountdownAlertRecord[] = [];
let p2pTransfers: P2PTransferRecord[] = [];
let walletTransactions: WalletTransactionRecord[] = [];
let activationVouchers: ActivationVoucherRecord[] = [];
let fraudAlerts: FraudRiskAlertRecord[] = [];
let webhookLogs: WebhookLogRecord[] = [];
let cronLogs: CronJobExecutionRecord[] = [];
let poolDistributions: PoolDistributionRecord[] = [];
let processedOrderIds: Set<string> = new Set();
let idempotentBlockedCount = 0;
let systemCareerFundBalance = 0;
let systemCareerFundCumulative = 0;
let enforceCareerDepthLock = true;
let nextCommissionLogId = 1;
let nextUnclaimedCommissionId = 1;
let nextWithdrawalId = 1;
let nextActivityLogId = 1;
let nextRewardLogId = 1;
let nextNotificationId = 1;
let nextFraudAlertId = 1;
let nextFomoAlertId = 1;
let nextP2PTransferId = 1;
let nextWalletTransactionId = 1;
let nextVoucherId = 1;

// V2.1 Anti-Fraud IP 24h Activity Tracker
let ipActivityEvents: Array<{ ip: string; user_id: string; order_id?: string; timestamp_ms: number }> = [];

function enqueueNotification(params: {
  member: MonolineMember;
  channel?: 'WHATSAPP' | 'SMS' | 'EMAIL' | 'PUSH';
  trigger_type: NotificationOutboxRecord['trigger_type'];
  order_amount?: number;
  commission_amount?: number;
  buyer_name?: string;
  message: string;
}): NotificationOutboxRecord {
  const rec: NotificationOutboxRecord = {
    id: nextNotificationId++,
    user_id: params.member.id,
    external_user_id: params.member.user_id,
    user_full_name: params.member.full_name,
    channel: params.channel || 'WHATSAPP',
    trigger_type: params.trigger_type,
    order_amount: params.order_amount,
    commission_amount: params.commission_amount,
    buyer_name: params.buyer_name,
    message: params.message,
    status: 'SENT',
    created_at: new Date().toISOString(),
  };
  notificationOutbox.unshift(rec);
  return rec;
}

function awardRankUpGiftIfNeeded(member: MonolineMember, newCareerLevel: number) {
  if (newCareerLevel < 2) return;
  for (let lvl = 2; lvl <= newCareerLevel; lvl++) {
    const alreadyAwarded = userRewardsLog.some(
      (r) => r.user_id === member.id && r.reward_type === 'RANK_UP_GIFT' && r.career_level === lvl
    );
    if (!alreadyAwarded && RANK_UP_REWARDS_BY_CAREER[lvl]) {
      const rewardDef = RANK_UP_REWARDS_BY_CAREER[lvl];
      const tierTitle = careerTiers.find((t) => t.level === lvl)?.title || `${lvl}. Kariyer`;
      const rewardRec: UserRewardLogRecord = {
        id: nextRewardLogId++,
        user_id: member.id,
        external_user_id: member.user_id,
        user_full_name: member.full_name,
        career_level: lvl,
        career_title: tierTitle,
        reward_type: 'RANK_UP_GIFT',
        reward_description: rewardDef.description,
        cash_value: rewardDef.cash_value,
        is_delivered: false,
        earned_at: new Date().toISOString(),
      };
      userRewardsLog.unshift(rewardRec);

      enqueueNotification({
        member,
        channel: 'WHATSAPP',
        trigger_type: 'RANK_UP_REWARD',
        message: `Tebrikler ${member.full_name}! İlk kez ${lvl}. Kariyer (${tierTitle}) unvanına ulaştınız! Tek seferlik "${rewardDef.description}" (${rewardDef.cash_value.toLocaleString('tr-TR')} $ değerinde) ödülünüz user_rewards_log tablosuna tanımlandı.`,
      });
    }
  }
}

function awardFastStartBonusIfQualified(sponsor: MonolineMember) {
  if (sponsor.fast_start_awarded) return;
  if (v2ArchitectureConfig.fast_roi_3x15_enabled === false) return;

  const sponsorPkgFloor = Math.max(5000, sponsor.personal_volume || 5000);
  const qualifyingDirects = members.filter(
    (m) =>
      (m.sponsor_id === sponsor.user_id || m.sponsor_db_id === sponsor.id) &&
      m.is_active &&
      (m.personal_volume || 0) >= 5000
  );
  if (qualifyingDirects.length < 3) return;

  const joinedMs = sponsor.joined_at ? new Date(sponsor.joined_at).getTime() : Date.now();
  const daysSinceJoin = Math.max(0, (Date.now() - joinedMs) / 86400000);
  // V2.2 Revizyon 3: İlk 30 gün içinde 3 aktif direkt referans getiren bayiye +%15 Fast-ROI Amortisman Bonusu
  if (daysSinceJoin <= (v2ArchitectureConfig.fast_start_window_days || 30)) {
    sponsor.fast_start_awarded = true;
    const first3Sum = qualifyingDirects
      .slice(0, 3)
      .reduce((sum, d) => sum + (d.personal_volume || 5000), 0);
    const amortized3xVolume = Math.min(sponsorPkgFloor * 3, first3Sum);
    const fastRoiRate = (distributionParams.fast_roi_bonus_percent ?? 15) / 100;
    const fastStartCash = roundCurrency(amortized3xVolume * fastRoiRate);

    creditMemberWallet(sponsor, 'FAST_ROI_BONUS', fastStartCash, true);

    const nowIso = new Date().toISOString();
    logComm(
      `FAST-ROI-${sponsor.user_id}`,
      sponsor,
      sponsor,
      'FAST_ROI_BONUS',
      null,
      fastStartCash,
      'PENDING_14D',
      new Date(Date.now() + CLAWBACK_PROTECTION_DAYS * 86400000).toISOString(),
      nowIso
    );

    userRewardsLog.unshift({
      id: nextRewardLogId++,
      user_id: sponsor.id,
      external_user_id: sponsor.user_id,
      user_full_name: sponsor.full_name,
      career_level: sponsor.career_level,
      career_title: sponsor.career_title,
      reward_type: 'FAST_START',
      reward_description: `"3 Getir Bedavaya Getir" (Fast-ROI +%15 Amortisman Bonusu · 3 × ${sponsorPkgFloor.toLocaleString('tr-TR')} $ = ${amortized3xVolume.toLocaleString('tr-TR')} $ × %15 = +${fastStartCash.toLocaleString('tr-TR')} $)`,
      cash_value: fastStartCash,
      is_delivered: true,
      earned_at: nowIso,
    });

    enqueueNotification({
      member: sponsor,
      channel: 'WHATSAPP',
      trigger_type: 'FAST_START_BONUS',
      message: `Tebrikler ${sponsor.full_name}! İlk 30 gün içinde 3 aktif direkt referans ("3 Getir Bedavaya Getir") şartını tamamladınız ve +%15 Fast-ROI Amortisman Bonusu olarak ${fastStartCash.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} $ kazandınız! (%20 Sponsor Primi + %15 Fast-ROI ile paketiniz %105 amorti edildi!)`,
    });
  }
}

let activityLogs: ActivityLogRecord[] = [];
const WELCOME_BONUS_BASE_CREDITS = 32;
const WELCOME_BONUS_EXTRA_CREDITS = 32;
const WELCOME_BONUS_TOTAL_CREDITS = WELCOME_BONUS_BASE_CREDITS + WELCOME_BONUS_EXTRA_CREDITS; // 32 + 32 = 64 Seans Kredisi

function createFutureExpiryIso(): string {
  return new Date(Date.now() + ACTIVITY_PERIOD_DAYS * 86400000).toISOString();
}

function isActivityValid(member: MonolineMember): boolean {
  if (!member.is_active || !member.activity_expires_at) return false;
  return new Date(member.activity_expires_at).getTime() > Date.now();
}

function logActivityEvent(params: {
  member: MonolineMember;
  action_type: ActivityLogRecord['action_type'];
  previous_expires_at: string | null;
  new_expires_at: string | null;
  description: string;
}) {
  activityLogs.unshift({
    id: nextActivityLogId++,
    user_id: params.member.id,
    external_user_id: params.member.user_id,
    user_full_name: params.member.full_name,
    action_type: params.action_type,
    previous_expires_at: params.previous_expires_at,
    new_expires_at: params.new_expires_at,
    is_active_after: params.member.is_active,
    description: params.description,
    created_at: new Date().toISOString(),
  });
}

// Otomatik Süresi Dolan Hesapları Tespit Eden Cron Job Fonksiyonu
function checkAndExpireAccountsCron(
  triggerType: 'ACTIVITY_EXPIRY_CRON' | 'MANUAL_ADMIN' | 'NIGHTLY_CRON' = 'ACTIVITY_EXPIRY_CRON'
): Array<{ user_id: string; full_name: string; expired_at: string }> {
  const nowMs = Date.now();
  const deactivated: Array<{ user_id: string; full_name: string; expired_at: string }> = [];

  for (const member of members) {
    if (!member.activity_expires_at) {
      member.activity_expires_at = createFutureExpiryIso();
    }
    const expMs = new Date(member.activity_expires_at).getTime();
    if (!isNaN(expMs) && expMs <= nowMs && member.is_active) {
      const prevExp = member.activity_expires_at;
      member.is_active = false;
      deactivated.push({
        user_id: member.user_id,
        full_name: member.full_name,
        expired_at: prevExp,
      });
      const expiredText = `Aktiflik süresi (${new Date(prevExp).toLocaleString('tr-TR')}) dolduğu için hesap pasife (is_active = false) alındı.`;
      logActivityEvent({
        member,
        action_type: 'CRON_EXPIRED_DEACTIVATED',
        previous_expires_at: prevExp,
        new_expires_at: prevExp,
        description: `${triggerType}: ${expiredText}`,
      });
    }
  }

  if (triggerType !== 'ACTIVITY_EXPIRY_CRON' || deactivated.length > 0) {
    cronLogs.unshift({
      id: `CRON-ACT-${Date.now().toString().slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`,
      trigger_type: triggerType,
      evaluated_users_count: members.length,
      upgrades_count: 0,
      deactivated_count: deactivated.length,
      upgrades: [],
      deactivated_users: deactivated,
      executed_at: new Date().toISOString(),
    });
  }

  return deactivated;
}

// V2.0: Hareketli 30 Günlük Ciro (Rolling 30-Day PGV) Hesaplama Motoru
function recalculateRolling30DayVolumes() {
  const cutoffMs = Date.now() - 30 * 86400000;
  const rollingPersonalByUser = new Map<string, number>();

  for (const m of members) {
    rollingPersonalByUser.set(m.user_id, 0);
  }

  for (const tx of transactions) {
    if (tx.clawback_status === 'REFUNDED') continue;
    const txMs = new Date(tx.timestamp).getTime();
    if (!isNaN(txMs) && txMs >= cutoffMs) {
      const prev = rollingPersonalByUser.get(tx.buyer_user_id) || 0;
      rollingPersonalByUser.set(tx.buyer_user_id, roundCurrency(prev + tx.order_amount));
    }
  }

  for (const m of members) {
    const txVol30d = rollingPersonalByUser.get(m.user_id) || 0;
    const rPers = m.is_active ? Math.max(txVol30d, m.personal_volume || 0) : txVol30d;
    m.rolling_30d_personal_volume = rPers;
    m.personal_volume_30d = rPers;
  }

  // Her üye için son 30 gündeki Unilevel Sponsor Ağacı Cirosunu (WITH RECURSIVE uplines -> group_volume_30d) hesapla
  for (const m of members) {
    const visited = new Set<string>([m.user_id]);
    const queue = members.filter(
      (c) => c.sponsor_id === m.user_id || c.sponsor_db_id === m.id
    );
    for (const c of queue) visited.add(c.user_id);

    let unilevelRollingVol = 0;
    while (queue.length > 0) {
      const curr = queue.shift()!;
      unilevelRollingVol = roundCurrency(
        unilevelRollingVol + (curr.personal_volume_30d ?? curr.personal_volume ?? 0)
      );
      const subs = members.filter(
        (sub) =>
          (sub.sponsor_id === curr.user_id || sub.sponsor_db_id === curr.id) &&
          !visited.has(sub.user_id)
      );
      for (const s of subs) {
        visited.add(s.user_id);
        queue.push(s);
      }
    }

    m.rolling_30d_pgv = unilevelRollingVol;
    m.group_volume_30d = unilevelRollingVol;
    m.monoline_position = m.global_line_id;
  }
}

// Section 3: Kariyer Güncelleme Tetikleyicisi (V2.0 Dynamic Career Engine)
// max_career_level (Profilde Kalan En Yüksek Unvan) vs active_career_level (Dönemsel Hak Ediş Yetkisi)
function evaluateMemberCareer(
  member: MonolineMember,
  allMembers: MonolineMember[]
): {
  level: number;
  title: string;
  unlockedDepth: number;
  activeDirects: number;
  rolling30dPgv: number;
} {
  const orgEval = evaluateMemberOrganizationMetrics(
    member,
    allMembers,
    careerTiers,
    v2ArchitectureConfig.use_rolling_30d_pgv
  );
  const activeDirects = orgEval.activeDirectsCount;

  if (
    member.manual_career_override !== null &&
    member.manual_career_override >= 1 &&
    member.manual_career_override <= 7
  ) {
    const manualTier = careerTiers.find((t) => t.level === member.manual_career_override);
    if (manualTier) {
      return {
        level: manualTier.level,
        title: manualTier.title,
        unlockedDepth: manualTier.unlockedDepth,
        activeDirects,
        rolling30dPgv: orgEval.effectiveGroupVolume,
      };
    }
  }

  // Default starting career level is 1: Emmâre (1. Derinlik kilidi açık)
  let matchedLevel = 1;
  let matchedTitle = careerTiers[0]?.title || 'Emmâre';
  let unlockedDepth = careerTiers[0]?.unlockedDepth || 1;

  for (const tier of careerTiers) {
    if (tier.level === 1) continue;
    const check = orgEval.tierChecks.find((c) => c.level === tier.level);
    if (!check) continue;

    const qualifies =
      tier.enforceStrictOrganizationRules !== false
        ? check.allStrictCriteriaMet
        : check.personalOk && check.directsOk;

    if (qualifies) {
      matchedLevel = tier.level;
      matchedTitle = tier.title;
      unlockedDepth = tier.unlockedDepth;
    }
  }

  return {
    level: matchedLevel,
    title: matchedTitle,
    unlockedDepth,
    activeDirects,
    rolling30dPgv: orgEval.effectiveGroupVolume,
  };
}

function recalculateAllCareers(
  triggerType:
    | 'NIGHTLY_CRON'
    | 'POST_COMMISSION_EVENT'
    | 'MANUAL_ADMIN'
    | 'RESTORE_DATA' = 'POST_COMMISSION_EVENT'
): Array<{
  user_id: string;
  full_name: string;
  old_level: number;
  old_title: string;
  new_level: number;
  new_title: string;
}> {
  recalculateRolling30DayVolumes();

  const initialLevels = new Map<string, { level: number; title: string; maxLevel: number }>();
  for (const m of members) {
    initialLevels.set(m.user_id, {
      level: m.active_career_level || m.career_level,
      title: m.active_career_title || m.career_title,
      maxLevel: m.max_career_level || m.career_level || 1,
    });
  }

  // Multi-pass (7 passes for 7 career tiers) bottom-up evaluation so downline career promotions immediately qualify upline leaders
  const reverseOrdered = [...members].sort((a, b) => b.global_line_id - a.global_line_id);
  for (let pass = 0; pass < 7; pass++) {
    for (const member of reverseOrdered) {
      const evalResult = evaluateMemberCareer(member, members);
      member.active_direct_referrals = evalResult.activeDirects;
      member.active_direct_referrals_30d = evalResult.activeDirects;
      member.rolling_30d_pgv = evalResult.rolling30dPgv;
      member.group_volume_30d = evalResult.rolling30dPgv;
      member.personal_volume_30d =
        member.rolling_30d_personal_volume ?? member.personal_volume ?? 0;
      member.monoline_position = member.global_line_id;

      // V2.0 Dynamic Career Status:
      // active_career_level: O ayki / son 30 günlük performansa göre belirlenen dönemsel hak ediş yetkisi
      // max_career_level: Üyenin ulaştığı en yüksek kariyer unvanı (profilde kalır)
      const prevMaxLevel = member.max_career_level || member.career_level || 1;
      const newMaxLevel = Math.max(prevMaxLevel, evalResult.level);
      const newMaxTier = careerTiers.find((t) => t.level === newMaxLevel) || careerTiers[0];

      const periodicActiveLevel = member.is_active ? newMaxLevel : 1;
      const periodicActiveTier =
        careerTiers.find((t) => t.level === periodicActiveLevel) || careerTiers[0];

      member.max_career_level = newMaxLevel;
      member.max_career_title = newMaxTier.title;
      member.active_career_level = periodicActiveLevel;
      member.active_career_title = periodicActiveTier.title;

      const effectiveLevel = v2ArchitectureConfig.use_dynamic_active_career
        ? periodicActiveLevel
        : newMaxLevel;
      const effectiveTier = careerTiers.find((t) => t.level === effectiveLevel) || careerTiers[0];

      member.career_level = newMaxLevel;
      member.career_title = newMaxTier.title;
      member.unlocked_depth = member.is_active ? effectiveTier.unlockedDepth : 0;
      member.daily_withdrawal_limit = DAILY_WITHDRAWAL_LIMITS_BY_CAREER[effectiveLevel] || 5000;

      // V2.0 Dynamic Pool Split Engine Puan Hesaplaması (Liderlik Seviyesi Ağırlığı + Son 30 Günlük PGV Katkısı)
      if (member.is_active && !member.is_locked) {
        const tierWeight = effectiveLevel * effectiveLevel * 10;
        const volumePoints = Math.floor((member.rolling_30d_pgv || 0) / 5000);
        const directPoints = (member.active_direct_referrals || 0) * 5;
        member.pool_leadership_points = Math.max(10, tierWeight + volumePoints + directPoints);
      } else {
        member.pool_leadership_points = 0;
      }
    }
  }

  // Trigger Rank-Up Gifts and Fast-Start Bonuses after all 7 passes have converged
  for (const member of members) {
    const currMax = member.max_career_level || member.career_level || 1;
    if (currMax >= 2) {
      awardRankUpGiftIfNeeded(member, currMax);
    }
    awardFastStartBonusIfQualified(member);
  }

  const upgrades: Array<{
    user_id: string;
    full_name: string;
    old_level: number;
    old_title: string;
    new_level: number;
    new_title: string;
  }> = [];

  for (const member of members) {
    const prev = initialLevels.get(member.user_id);
    if (prev && member.career_level > prev.level) {
      upgrades.push({
        user_id: member.user_id,
        full_name: member.full_name,
        old_level: prev.level,
        old_title: prev.title,
        new_level: member.career_level,
        new_title: member.career_title,
      });
    }
  }

  if (triggerType !== 'POST_COMMISSION_EVENT' || upgrades.length > 0) {
    cronLogs.unshift({
      id: `CRON-${Date.now().toString().slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`,
      trigger_type: triggerType,
      evaluated_users_count: members.length,
      upgrades_count: upgrades.length,
      upgrades,
      executed_at: new Date().toISOString(),
    });
  }

  return upgrades;
}

function toUsdForRegion(baseAmount: number, region: MemberRegion): number {
  if (region === 'INTERNATIONAL') return roundCurrency(baseAmount);
  if (baseAmount === 0) return 0;
  if (!(usdTryRate > 0)) {
    throw new Error('Sabit USD kuru tanımlı değil. Yurt içi komisyon işlenemez.');
  }
  return convertTryToUsd(baseAmount, usdTryRate);
}

function resolveLogRegionalUsd(
  log: { region?: MemberRegion; amount: number; amount_usd?: number },
  member: MonolineMember
) {
  const region = log.region ?? resolveMemberRegion(member.country_code);
  const usd = log.amount_usd ?? toUsdForRegion(log.amount, region);
  return { region, usd };
}

function releaseRegionalPendingUsd(member: MonolineMember, region: MemberRegion, usdAmount: number) {
  const pendingKey = getRegionPendingKey(region);
  const walletKey = getRegionWalletKey(region);
  const deduct = Math.min(member.wallets[pendingKey] || 0, usdAmount);
  member.wallets[pendingKey] = Math.max(0, roundCurrency((member.wallets[pendingKey] || 0) - deduct));
  member.wallets[walletKey] = roundCurrency((member.wallets[walletKey] || 0) + usdAmount);
}

const MIN_WITHDRAWAL_USD = 50;
const WITHDRAWAL_TAX_RATE = 0.2;

function creditMemberRegionalUsd(
  member: MonolineMember,
  usdAmount: number,
  region: MemberRegion = resolveMemberRegion(member.country_code)
) {
  const key = getRegionWalletKey(region);
  member.wallets[key] = roundCurrency((member.wallets[key] || 0) + usdAmount);
}

function debitMemberRegionalUsd(
  member: MonolineMember,
  usdAmount: number,
  region: MemberRegion = resolveMemberRegion(member.country_code)
) {
  const key = getRegionWalletKey(region);
  const current = member.wallets[key] || 0;
  if (usdAmount > current) {
    throw new Error(`Yetersiz bölgesel USD bakiyesi (Mevcut: $${current.toFixed(2)}).`);
  }
  member.wallets[key] = roundCurrency(current - usdAmount);
}

function chargeActivationRenewal(member: MonolineMember, timestamp: string, orderPrefix: string) {
  const cost = roundCurrency(getActivationOrderAmount(member.user_id));
  const balanceBefore = getMemberRegionalUsdBalance(member);
  if (balanceBefore < cost) {
    const error: any = new Error(
      `Bölgesel USD bakiyesi yetersiz (Mevcut: $${balanceBefore.toFixed(2)}; gereken: $${cost.toFixed(2)}).`
    );
    error.statusCode = 422;
    error.code = 'INSUFFICIENT_WALLET_BALANCE';
    throw error;
  }
  const orderId = `${orderPrefix}-${member.global_line_id}-${Date.now().toString().slice(-6)}`;
  const tx = processOrderCommission({
    user_id: member.user_id,
    order_id: orderId,
    order_amount: cost,
    package_id: 'ACTIVATION',
    order_type: 'ACTIVATION',
    payment_method: 'WALLET_BALANCE',
    timestamp,
  });
  debitMemberRegionalUsd(member, cost);
  walletTransactions.unshift({
    id: nextWalletTransactionId++,
    transaction_id: `WLT-${randomBytes(10).toString('hex').toUpperCase()}`,
    user_id: member.id,
    external_user_id: member.user_id,
    user_full_name: member.full_name,
    transaction_type: 'PACKAGE_PURCHASE_WALLET',
    request_id: orderId,
    direction: 'DEBIT',
    amount: cost,
    balance_before: balanceBefore,
    balance_after: getMemberRegionalUsdBalance(member),
    order_id: orderId,
    related_user_id: member.user_id,
    package_id: 'ACTIVATION',
    description: `30 Günlük Süre Uzatma Paketi · $${cost.toFixed(2)} · aktiflik +${ACTIVITY_PERIOD_DAYS} gün`,
    status: 'COMPLETED',
    created_at: timestamp,
  });
  return tx;
}

function usdToTry(usdAmount: number): number {
  if (!(usdTryRate > 0)) {
    throw new Error('Sabit USD kuru tanımlı değil. $ karşılığı hesaplanamıyor.');
  }
  return roundCurrency(usdAmount * usdTryRate);
}

type CommissionWalletType =
  | 'SPONSOR'
  | 'MONOLINE_DEPTH'
  | 'CAREER_POOL'
  | 'UNILEVEL_INFINITY'
  | 'MATCHING_BONUS'
  | 'FAST_ROI_BONUS';

function adjustCommissionCounters(
  member: MonolineMember,
  walletType: CommissionWalletType,
  delta: number
) {
  const wallets = member.wallets;
  const bump = (current: number | undefined, change: number) =>
    Math.max(0, roundCurrency((current || 0) + change));
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

function creditMemberWallet(
  member: MonolineMember,
  walletType: CommissionWalletType,
  amount: number,
  usePendingClawback = false,
  region: MemberRegion = resolveMemberRegion(member.country_code)
) {
  const usdAmount = toUsdForRegion(amount, region);
  adjustCommissionCounters(member, walletType, amount);
  member.wallets.total_earnings = roundCurrency(member.wallets.total_earnings + amount);

  // 14 günlük cayma koruması: usePendingClawback ise komisyon bölgesel bekleyen USD'ye yazılır.
  const regionalKey = usePendingClawback ? getRegionPendingKey(region) : getRegionWalletKey(region);
  member.wallets[regionalKey] = roundCurrency((member.wallets[regionalKey] || 0) + usdAmount);
  return usdAmount;
}

function addSystemPoolBalance(amount: number) {
  systemCareerFundBalance = roundCurrency(systemCareerFundBalance + amount);
  systemCareerFundCumulative = roundCurrency(systemCareerFundCumulative + amount);
  // Sync wallets.system_fund_balance on the root/company account (#1)
  if (members[0]) {
    members[0].wallets.system_fund_balance = systemCareerFundBalance;
  }
}

// Section 3B: logComm(client, orderId, sourceId, targetId, type, depth, amount, status, releaseAt)
// INSERT INTO commission_logs (order_id, source_user_id, target_user_id, type, depth_level, amount, status, release_at)
// VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
function logComm(
  orderId: string,
  sourceMember: MonolineMember,
  targetMember: MonolineMember | null,
  type:
    | 'SPONSOR'
    | 'MONOLINE_DEPTH'
    | 'SYSTEM_POOL'
    | 'UNILEVEL_INFINITY'
    | 'MATCHING_BONUS'
    | 'FAST_ROI_BONUS',
  depth: number | null,
  amount: number,
  status: CommissionLogStatusType,
  releaseAt: string,
  createdAt: string,
  targetFallbackName?: string
) {
  const isPaidPending = status === 'PENDING_14D';
  const isPaidReleased = status === 'RELEASED' && type !== 'SYSTEM_POOL';
  const isWinnerBonus = type === 'MATCHING_BONUS' || type === 'FAST_ROI_BONUS';
  const region = resolveMemberRegion(
    isWinnerBonus && targetMember ? targetMember.country_code : sourceMember.country_code
  );
  const walletCredited =
    Boolean(targetMember) &&
    type !== 'SYSTEM_POOL' &&
    (isPaidPending || isPaidReleased || status === 'FRAUD_REVIEW');

  commissionLogs.unshift({
    id: nextCommissionLogId++,
    order_id: orderId,
    source_user_id: sourceMember.id,
    source_external_id: sourceMember.user_id,
    source_user_name: sourceMember.full_name,
    target_user_id: targetMember ? targetMember.id : null,
    target_external_id: targetMember ? targetMember.user_id : 'SYSTEM_POOL',
    target_user_name:
      targetFallbackName ||
      (targetMember
        ? isPaidPending || isPaidReleased
          ? targetMember.full_name
          : `${targetMember.full_name} → Devir Havuzu (unclaimed_pool_balance)`
        : type === 'SYSTEM_POOL'
        ? 'system_wallet (system_pool_balance)'
        : 'Devir Havuzu (unclaimed_pool_balance)'),
    type,
    commission_type: type,
    depth_level: depth,
    amount,
    region,
    amount_usd: walletCredited ? toUsdForRegion(amount, region) : undefined,
    status,
    clawback_status: isPaidPending
      ? 'PENDING_14D'
      : isPaidReleased
      ? 'RELEASED_TO_BALANCE'
      : 'SYSTEM_FUND',
    release_at: releaseAt,
    released_at: status === 'RELEASED' ? createdAt : null,
    transfer_reason_code:
      isPaidPending || isPaidReleased
        ? 'PAID'
        : type === 'SYSTEM_POOL'
        ? null
        : (status as UnclaimedTransferReasonCode),
    created_at: createdAt,
  });
}

// ============================================================================
// SECTION 4: %50 KOL DENGE KURALI & KARİYER TERFİ ENGINE (calculateActiveCareer)
// ============================================================================
function calculateSingleUserActiveCareer(userId: number | string) {
  const user = members.find((m) => m.id === Number(userId) || m.user_id === String(userId));
  if (!user) return null;

  // 1. Kol (Leg) Bazlı Ciro Analizi (%50 Kol Denge Kuralı)
  // SELECT sponsor_id, SUM(group_volume_30d + personal_volume_30d) as leg_vol
  // FROM users WHERE sponsor_id = $1 GROUP BY sponsor_id
  const directChildren = members.filter(
    (m) => m.sponsor_id === user.user_id || m.sponsor_db_id === user.id
  );

  const legRows = directChildren.map((child) => {
    const visited = new Set<string>([child.user_id]);
    const queue: MonolineMember[] = [child];
    let subtreeVol30d = 0;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      const p30d =
        typeof curr.personal_volume_30d === 'number'
          ? curr.personal_volume_30d
          : typeof curr.rolling_30d_personal_volume === 'number'
          ? curr.rolling_30d_personal_volume
          : curr.personal_volume || 0;
      subtreeVol30d = roundCurrency(subtreeVol30d + p30d);

      const subs = members.filter(
        (m) =>
          (m.sponsor_id === curr.user_id || m.sponsor_db_id === curr.id) &&
          !visited.has(m.user_id)
      );
      for (const s of subs) {
        visited.add(s.user_id);
        queue.push(s);
      }
    }

    return {
      leg_root_user_id: child.user_id,
      leg_root_name: child.full_name,
      leg_vol: subtreeVol30d,
    };
  });

  const legsSumGV = roundCurrency(legRows.reduce((acc, l) => acc + l.leg_vol, 0));
  const rawUserGV =
    typeof user.group_volume_30d === 'number'
      ? user.group_volume_30d
      : typeof user.rolling_30d_pgv === 'number'
      ? user.rolling_30d_pgv
      : user.group_volume || 0;
  const totalGV = Math.max(legsSumGV, rawUserGV);
  const maxCapPerLeg = roundCurrency(totalGV * 0.5); // En fazla %50'si 1 koldan gelebilir
  let adjustedGV = 0;

  for (const leg of legRows) {
    const vol = Number(leg.leg_vol) || 0;
    adjustedGV = roundCurrency(adjustedGV + (vol > maxCapPerLeg ? maxCapPerLeg : vol));
  }

  // Eğer üyenin direkt alt kolu yoksa ancak küresel monoline grup cirosu varsa 1-2. seviyeler için baz al
  const effectiveAdjustedGV = legRows.length > 0 ? adjustedGV : totalGV;

  // 2. 7 Seviye Kurallarının Kontrol Edilmesi (SELECT * FROM career_rules ORDER BY level ASC)
  const orgEval = evaluateMemberOrganizationMetrics(
    user,
    members,
    careerTiers,
    v2ArchitectureConfig.use_rolling_30d_pgv
  );
  const personalVol30d = Math.max(
    user.personal_volume || 0,
    typeof user.personal_volume_30d === 'number'
      ? user.personal_volume_30d
      : user.rolling_30d_personal_volume || 0
  );
  const activeDirectRefs30d = directChildren.filter((c) => c.is_active).length;
  user.active_direct_referrals = activeDirectRefs30d;
  user.active_direct_referrals_30d = activeDirectRefs30d;

  let targetActiveLevel = orgEval.target_active_level;

  if (
    user.manual_career_override !== null &&
    user.manual_career_override >= 1 &&
    user.manual_career_override <= 7
  ) {
    targetActiveLevel = user.manual_career_override;
  }

  // 3. Aktif ve Maksimum Kariyeri Güncelle
  // UPDATE users SET active_career_level = $1, max_career_level = GREATEST(max_career_level, $1) WHERE id = $2
  const prevMaxLevel = user.max_career_level || user.career_level || 1;
  const newMaxLevel = Math.max(prevMaxLevel, targetActiveLevel);
  const effectiveActive = user.is_active ? newMaxLevel : 1;
  const activeTier = careerTiers.find((t) => t.level === effectiveActive) || careerTiers[0];
  const maxTier = careerTiers.find((t) => t.level === newMaxLevel) || careerTiers[0];

  user.active_career_level = effectiveActive;
  user.active_career_title = activeTier.title;
  user.max_career_level = newMaxLevel;
  user.max_career_title = maxTier.title;

  const chosenLevel = v2ArchitectureConfig.use_dynamic_active_career
    ? effectiveActive
    : newMaxLevel;
  const chosenTier = careerTiers.find((t) => t.level === chosenLevel) || careerTiers[0];
  user.career_level = newMaxLevel;
  user.career_title = maxTier.title;
  user.unlocked_depth = user.is_active ? chosenTier.unlockedDepth : 0;
  user.daily_withdrawal_limit = DAILY_WITHDRAWAL_LIMITS_BY_CAREER[chosenLevel] || 5000;

  if (newMaxLevel >= 2) {
    awardRankUpGiftIfNeeded(user, newMaxLevel);
  }
  awardFastStartBonusIfQualified(user);

  return {
    user_id: user.user_id,
    db_id: user.id,
    full_name: user.full_name,
    personal_volume_30d: personalVol30d,
    active_direct_referrals_30d: activeDirectRefs30d,
    totalGV,
    maxCapPerLeg,
    adjustedGV: effectiveAdjustedGV,
    legs: legRows,
    sub_career_counts: {
      level_2_levvame: getSubCareerCount(members, user.id, 2),
      level_3_mulhime: getSubCareerCount(members, user.id, 3),
      level_4_mutmainne: getSubCareerCount(members, user.id, 4),
      level_5_raziye: getSubCareerCount(members, user.id, 5),
    },
    targetActiveLevel: effectiveActive,
    active_career_level: user.active_career_level,
    active_career_title: user.active_career_title,
    max_career_level: user.max_career_level,
    max_career_title: user.max_career_title,
  };
}

// Section 3B Step 7 & Section 4: Kariyer Güncellemelerini Tetikle (Alıcı ve Üst Sponsorlar için)
function calculateActiveCareer(buyerId: number | string) {
  const upgrades = recalculateAllCareers('POST_COMMISSION_EVENT');
  // Ayrıca alıcı ve tüm Unilevel üst sponsor zinciri için Section 4 calculateSingleUserActiveCareer çalıştır
  const target = members.find((m) => m.id === Number(buyerId) || m.user_id === String(buyerId));
  if (target) {
    const visited = new Set<string>();
    let curr: MonolineMember | undefined = target;
    while (curr && !visited.has(curr.user_id)) {
      visited.add(curr.user_id);
      calculateSingleUserActiveCareer(curr.id);
      curr = curr.sponsor_id
        ? members.find((m) => m.user_id === curr!.sponsor_id)
        : undefined;
    }
  }
  return upgrades;
}

function processOrderCommission(payload: OrderCommissionPayload): CommissionTransaction {
  const startMs = Date.now();
  const orderId = String(payload.order_id || `ORD-${Date.now().toString().slice(-6)}`).trim();

  // Section 5: Idempotency (Yinelenen Sipariş Engeli) — order_id UNIQUE kontrolü
  if (processedOrderIds.has(orderId)) {
    idempotentBlockedCount++;
    const err: any = new Error(
      `Idempotency Hatası: '${orderId}' numaralı sipariş daha önce işlenmiş. Yinelenen sipariş engellendi.`
    );
    err.statusCode = 409;
    err.isIdempotent = true;
    throw err;
  }

  const amount = Number(payload.order_amount);
  if (isNaN(amount) || amount <= 0) {
    throw new Error('Geçersiz sipariş tutarı (order_amount > 0 olmalıdır).');
  }

  let buyerIndex = members.findIndex((m) => m.user_id === payload.user_id);
  if (buyerIndex === -1) {
    if (String(payload.user_id).startsWith('GECERSIZ')) {
      throw new Error(`Kullanıcı bulunamadı: ${payload.user_id}`);
    }
    // Auto-onboard external Frekans app user into Monoline Global Single Line
    const nextLineId = members.length + 1;
    const rawSponsor = (payload as any).sponsor_id || (payload as any).referred_by_code || '';
    const matchedSponsor = rawSponsor
      ? members.find(
          (m) =>
            m.user_id === rawSponsor ||
            (m.ref_code && m.ref_code.toUpperCase() === String(rawSponsor).toUpperCase())
        )
      : members[0];

    const autoMember: MonolineMember = {
      id: nextLineId,
      user_id: String(payload.user_id),
      global_line_id: nextLineId,
      ref_code:
        (payload as any).ref_code ||
        `AURA-BAYI-${String(payload.user_id)
          .replace(/[^A-Z0-9]/gi, '')
          .slice(-4)
          .toUpperCase() || 1000 + nextLineId}`,
      full_name: (payload as any).reseller_name || `Frekans Bayi #${nextLineId}`,
      email: (payload as any).reseller_email || '',
      phone: (payload as any).reseller_phone || '',
      city: (payload as any).city || 'Türkiye',
      joined_at: payload.timestamp || new Date().toISOString(),
      sponsor_id:
        matchedSponsor && matchedSponsor.user_id !== String(payload.user_id)
          ? matchedSponsor.user_id
          : null,
      sponsor_db_id:
        matchedSponsor && matchedSponsor.user_id !== String(payload.user_id)
          ? matchedSponsor.id
          : null,
      highest_package_id: normalizePackageId(payload.package_id) || 'PKG_MINI_DENEME',
      session_credits: 0,
      personal_volume: 0,
      group_volume: 0,
      active_direct_referrals: 0,
      career_level: 1,
      career_title: 'Emmâre',
      manual_career_override: null,
      unlocked_depth: 1,
      wallets: {
        sponsor_wallet: 0,
        monoline_wallet: 0,
        career_pool_wallet: 0,
        total_earnings: 0,

        system_fund_balance: 0,
        total_withdrawn: 0,
      },
      bank_details: {
        iban_holder_name: (payload as any).reseller_name || '',
        bank_name: (payload as any).bank_name || '',
        iban: (payload as any).iban || '',
        trc20_address: (payload as any).trc20_address || '',
        preferred_method: 'IBAN',
      },
      two_factor: {
        enabled: false,
        secret_key: `JBSWY3DPEHPK3P${nextLineId}`,
        verified_at: null,
        backup_codes: [`NF-${nextLineId}-A1`],
      },
      is_active: true,
      is_locked: false,
      activity_expires_at: createFutureExpiryIso(),
      welcome_bonus_granted: false,
      welcome_bonus_credits: 0,
      tc_identity_no: `${Math.floor(10000000000 + Math.random() * 89999999999)}`,
      has_tax_company: false,
      last_login_ip: payload.client_ip || `176.240.${Math.floor(10 + Math.random() * 200)}.${nextLineId}`,
      device_fingerprint: payload.device_fingerprint || `DEV-FP-${nextLineId}`,
      kvkk_approved_at: payload.timestamp || new Date().toISOString(),
      contract_version: 'v2.0',
      daily_withdrawal_limit: DAILY_WITHDRAWAL_LIMITS_BY_CAREER[1],
      fast_start_awarded: false,
    };
    members.push(autoMember);
    buyerIndex = members.length - 1;
  }

  const buyer = members[buyerIndex];
  const buyerRegion = resolveMemberRegion(buyer.country_code);
  const clientIp = payload.client_ip || buyer.last_login_ip || `176.240.10.${buyer.global_line_id}`;
  buyer.last_login_ip = clientIp;

  // V2.1 Anti-Fraud & Risk Engine:
  // 1) Self-Referral Lock (Aynı IP / Cihaz ile sponsor-alt üye kendi kendini referans gösterme kontrolü)
  // 2) IP / Cihaz Çakışması Algoritması (Aynı IP adresinden 24 saat içinde > 3 işlem yapılırsa FRAUD_REVIEW)
  const nowMs = Date.now();
  ipActivityEvents = ipActivityEvents.filter((ev) => nowMs - ev.timestamp_ms <= 24 * 3600 * 1000);
  ipActivityEvents.push({
    ip: clientIp,
    user_id: buyer.user_id,
    order_id: orderId,
    timestamp_ms: nowMs,
  });
  const sameIpCount24h = ipActivityEvents.filter((ev) => ev.ip === clientIp).length;
  const sponsorForFraudCheck = buyer.sponsor_id
    ? members.find((m) => m.user_id === buyer.sponsor_id)
    : undefined;
  const isSelfReferralIpMatch =
    Boolean(payload.client_ip) &&
    Boolean(sponsorForFraudCheck?.last_login_ip) &&
    payload.client_ip === sponsorForFraudCheck?.last_login_ip &&
    buyer.user_id !== sponsorForFraudCheck?.user_id;

  const isFraudFlagged = sameIpCount24h > 3 || isSelfReferralIpMatch;
  let fraudReason: string | null = null;
  if (sameIpCount24h > 3) {
    fraudReason = `IP / Cihaz Çakışması (${clientIp}): Son 24 saat içinde aynı IP adresinden ${sameIpCount24h}. işlem tespit edildi (>3 sınırı aşıldı). Komisyonlar FRAUD_REVIEW statüsüne alındı.`;
    fraudAlerts.unshift({
      id: nextFraudAlertId++,
      order_id: orderId,
      user_id: buyer.id,
      external_user_id: buyer.user_id,
      user_full_name: buyer.full_name,
      rule_code: 'IP_COLLISION_24H',
      ip_address: clientIp,
      device_fingerprint: payload.device_fingerprint || buyer.device_fingerprint,
      status: 'FRAUD_REVIEW',
      details: fraudReason,
      created_at: new Date().toISOString(),
    });
  } else if (isSelfReferralIpMatch && sponsorForFraudCheck) {
    fraudReason = `Çapraz / Kendi Kendini Referans Gösterme Şüphesi (Self-Referral Lock): Alıcı (${buyer.full_name}) ile Sponsoru (${sponsorForFraudCheck.full_name}) aynı IP (${clientIp}) adresini kullanıyor. İşlem FRAUD_REVIEW statüsüne alındı.`;
    fraudAlerts.unshift({
      id: nextFraudAlertId++,
      order_id: orderId,
      user_id: buyer.id,
      external_user_id: buyer.user_id,
      user_full_name: buyer.full_name,
      rule_code: 'SELF_REFERRAL_LOCK',
      ip_address: clientIp,
      device_fingerprint: payload.device_fingerprint || buyer.device_fingerprint,
      status: 'FRAUD_REVIEW',
      details: fraudReason,
      created_at: new Date().toISOString(),
    });
  }
  const isActivationOrder = payload.order_type === 'ACTIVATION';
  const isActivityRenewalOrder = payload.order_type === 'ACTIVITY_RENEWAL' || isActivationOrder;
  const isInitialRegistrationSync =
    orderId.startsWith('ORD-KAYIT-') || orderId.startsWith('ORD-INIT-');

  // Mark order_id as processed inside atomic transaction
  processedOrderIds.add(orderId);

  const lockActive =
    typeof payload.enforce_career_depth_lock === 'boolean'
      ? payload.enforce_career_depth_lock
      : enforceCareerDepthLock;

  const normalizedPkg = normalizePackageId(payload.package_id);
  const skipCreditAddition = Boolean((payload as any).skip_credit_addition);
  let creditsAdded = 0;

  if (isActivationOrder) {
    creditsAdded = 0;
  } else if (normalizedPkg) {
    const pkgDef = PACKAGES[normalizedPkg];
    creditsAdded = pkgDef.sessionCredits;
    // İlk bayi kaydı oluşturan bayilere bir defaya mahsus sisteme hoşgeldin bonusu olarak 32+32 = 64 kredi tanımlanır
    if (isInitialRegistrationSync && !buyer.welcome_bonus_granted) {
      creditsAdded = Math.max(creditsAdded, WELCOME_BONUS_TOTAL_CREDITS);
      buyer.welcome_bonus_granted = true;
      buyer.welcome_bonus_credits = WELCOME_BONUS_TOTAL_CREDITS;
      logActivityEvent({
        member: buyer,
        action_type: 'WELCOME_BONUS_GRANTED',
        previous_expires_at: buyer.activity_expires_at || null,
        new_expires_at: buyer.activity_expires_at || null,
        description: `🎁 İlk Bayi Kaydı Hoşgeldin Bonusu: ${buyer.full_name} hesabına bir defaya mahsus 32+32 (Toplam ${WELCOME_BONUS_TOTAL_CREDITS}) Seans Kredisi otomatik tanımlandı.`,
      });
    }
    if (!skipCreditAddition) {
      buyer.session_credits += creditsAdded;
    }

    const currentPrice = buyer.highest_package_id
      ? PACKAGES[buyer.highest_package_id].defaultPrice
      : 0;
    if (pkgDef.defaultPrice >= currentPrice) {
      buyer.highest_package_id = normalizedPkg;
    }
  } else {
    creditsAdded = Math.max(1, Math.round(amount / 125));
    if (isInitialRegistrationSync && !buyer.welcome_bonus_granted) {
      creditsAdded = Math.max(creditsAdded, WELCOME_BONUS_TOTAL_CREDITS);
      buyer.welcome_bonus_granted = true;
      buyer.welcome_bonus_credits = WELCOME_BONUS_TOTAL_CREDITS;
    }
    if (!skipCreditAddition) {
      buyer.session_credits += creditsAdded;
    }
  }
  if (isInitialRegistrationSync && !skipCreditAddition) {
    creditsOwnedByServer.add(buyer.user_id);
  }

  // 2. Kişisel 30 Günlük Hacmi Güncelle:
  // UPDATE users SET personal_volume_30d = personal_volume_30d + $1 WHERE id = $2
  buyer.personal_volume = roundCurrency(buyer.personal_volume + amount);
  buyer.personal_volume_30d = roundCurrency((buyer.personal_volume_30d ?? 0) + amount);
  buyer.rolling_30d_personal_volume = roundCurrency(
    (buyer.rolling_30d_personal_volume ?? 0) + amount
  );

  const processedAt = new Date().toISOString();
  let activityExtended = false;
  if (!isInitialRegistrationSync) {
    const prevExp = buyer.activity_expires_at || null;
    const nowMs = Date.parse(processedAt);
    const prevExpMs = prevExp ? new Date(prevExp).getTime() : NaN;
    const baseTimeMs = !isNaN(prevExpMs) && prevExpMs > nowMs ? prevExpMs : nowMs;
    const nextExp = new Date(
      baseTimeMs + Math.max(1, ACTIVITY_PERIOD_DAYS) * 86400000
    ).toISOString();
    buyer.activity_expires_at = nextExp;
    buyer.is_active = true;
    activityExtended = true;
    logActivityEvent({
      member: buyer,
      action_type: 'PACKAGE_RENEWAL',
      previous_expires_at: prevExp,
      new_expires_at: nextExp,
      description: `Paket alımı (${orderId} · +${creditsAdded} Seans Kredisi · ${amount.toLocaleString(
        'tr-TR'
      )} $) ile aktiflik +${ACTIVITY_PERIOD_DAYS} gün uzatıldı.`,
    });
  }

  // 3. Recursive Unilevel Üst Sponsorların 30 Günlük Grup Cirosunu Güncelle:
  // WITH RECURSIVE uplines AS (
  //   SELECT id, sponsor_id FROM users WHERE id = $1
  //   UNION ALL
  //   SELECT u.id, u.sponsor_id FROM users u INNER JOIN uplines ON u.id = uplines.sponsor_id
  // )
  // UPDATE users SET group_volume_30d = group_volume_30d + $2 WHERE id IN (SELECT id FROM uplines);
  if (buyer.sponsor_id) {
    const visitedSponsorIds = new Set<string>();
    let cursorSponsorId: string | null = buyer.sponsor_id;
    while (cursorSponsorId && !visitedSponsorIds.has(cursorSponsorId)) {
      visitedSponsorIds.add(cursorSponsorId);
      const uplineSponsor = members.find((m) => m.user_id === cursorSponsorId);
      if (!uplineSponsor) break;
      uplineSponsor.group_volume_30d = roundCurrency(
        (uplineSponsor.group_volume_30d ?? 0) + amount
      );
      uplineSponsor.rolling_30d_pgv = roundCurrency(
        (uplineSponsor.rolling_30d_pgv ?? 0) + amount
      );
      cursorSponsorId = uplineSponsor.sponsor_id;
    }
  }

  for (const m of members) {
    if (m.global_line_id < buyer.global_line_id) {
      m.group_volume = roundCurrency(m.group_volume + amount);
    }
  }

  // 3.5. Kariyer Terfilerini ve "3 Getir Bedavaya Getir" (Fast-ROI +%15) kontrolünü komisyon dağıtımından hemen önce çalıştır
  // Böylece bu siparişle terfi eden üst liderler, yeni kariyerlerinin derinlik, Sonsuzluk (%2..%10) ve Eşleşme (%10..%25) haklarından anında yararlanır!
  const careerUpgrades = calculateActiveCareer(buyer.id);

  const nowIso = processedAt;
  const useClawbackPending = true;
  const clawbackDays = CLAWBACK_PROTECTION_DAYS;
  const clawbackReleaseAt = new Date(
    new Date(nowIso).getTime() + clawbackDays * 86400000
  ).toISOString();
  const txUnclaimedTransfers: UnclaimedCommissionRecord[] = [];

  const fundRate = SYSTEM_FUND_PERCENT / 100;
  const sponsorRate = DIRECT_SPONSOR_PERCENT / 100;

  // Sipariş bazında hangi bayinin ne kadar nakit komisyon kazandığını takip et (Revizyon 2: Matching Bonus için)
  const orderMemberEarnings = new Map<string, number>();
  const addOrderEarningForMatching = (m: MonolineMember, amt: number) => {
    if (amt <= 0) return;
    orderMemberEarnings.set(m.user_id, roundCurrency((orderMemberEarnings.get(m.user_id) || 0) + amt));
  };

  // 4. Sistem fonu aktarımı
  const systemFundBase = roundCurrency(amount * fundRate);
  systemWallet.system_pool_balance = roundCurrency(
    systemWallet.system_pool_balance + systemFundBase
  );
  logComm(
    orderId,
    buyer,
    null,
    'SYSTEM_POOL',
    null,
    systemFundBase,
    'RELEASED',
    nowIso,
    nowIso,
    'system_wallet (system_pool_balance)'
  );

  let unclaimedOverflow = 0;

  // 5. HAVUZ 2: %20 Direkt Sponsor Primi (Bekleyen Bakiye - 14 Gün)
  const directSponsorCalculated = roundCurrency(amount * sponsorRate);
  let sponsorPaid = 0;
  let sponsorRedirected = 0;
  let sponsorReasonCode: UnclaimedTransferReasonCode | 'PAID' = 'PAID';
  let sponsorNote = '';
  let sponsorMember: MonolineMember | undefined;

  if (buyer.sponsor_id) {
    sponsorMember = members.find((m) => m.user_id === buyer.sponsor_id);
  }

  if (sponsorMember && sponsorMember.is_active && !sponsorMember.is_locked) {
    sponsorPaid = directSponsorCalculated;
    creditMemberWallet(sponsorMember, 'SPONSOR', sponsorPaid, useClawbackPending, buyerRegion);
    sponsorReasonCode = 'PAID';
    sponsorNote = useClawbackPending
      ? `Direkt sponsor (${sponsorMember.full_name}) bölgesel bekleyen USD bakiyesine (${clawbackDays} Gün Cayma Korumalı) %${DIRECT_SPONSOR_PERCENT} eklendi.`
      : `Direkt sponsor (${sponsorMember.full_name}) bölgesel USD cüzdanına %${DIRECT_SPONSOR_PERCENT} anında eklendi.`;

    logComm(
      orderId,
      buyer,
      sponsorMember,
      'SPONSOR',
      null,
      sponsorPaid,
      isFraudFlagged ? 'FRAUD_REVIEW' : useClawbackPending ? 'PENDING_14D' : 'RELEASED',
      useClawbackPending ? clawbackReleaseAt : nowIso,
      nowIso
    );

    if (v2ArchitectureConfig.whatsapp_business_push_enabled !== false) {
      enqueueNotification({
        member: sponsorMember,
        channel: 'WHATSAPP',
        trigger_type: 'SPONSOR_COMMISSION_EARNED',
        order_amount: amount,
        commission_amount: sponsorPaid,
        buyer_name: buyer.full_name,
        message: `Tebrikler Sayın ${sponsorMember.full_name}! Ekibinizden ${amount.toLocaleString(
          'tr-TR'
        )} $'lik yeni paket satışı (${buyer.full_name}) gerçekleşti. Hesabınıza ${sponsorPaid.toLocaleString(
          'tr-TR',
          { minimumFractionDigits: 2 }
        )} $ Sponsor Primi tanımlandı.`,
      });
    }
  } else {
    sponsorRedirected = directSponsorCalculated;
    unclaimedOverflow = roundCurrency(unclaimedOverflow + sponsorRedirected);
    sponsorReasonCode = sponsorMember ? 'POOL_TRANSFER_INACTIVE' : 'POOL_TRANSFER_NO_SPONSOR';
    sponsorNote = sponsorMember
      ? `[${sponsorReasonCode}] Sponsor (${sponsorMember.full_name}) pasif/kilitli olduğu için tutar system_wallet.unclaimed_pool_balance hesabına aktarıldı.`
      : `[${sponsorReasonCode}] Üye kurucu/kök düğüm olduğu için (sponsor yok) tutar system_wallet.unclaimed_pool_balance hesabına aktarıldı.`;

    logComm(
      orderId,
      buyer,
      sponsorMember || null,
      'SPONSOR',
      null,
      sponsorRedirected,
      sponsorReasonCode,
      nowIso,
      nowIso
    );

    const unclaimedSponsorRec: UnclaimedCommissionRecord = {
      id: nextUnclaimedCommissionId++,
      order_id: orderId,
      source_user_id: buyer.id,
      source_external_id: buyer.user_id,
      source_user_name: buyer.full_name,
      intended_user_id: sponsorMember ? sponsorMember.id : null,
      intended_external_id: sponsorMember ? sponsorMember.user_id : null,
      intended_user_name: sponsorMember ? sponsorMember.full_name : null,
      intended_monoline_position: sponsorMember ? sponsorMember.global_line_id : null,
      commission_type: 'SPONSOR',
      depth_level: null,
      amount: sponsorRedirected,
      reason_code: sponsorReasonCode,
      reason_detail: sponsorNote,
      member_max_career_level: sponsorMember?.max_career_level || sponsorMember?.career_level,
      member_active_career_level: sponsorMember?.active_career_level || sponsorMember?.career_level,
      created_at: nowIso,
    };
    unclaimedCommissions.unshift(unclaimedSponsorRec);
    txUnclaimedTransfers.push(unclaimedSponsorRec);
  }

  // 6. HAVUZ 3: %25 Monoline 7 Derinlik Dağıtımı (%7, %5, %4, %3, %2, %2, %2) + 2️⃣ HİBRİT DİNAMİK SIKIŞTIRMA (DYNAMIC COMPRESSION)
  const allUplineCandidates = members
    .filter((m) => m.global_line_id < buyer.global_line_id)
    .sort((a, b) => b.global_line_id - a.global_line_id);

  const compressionMode =
    v2ArchitectureConfig.dynamic_compression_enabled === false
      ? 'FUND_SWEEP'
      : v2ArchitectureConfig.dynamic_compression_mode || 'FULL_COMPRESSION';
  const useDynamicCompression = compressionMode !== 'FUND_SWEEP';
  const uplinePayouts: DepthPayoutDetail[] = [];
  const compressedSkippedMembers: NonNullable<CommissionTransaction['compressed_skipped_members']> = [];
  let totalDistributedToUpline = 0;
  let candidateCursor = 0;

  for (let d = 1; d <= 7; d++) {
    const pct = MONOLINE_DEPTH_PERCENTAGES[d - 1];
    const rate = pct / 100;
    const rawCalcAmount = roundCurrency(amount * rate);
    let calcAmount = rawCalcAmount;

    let uplineMember: MonolineMember | undefined;
    let skippedAtThisDepth = false;

    if (useDynamicCompression) {
      // 2️⃣ Dinamik Sıkıştırma (FULL_COMPRESSION veya HYBRID_50_50):
      // Aradaki pasif (is_active = false) veya kariyer yetkisi yetmeyen bayiler atlanarak
      // komisyon hakkı olan ilk uygun aktif lidere (%100 veya %50 Hibrit) aktarılır!
      while (candidateCursor < allUplineCandidates.length) {
        const candidate = allUplineCandidates[candidateCursor++];
        const candCareer = v2ArchitectureConfig.use_dynamic_active_career
          ? candidate.active_career_level ?? candidate.career_level
          : candidate.career_level;
        const candActive = candidate.is_active && !candidate.is_locked;
        const candEligible = candActive && (!lockActive || candCareer >= d);
        if (candEligible) {
          uplineMember = candidate;
          break;
        } else {
          skippedAtThisDepth = true;
          compressedSkippedMembers.push({
            user_id: candidate.user_id,
            full_name: candidate.full_name,
            global_line_id: candidate.global_line_id,
            career_level: candCareer,
            reason: !candActive
              ? `${d}. Derinlik için pasif/kilitli olduğu için Dinamik Sıkıştırma (${compressionMode}) ile atlandı.`
              : `${d}. Derinlik için kariyer yetkisi (${candCareer} < ${d}) yetmediğinden Dinamik Sıkıştırma (${compressionMode}) ile üstteki aktif lidere sıkıştırıldı.`,
          });
          if (v2ArchitectureConfig.fomo_48h_countdown_enabled !== false) {
            const fomoMsg = `⚠️ DİKKAT: Alt/Üst hattınızda (${buyer.full_name}) ${rawCalcAmount.toLocaleString(
              'tr-TR'
            )} $ komisyon oluştu! Aktiflik sürenizin bitmesine 48 saat kaldı. Aktifliğinizi/kariyer yetkinizi yenilemezseniz bu tutar Sistem Havuzuna devredilecektir.`;
            fomoCountdownAlerts.unshift({
              id: nextFomoAlertId++,
              user_id: candidate.id,
              external_user_id: candidate.user_id,
              user_full_name: candidate.full_name,
              source_order_id: orderId,
              source_buyer_name: buyer.full_name,
              source_order_amount: amount,
              at_risk_commission_amount: rawCalcAmount,
              depth_level: d,
              reason: !candActive ? 'INACTIVE_EXPIRED' : 'INSUFFICIENT_CAREER_DEPTH',
              warning_message: fomoMsg,
              expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
              remaining_seconds: 48 * 3600,
              status: 'COUNTDOWN_ACTIVE_48H',
              created_at: nowIso,
            });
          }
        }
      }
      // Hibrit %50-%50 Modunda: Atlanan üye varsa komisyonun %50'si Fona devredilir, %50'si üstteki aktif lidere ödenir
      if (skippedAtThisDepth && compressionMode === 'HYBRID_50_50' && uplineMember) {
        const halfToPool = roundCurrency(rawCalcAmount * 0.5);
        calcAmount = roundCurrency(rawCalcAmount - halfToPool);
        unclaimedOverflow = roundCurrency(unclaimedOverflow + halfToPool);
      }
    } else {
      uplineMember = allUplineCandidates[d - 1];
    }

    if (!uplineMember) {
      unclaimedOverflow = roundCurrency(unclaimedOverflow + calcAmount);
      const noUserDetail = `[POOL_TRANSFER_NO_UPLINE] ${d}. Üst derinlik için uygun üst üye bulunmadığından system_wallet.unclaimed_pool_balance hesabına aktarıldı.`;

      logComm(
        orderId,
        buyer,
        null,
        'MONOLINE_DEPTH',
        d,
        calcAmount,
        'POOL_TRANSFER_NO_UPLINE',
        nowIso,
        nowIso
      );

      const unclaimedRec: UnclaimedCommissionRecord = {
        id: nextUnclaimedCommissionId++,
        order_id: orderId,
        source_user_id: buyer.id,
        source_external_id: buyer.user_id,
        source_user_name: buyer.full_name,
        intended_user_id: null,
        intended_external_id: null,
        intended_user_name: null,
        intended_monoline_position: null,
        commission_type: 'MONOLINE_DEPTH',
        depth_level: d,
        amount: calcAmount,
        reason_code: 'POOL_TRANSFER_NO_UPLINE',
        reason_detail: noUserDetail,
        created_at: nowIso,
      };
      unclaimedCommissions.unshift(unclaimedRec);
      txUnclaimedTransfers.push(unclaimedRec);

      uplinePayouts.push({
        depth: d,
        rate_percent: pct,
        calculated_amount: calcAmount,
        recipient_user_id: null,
        recipient_name: null,
        recipient_global_line_id: null,
        recipient_career_level: 0,
        recipient_career_title: 'Yok',
        recipient_unlocked_depth: 0,
        status: 'TRANSFERRED_TO_POOL_NO_UPLINE',
        transfer_reason_code: 'POOL_TRANSFER_NO_UPLINE',
        status_reason: noUserDetail,
      });
      continue;
    }

    const effectiveActiveCareer = v2ArchitectureConfig.use_dynamic_active_career
      ? uplineMember.active_career_level ?? uplineMember.career_level
      : uplineMember.career_level;
    const effectiveActiveTitle = v2ArchitectureConfig.use_dynamic_active_career
      ? uplineMember.active_career_title ?? uplineMember.career_title
      : uplineMember.career_title;

    const isActiveDealer = uplineMember.is_active && !uplineMember.is_locked;
    const isEligible = isActiveDealer && (!lockActive || effectiveActiveCareer >= d);

    if (isEligible) {
      creditMemberWallet(uplineMember, 'MONOLINE_DEPTH', calcAmount, useClawbackPending, buyerRegion);
      addOrderEarningForMatching(uplineMember, calcAmount);
      totalDistributedToUpline = roundCurrency(totalDistributedToUpline + calcAmount);

      logComm(
        orderId,
        buyer,
        uplineMember,
        'MONOLINE_DEPTH',
        d,
        calcAmount,
        isFraudFlagged ? 'FRAUD_REVIEW' : useClawbackPending ? 'PENDING_14D' : 'RELEASED',
        useClawbackPending ? clawbackReleaseAt : nowIso,
        nowIso
      );

      enqueueNotification({
        member: uplineMember,
        channel: 'WHATSAPP',
        trigger_type: 'DEPTH_COMMISSION_EARNED',
        message: `Tebrikler! Alt ekibinizden (${buyer.full_name} · ${d}. Derinlik${useDynamicCompression ? ' · Dinamik Sıkıştırmalı' : ''}) ${calcAmount.toLocaleString(
          'tr-TR',
          { minimumFractionDigits: 2 }
        )} $ Monoline Derinlik Komisyonu kazandınız!`,
      });

      uplinePayouts.push({
        depth: d,
        rate_percent: pct,
        calculated_amount: calcAmount,
        recipient_user_id: uplineMember.user_id,
        recipient_name: uplineMember.full_name,
        recipient_global_line_id: uplineMember.global_line_id,
        recipient_career_level: effectiveActiveCareer,
        recipient_career_title: effectiveActiveTitle,
        recipient_max_career_level: uplineMember.max_career_level || uplineMember.career_level,
        recipient_max_career_title: uplineMember.max_career_title || uplineMember.career_title,
        recipient_active_career_level: effectiveActiveCareer,
        recipient_active_career_title: effectiveActiveTitle,
        recipient_unlocked_depth: uplineMember.unlocked_depth,
        status: 'PAID_TO_MEMBER',
        transfer_reason_code: 'PAID',
        status_reason: useClawbackPending
          ? `${effectiveActiveTitle} (active_career_level ${effectiveActiveCareer} >= ${d}. Derinlik${useDynamicCompression ? ' · Dinamik Sıkıştırma' : ''}) ile bölgesel bekleyen USD (${clawbackDays} Gün Koruma) hesabına aktarıldı.`
          : `${effectiveActiveTitle} (active_career_level ${effectiveActiveCareer} >= ${d}. Derinlik) ile cüzdana ödendi.`,
      });
    } else {
      unclaimedOverflow = roundCurrency(unclaimedOverflow + calcAmount);
      const isInactiveOrLocked = !isActiveDealer;
      const reasonCode: UnclaimedTransferReasonCode = isInactiveOrLocked
        ? 'POOL_TRANSFER_INACTIVE'
        : 'POOL_TRANSFER_NO_YETKI';

      const reason = !uplineMember.is_active
        ? `[POOL_TRANSFER_INACTIVE] Üye (${uplineMember.full_name}) aktifliği olmadığı için ${d}. Derinlik payı unclaimed_pool_balance hesabına aktarıldı.`
        : uplineMember.is_locked
        ? `[POOL_TRANSFER_INACTIVE] Üye (${uplineMember.full_name}) hesabı kilitli olduğundan ${d}. Derinlik payı unclaimed_pool_balance hesabına aktarıldı.`
        : `[POOL_TRANSFER_NO_YETKI] Dönemsel Hak Ediş Yetkisi: Üye (${uplineMember.full_name}) max_career_level: ${
            uplineMember.max_career_level || uplineMember.career_level
          }, active_career_level: ${effectiveActiveCareer} < ${d} olduğu için ${d}. Derinlik payı unclaimed_pool_balance hesabına aktarıldı.`;

      logComm(
        orderId,
        buyer,
        uplineMember,
        'MONOLINE_DEPTH',
        d,
        calcAmount,
        reasonCode,
        nowIso,
        nowIso
      );

      const unclaimedRec: UnclaimedCommissionRecord = {
        id: nextUnclaimedCommissionId++,
        order_id: orderId,
        source_user_id: buyer.id,
        source_external_id: buyer.user_id,
        source_user_name: buyer.full_name,
        intended_user_id: uplineMember.id,
        intended_external_id: uplineMember.user_id,
        intended_user_name: uplineMember.full_name,
        intended_monoline_position: uplineMember.global_line_id,
        commission_type: 'MONOLINE_DEPTH',
        depth_level: d,
        amount: calcAmount,
        reason_code: reasonCode,
        reason_detail: reason,
        member_max_career_level: uplineMember.max_career_level || uplineMember.career_level,
        member_active_career_level: effectiveActiveCareer,
        created_at: nowIso,
      };
      unclaimedCommissions.unshift(unclaimedRec);
      txUnclaimedTransfers.push(unclaimedRec);

      uplinePayouts.push({
        depth: d,
        rate_percent: pct,
        calculated_amount: calcAmount,
        recipient_user_id: uplineMember.user_id,
        recipient_name: uplineMember.full_name,
        recipient_global_line_id: uplineMember.global_line_id,
        recipient_career_level: effectiveActiveCareer,
        recipient_career_title: effectiveActiveTitle,
        recipient_max_career_level: uplineMember.max_career_level || uplineMember.career_level,
        recipient_max_career_title: uplineMember.max_career_title || uplineMember.career_title,
        recipient_active_career_level: effectiveActiveCareer,
        recipient_active_career_title: effectiveActiveTitle,
        recipient_unlocked_depth: uplineMember.unlocked_depth,
        status: isInactiveOrLocked
          ? 'TRANSFERRED_TO_POOL_INACTIVE'
          : 'TRANSFERRED_TO_POOL_CAREER_LOCK',
        transfer_reason_code: reasonCode,
        status_reason: reason,
      });
    }
  }

  // ============================================================================
  // 7. V2.2 REVİZYON 1: UNILEVEL SONSUZLUK BONUSU (%10 LİDERLİK FARK PRİMİ)
  // 4. Mutmainne: +%2 | 5. Râziye: +%4 | 6. Marziyye: +%7 | 7. Kâmile (Sâfiye): +%10
  // (Araya giren alt liderin payı düşülerek 8., 50., 100. derinlik dahil sonsuz derinlikten akar!)
  // ============================================================================
  const unilevelInfinityPayouts: NonNullable<CommissionTransaction['unilevel_infinity_payouts']> = [];
  let totalInfinityDistributed = 0;

  if (v2ArchitectureConfig.unilevel_infinity_enabled !== false && buyer.sponsor_id) {
    let highestPaidInfinityPercent = 0;
    const maxInfinityCap = distributionParams.unilevel_infinity_max_percent ?? 10;
    const visitedSponsors = new Set<string>([buyer.user_id]);
    let currSponsorId: string | null = buyer.sponsor_id;
    let generation = 1;

    while (
      currSponsorId &&
      !visitedSponsors.has(currSponsorId) &&
      highestPaidInfinityPercent < maxInfinityCap
    ) {
      visitedSponsors.add(currSponsorId);
      const uplineSponsor = members.find((m) => m.user_id === currSponsorId);
      if (!uplineSponsor) break;

      const sponsorCareer = v2ArchitectureConfig.use_dynamic_active_career
        ? uplineSponsor.active_career_level ?? uplineSponsor.career_level
        : uplineSponsor.career_level;
      const sponsorTitle = v2ArchitectureConfig.use_dynamic_active_career
        ? uplineSponsor.active_career_title ?? uplineSponsor.career_title
        : uplineSponsor.career_title;

      const infRule = UNILEVEL_INFINITY_RULES.find((r) => r.career_level === sponsorCareer);
      const memberInfPct = infRule ? infRule.infinity_bonus_percent : 0;

      if (
        uplineSponsor.is_active &&
        !uplineSponsor.is_locked &&
        memberInfPct > highestPaidInfinityPercent
      ) {
        const diffPct = roundCurrency(
          Math.min(maxInfinityCap, memberInfPct) - highestPaidInfinityPercent
        );
        if (diffPct > 0) {
          const infAmount = roundCurrency(amount * (diffPct / 100));
          creditMemberWallet(uplineSponsor, 'UNILEVEL_INFINITY', infAmount, useClawbackPending, buyerRegion);
          totalInfinityDistributed = roundCurrency(totalInfinityDistributed + infAmount);
          highestPaidInfinityPercent = roundCurrency(highestPaidInfinityPercent + diffPct);

          logComm(
            orderId,
            buyer,
            uplineSponsor,
            'UNILEVEL_INFINITY',
            generation,
            infAmount,
            isFraudFlagged ? 'FRAUD_REVIEW' : useClawbackPending ? 'PENDING_14D' : 'RELEASED',
            useClawbackPending ? clawbackReleaseAt : nowIso,
            nowIso
          );

          unilevelInfinityPayouts.push({
            recipient_user_id: uplineSponsor.user_id,
            recipient_name: uplineSponsor.full_name,
            career_level: sponsorCareer,
            career_title: sponsorTitle,
            unilevel_generation: generation,
            member_infinity_percent: memberInfPct,
            differential_percent: diffPct,
            amount_paid: infAmount,
          });
        }
      }

      currSponsorId = uplineSponsor.sponsor_id;
      generation++;
    }
  }

  // ============================================================================
  // 8. V2.2 REVİZYON 2: LİDERLİK EŞLEŞME BONUSU (MATCHING BONUS %10..%25)
  // 3. Mülhime (%10) | 4. Mutmainne (%15) | 5. Râziye (%20) | 6. Marziyye & 7. Kâmile (%25)
  // Bizzat sponsor olunan (1. nesil) bayilerin bu siparişte kazandığı nakit komisyonlar üzerinden ödenir!
  // ============================================================================
  const matchingBonusPayouts: NonNullable<CommissionTransaction['matching_bonus_payouts']> = [];
  let totalMatchingDistributed = 0;

  if (v2ArchitectureConfig.matching_bonus_enabled !== false) {
    for (const [earnerUserId, earnerCommission] of orderMemberEarnings.entries()) {
      if (earnerCommission <= 0) continue;
      const earnerMember = members.find((m) => m.user_id === earnerUserId);
      if (!earnerMember || !earnerMember.sponsor_id) continue;

      const upperSponsor = members.find((m) => m.user_id === earnerMember.sponsor_id);
      if (!upperSponsor || !upperSponsor.is_active || upperSponsor.is_locked) continue;

      const upperCareer = v2ArchitectureConfig.use_dynamic_active_career
        ? upperSponsor.active_career_level ?? upperSponsor.career_level
        : upperSponsor.career_level;
      const upperTitle = v2ArchitectureConfig.use_dynamic_active_career
        ? upperSponsor.active_career_title ?? upperSponsor.career_title
        : upperSponsor.career_title;

      const matchRule = UNILEVEL_INFINITY_RULES.find((r) => r.career_level === upperCareer);
      const matchPct = matchRule ? matchRule.matching_bonus_percent : 0;

      if (matchPct > 0) {
        const matchAmount = roundCurrency(earnerCommission * (matchPct / 100));
        if (matchAmount > 0) {
          creditMemberWallet(upperSponsor, 'MATCHING_BONUS', matchAmount, useClawbackPending);
          totalMatchingDistributed = roundCurrency(totalMatchingDistributed + matchAmount);

          logComm(
            orderId,
            earnerMember,
            upperSponsor,
            'MATCHING_BONUS',
            1,
            matchAmount,
            isFraudFlagged ? 'FRAUD_REVIEW' : useClawbackPending ? 'PENDING_14D' : 'RELEASED',
            useClawbackPending ? clawbackReleaseAt : nowIso,
            nowIso
          );

          matchingBonusPayouts.push({
            sponsor_user_id: upperSponsor.user_id,
            sponsor_name: upperSponsor.full_name,
            sponsor_career_level: upperCareer,
            sponsor_career_title: upperTitle,
            downline_user_id: earnerMember.user_id,
            downline_name: earnerMember.full_name,
            downline_commission_earned: earnerCommission,
            matching_percent: matchPct,
            amount_paid: matchAmount,
          });
        }
      }
    }
  }

  const totalAddedToFund = roundCurrency(systemFundBase + unclaimedOverflow);
  addSystemPoolBalance(totalAddedToFund);

  // SQL Table 3: system_wallet.unclaimed_pool_balance (Yetkisizlik/Pasiflikten/Üstte Üye Yokluğundan Devredenler)
  systemWallet.unclaimed_pool_balance = roundCurrency(
    systemWallet.unclaimed_pool_balance + unclaimedOverflow
  );
  systemWallet.updated_at = nowIso;

  // SQL Table 5: orders_log (Sipariş Hareketleri & Cayma/İade Takip Tablosu)
  const existingOrderLog = ordersLog.find((o) => o.order_id === orderId);
  if (existingOrderLog) {
    existingOrderLog.user_id = buyer.id;
    existingOrderLog.external_user_id = buyer.user_id;
    existingOrderLog.user_full_name = buyer.full_name;
    existingOrderLog.package_id = normalizedPkg || String(payload.package_id || 'CUSTOM');
    existingOrderLog.amount = amount;
    existingOrderLog.status = isFraudFlagged ? 'FRAUD_REVIEW' : 'COMPLETED';
    existingOrderLog.client_ip = clientIp;
  } else {
    ordersLog.unshift({
      order_id: orderId,
      user_id: buyer.id,
      external_user_id: buyer.user_id,
      user_full_name: buyer.full_name,
      package_id: normalizedPkg || String(payload.package_id || 'CUSTOM'),
      amount,
      status: isFraudFlagged ? 'FRAUD_REVIEW' : 'COMPLETED',
      client_ip: clientIp,
      created_at: nowIso,
    });
  }

  const bullmqJobId = `BULLMQ-JOB-${Date.now().toString().slice(-6)}-${Math.floor(
    Math.random() * 90 + 10
  )}`;

  const tx: CommissionTransaction = {
    transaction_id: `TX-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`,
    order_id: orderId,
    buyer_user_id: buyer.user_id,
    buyer_name: buyer.full_name,
    buyer_global_line_id: buyer.global_line_id,
    package_id: normalizedPkg ? PACKAGES[normalizedPkg].name : payload.package_id || 'Özel Sipariş',
    session_credits_added: creditsAdded,
    order_amount: amount,
    timestamp: nowIso,
    order_type: isActivationOrder ? 'ACTIVATION' : isActivityRenewalOrder ? 'ACTIVITY_RENEWAL' : 'STANDARD_ORDER',
    activity_extended: activityExtended,
    enforce_career_depth_lock: lockActive,
    clawback_status: isFraudFlagged
      ? 'FRAUD_REVIEW'
      : useClawbackPending
      ? 'PENDING_14D'
      : 'RELEASED_TO_BALANCE',
    clawback_release_at: useClawbackPending ? clawbackReleaseAt : nowIso,
    refunded_at: null,
    bullmq_job_id: bullmqJobId,
    fraud_flagged: isFraudFlagged,
    fraud_reason: fraudReason,
    system_fund_base_amount: systemFundBase,
    system_fund_unclaimed_overflow: unclaimedOverflow,
    system_fund_total_added: totalAddedToFund,
    direct_sponsor: {
      sponsor_user_id: sponsorMember ? sponsorMember.user_id : null,
      sponsor_name: sponsorMember ? sponsorMember.full_name : null,
      sponsor_global_line_id: sponsorMember ? sponsorMember.global_line_id : null,
      rate_percent: DIRECT_SPONSOR_PERCENT,
      amount_paid: sponsorPaid,
      redirected_to_pool: sponsorRedirected,
      reason_code: sponsorReasonCode,
      note: sponsorNote,
    },
    monoline_upline_payouts: uplinePayouts,
    unilevel_infinity_payouts: unilevelInfinityPayouts,
    matching_bonus_payouts: matchingBonusPayouts,
    compressed_skipped_members: compressedSkippedMembers,
    unclaimed_transfers: txUnclaimedTransfers,
    total_distributed_to_upline: totalDistributedToUpline,
    total_infinity_distributed: totalInfinityDistributed,
    total_matching_distributed: totalMatchingDistributed,
    career_upgrades_triggered: careerUpgrades,
  };

  transactions.unshift(tx);

  // Sponsor için "3 Getir Bedavaya Getir" (Fast-ROI +%15) kontrolünü tetikle
  if (sponsorMember) {
    awardFastStartBonusIfQualified(sponsorMember);
  }

  const processingMs = Math.max(4, Date.now() - startMs + Math.floor(Math.random() * 10));

  // V2.0 BullMQ / Redis Async Queue Job Record (const commissionQueue = new Queue('commission-processing', { connection: redisConfig }))
  queueJobs.unshift({
    job_id: bullmqJobId,
    queue_name: 'commission-processing',
    job_name: 'process-commission',
    order_id: orderId,
    user_id: buyer.user_id,
    order_amount: amount,
    status: 'COMPLETED',
    worker_id: `bullmq-worker-0${(queueJobs.length % 4) + 1}`,
    redis_lock_key: `redis:lock:monoline:order:${orderId}`,
    attempts_made: 1,
    max_attempts: 3,
    backoff_ms: 5000,
    enqueued_at: nowIso,
    completed_at: new Date().toISOString(),
    processing_ms: processingMs,
    result_summary: `process-commission (attempts: 3, backoff: 5000ms) → SPONSOR: +${sponsorPaid} $ · 7-DERİNLİK: +${totalDistributedToUpline} $ · SİSTEM FONU: +${totalAddedToFund} $ (${
      useClawbackPending ? `${clawbackDays}G Pending Clawback` : 'Anında Balance'
    })`,
  });

  webhookLogs.unshift({
    id: `WH-${Date.now().toString().slice(-5)}-${Math.floor(Math.random() * 90 + 10)}`,
    endpoint: 'POST /api/v1/integrations/order-commission',
    http_status: 200,
    status: 'SUCCESS',
    order_id: orderId,
    user_id: buyer.user_id,
    order_amount: amount,
    payload_json: JSON.stringify(payload),
    response_message: `200 OK — Sipariş kuyruğa alındı ve işleniyor. (Queue: commission-processing / Job: process-commission / ${bullmqJobId}) — SYSTEM_POOL: +${totalAddedToFund} $ · SPONSOR: +${sponsorPaid} $ · MONOLINE_DEPTH: +${totalDistributedToUpline} $`,
    processing_ms: processingMs,
    created_at: nowIso,
  });

  return tx;
}

function resetToCleanSlate(includeAdmin = true) {
  creditsOwnedByServer.clear();
  memberCredentials.clear();
  careerTiers = structuredClone(INITIAL_CAREER_TIERS);
  distributionParams = {
    system_fund_percent: SYSTEM_FUND_PERCENT,
    direct_sponsor_percent: DIRECT_SPONSOR_PERCENT,
    monoline_total_percent: 25,
    depth_percentages: [...MONOLINE_DEPTH_PERCENTAGES],
    unilevel_infinity_max_percent: 10,
    fast_roi_bonus_percent: 15,
    career_pool_percent: 5,
  };
  transactions = [];
  commissionLogs = [];
  ordersLog = [];
  walletTransactions = [];
  systemWallet = {
    id: 1,
    system_pool_balance: 0,
    unclaimed_pool_balance: 0,
    updated_at: new Date().toISOString(),
  };
  unclaimedCommissions = [];
  queueJobs = [];
  withdrawalRequests = [];
  userRewardsLog = [];
  notificationOutbox = [];
  fraudAlerts = [];
  ipActivityEvents = [];
  webhookLogs = [];
  cronLogs = [];
  poolDistributions = [];
  processedOrderIds = new Set();
  idempotentBlockedCount = 0;
  systemCareerFundBalance = 0;
  systemCareerFundCumulative = 0;
  enforceCareerDepthLock = true;
  nextCommissionLogId = 1;
  nextUnclaimedCommissionId = 1;
  nextWithdrawalId = 1;
  nextWalletTransactionId = 1;
  nextActivityLogId = 1;
  nextRewardLogId = 1;
  nextNotificationId = 1;
  nextFraudAlertId = 1;
  activityLogs = [];
  members = includeAdmin
    ? [
        {
          id: 1,
          user_id: 'USR-ADMIN',
          full_name: 'Sistem Yöneticisi',
          email: 'psikologabdulkadirkan@gmail.com',
          city: 'İstanbul',
          sponsor_id: null,
          sponsor_db_id: null,
          global_line_id: 1,
          package_id: 'PKG_PLATIN_KLINIK',
          career_level: 1,
          career_title: 'Emmâre',
          session_credits: 1000,
          is_active: true,
          is_locked: false,
          personal_volume: 0,
          group_volume: 0,
          active_direct_referrals: 0,
          ref_code: 'AURA-BAYI-AKN01',
          wallets: {
            direct_commission_wallet: 0,
            monoline_commission_wallet: 0,
            unilevel_infinity_wallet: 0,
            career_pool_wallet: 0,
            fast_roi_wallet: 0,
            pending_clawback_wallet: 0,
            total_earned: 0,
            total_withdrawn: 0,
            sponsor_wallet: 0,
            monoline_wallet: 0,
            infinity_wallet: 0,
            matching_wallet: 0,
            total_earnings: 0,
          },
          bank_details: {
            bank_name: 'Ziraat Bankası',
            iban: 'TR32 0001 0000 0000 0077 5122 01',
            iban_holder_name: 'Sistem Yöneticisi',
            trc20_address: '',
            preferred_method: 'IBAN',
          },
          two_factor: {
            enabled: false,
            secret_key: 'JBSWY3DPEHPK3P1',
            verified_at: null,
            backup_codes: ['NF-1-A1', 'NF-1-B2', 'NF-1-C3', 'NF-1-D4'],
          },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          activity_expires_at: createFutureExpiryIso(),
        } as any,
      ]
    : [];
}

function seedInitialData(emptyOnly = true) {
  resetToCleanSlate(true);
  if (!emptyOnly) {
    runFullCareerJourneySimulation();
  }
}

// ============================================================================
// İLK ÜYEDEN (1. KARİYER EMMÂRE) SON KARİYERE (7. KARİYER KÂMİLE / SÂFİYE)
// UÇTAN UCA SİMÜLASYON MOTORU (GERÇEK KAYITLAR, SİPARİŞLER, KOMİSYONLAR & HAVUZ)
// ============================================================================
function runFullCareerJourneySimulation() {
  const baseMs = Date.now() - 10 * 86400000; // Son 10 gün içinde (Rolling 30-Day PGV penceresinde)

  const simNodes: Array<{
    user_id: string;
    full_name: string;
    city: string;
    sponsor_id: string | null;
    package_id: Exclude<PackageId, 'CUSTOM'>;
    order_amount: number;
    has_tax_company?: boolean;
    tc_identity_no?: string;
    bank_name?: string;
    iban?: string;
  }> = [
    // 1. KÖK LİDER (Hedef: 7. Kariyer Kâmile / Sâfiye — PV: 50.000 $, 7 Aktif Kol, PGV: 1.730.000 $, 2x Râziye + 2x Mutmainne)
    {
      user_id: 'USR-1001',
      full_name: 'Dr. Selim Karahan',
      city: 'İstanbul',
      sponsor_id: null,
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 50000,
      has_tax_company: true,
      tc_identity_no: '14892037462',
      bank_name: 'Garanti BBVA',
      iban: 'TR320006200010010006298001',
    },

    // #1'İN 7 DİREKT REFERANS KOLU (#2 .. #8):
    // Kol 1 Lideri -> Hedef: 6. Kariyer Marziyye (Mardiyye)
    {
      user_id: 'USR-1002',
      full_name: 'Uzm. Zeynep Aydın',
      city: 'Ankara',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
      has_tax_company: false,
      tc_identity_no: '28491029384',
      bank_name: 'Türkiye İş Bankası',
      iban: 'TR540006400000112345678002',
    },
    // Kol 2 Lideri -> Hedef: 5. Kariyer Râziye
    {
      user_id: 'USR-1003',
      full_name: 'Emre Soylu',
      city: 'İzmir',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_ALTIN_DANISMAN',
      order_amount: 25000,
      has_tax_company: false,
      tc_identity_no: '39104827560',
      bank_name: 'QNB Finansbank',
      iban: 'TR710011100000000098765003',
    },
    // Kol 3 Lideri -> Hedef: 4. Kariyer Mutmainne
    {
      user_id: 'USR-1004',
      full_name: 'Selin Arslan',
      city: 'Bursa',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_GUMUS_PLUS',
      order_amount: 20000,
      has_tax_company: true,
      tc_identity_no: '45201938472',
      bank_name: 'Akbank',
      iban: 'TR190004600110888000123004',
    },
    // Kol 4 Lideri -> Hedef: 4. Kariyer Mutmainne
    {
      user_id: 'USR-1005',
      full_name: 'Kerem Çelik',
      city: 'Antalya',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_GUMUS_PLUS',
      order_amount: 20000,
      has_tax_company: false,
      tc_identity_no: '51928374650',
      bank_name: 'Yapı Kredi',
      iban: 'TR880006701000000054321005',
    },
    // Kol 5 Lideri -> Hedef: 3. Kariyer Mülhime
    {
      user_id: 'USR-1006',
      full_name: 'Derya Korkmaz',
      city: 'Adana',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
      has_tax_company: false,
      tc_identity_no: '62839401928',
      bank_name: 'Ziraat Bankası',
      iban: 'TR440001000123456789012006',
    },
    // Kol 6 Lideri -> Hedef: 2. Kariyer Levvâme
    {
      user_id: 'USR-1007',
      full_name: 'Caner Özkan',
      city: 'Kocaeli',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
      has_tax_company: false,
      tc_identity_no: '73910284756',
      bank_name: 'Garanti BBVA',
      iban: 'TR600006200010010006298007',
    },
    // Kol 7 Lideri -> Hedef: 1. Kariyer Emmâre
    {
      user_id: 'USR-1008',
      full_name: 'Aslıhan Güler',
      city: 'Eskişehir',
      sponsor_id: 'USR-1001',
      package_id: 'PKG_MINI_DENEME',
      order_amount: 5000,
      has_tax_company: false,
      tc_identity_no: '84019283746',
      bank_name: 'VakıfBank',
      iban: 'TR120001500158007290123008',
    },

    // ========================================================================
    // KOL 1 ALT AĞACI (USR-1002 Zeynep Aydın -> 6. Kariyer Marziyye için 6 Aktif Kol: 2x Mutmainne + 1x Mülhime + 3 Aktif Kol, PGV: 785.000 $)
    // ========================================================================
    {
      user_id: 'USR-1009',
      full_name: 'Burak Demir (Kol-1A Mutmainne)',
      city: 'Ankara',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_GUMUS_PLUS',
      order_amount: 20000,
    },
    {
      user_id: 'USR-1010',
      full_name: 'Elif Yalçın (Kol-1B Mutmainne)',
      city: 'İstanbul',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_GUMUS_PLUS',
      order_amount: 20000,
    },
    {
      user_id: 'USR-1011',
      full_name: 'Mert Koçak (Kol-1C Mülhime)',
      city: 'İzmir',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1012',
      full_name: 'Seda Aksoy (Kol-1D)',
      city: 'Bursa',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_ELMAS_BOLGE',
      order_amount: 95000,
    },
    {
      user_id: 'USR-1013',
      full_name: 'Hakan Şahin (Kol-1E)',
      city: 'Konya',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_ELMAS_BOLGE',
      order_amount: 95000,
    },
    {
      user_id: 'USR-1014',
      full_name: 'Gökçe Yıldız (Kol-1F)',
      city: 'Samsun',
      sponsor_id: 'USR-1002',
      package_id: 'PKG_ELMAS_BOLGE',
      order_amount: 100000,
    },

    // USR-1009 (Burak Demir -> 4. Kariyer Mutmainne için 4 kol + 1x Levvâme, PGV: 170.000 $)
    {
      user_id: 'USR-1015',
      full_name: 'Oğuzhan Kaya (Levvâme)',
      city: 'Ankara',
      sponsor_id: 'USR-1009',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1016',
      full_name: 'Pınar Doğan',
      city: 'Ankara',
      sponsor_id: 'USR-1009',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1017',
      full_name: 'Kaan Polat',
      city: 'Ankara',
      sponsor_id: 'USR-1009',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1018',
      full_name: 'Melis Tekin',
      city: 'Ankara',
      sponsor_id: 'USR-1009',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 40000,
    },
    // USR-1015 (Oğuzhan Kaya -> 2. Kariyer Levvâme için 2 kol, PGV: 30.000 $)
    {
      user_id: 'USR-1019',
      full_name: 'Cemil Bozkurt',
      city: 'Ankara',
      sponsor_id: 'USR-1015',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1020',
      full_name: 'Nilüfer Çetin',
      city: 'Ankara',
      sponsor_id: 'USR-1015',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },

    // USR-1010 (Elif Yalçın -> 4. Kariyer Mutmainne için 4 kol + 1x Levvâme, PGV: 170.000 $)
    {
      user_id: 'USR-1021',
      full_name: 'Tuğba Erdem (Levvâme)',
      city: 'İstanbul',
      sponsor_id: 'USR-1010',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1022',
      full_name: 'Onur Acar',
      city: 'İstanbul',
      sponsor_id: 'USR-1010',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1023',
      full_name: 'Büşra Yavuz',
      city: 'İstanbul',
      sponsor_id: 'USR-1010',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1024',
      full_name: 'Serkan Kurt',
      city: 'İstanbul',
      sponsor_id: 'USR-1010',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 40000,
    },
    // USR-1021 (Tuğba Erdem -> 2. Kariyer Levvâme için 2 kol, PGV: 30.000 $)
    {
      user_id: 'USR-1025',
      full_name: 'Volkan Şen',
      city: 'İstanbul',
      sponsor_id: 'USR-1021',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1026',
      full_name: 'Damla Güneş',
      city: 'İstanbul',
      sponsor_id: 'USR-1021',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },

    // USR-1011 (Mert Koçak -> 3. Kariyer Mülhime için 3 kol, PGV: 90.000 $)
    {
      user_id: 'USR-1027',
      full_name: 'Sinan Avcı',
      city: 'İzmir',
      sponsor_id: 'USR-1011',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1028',
      full_name: 'Ebru Karaca',
      city: 'İzmir',
      sponsor_id: 'USR-1011',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1029',
      full_name: 'Tolga Bulut',
      city: 'İzmir',
      sponsor_id: 'USR-1011',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },

    // ========================================================================
    // KOL 2 ALT AĞACI (USR-1003 Emre Soylu -> 5. Kariyer Râziye için 5 Aktif Kol: 2x Mülhime + 3 Aktif Kol, PGV: 360.000 $)
    // ========================================================================
    {
      user_id: 'USR-1030',
      full_name: 'Ayşe Sarı (Kol-2A Mülhime)',
      city: 'İzmir',
      sponsor_id: 'USR-1003',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1031',
      full_name: 'Furkan Ünal (Kol-2B Mülhime)',
      city: 'Manisa',
      sponsor_id: 'USR-1003',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1032',
      full_name: 'Zehra Taş (Kol-2C)',
      city: 'Aydın',
      sponsor_id: 'USR-1003',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 50000,
    },
    {
      user_id: 'USR-1033',
      full_name: 'Barış Eren (Kol-2D)',
      city: 'Muğla',
      sponsor_id: 'USR-1003',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 50000,
    },
    {
      user_id: 'USR-1034',
      full_name: 'Cansu Duran (Kol-2E)',
      city: 'Denizli',
      sponsor_id: 'USR-1003',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 50000,
    },
    // USR-1030 (Ayşe Sarı -> 3. Kariyer Mülhime için 3 kol, PGV: 90.000 $)
    {
      user_id: 'USR-1035',
      full_name: 'Levent Aktaş',
      city: 'İzmir',
      sponsor_id: 'USR-1030',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1036',
      full_name: 'Melek Tunç',
      city: 'İzmir',
      sponsor_id: 'USR-1030',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1037',
      full_name: 'Yasin Cengiz',
      city: 'İzmir',
      sponsor_id: 'USR-1030',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    // USR-1031 (Furkan Ünal -> 3. Kariyer Mülhime için 3 kol, PGV: 90.000 $)
    {
      user_id: 'USR-1038',
      full_name: 'Dilara Köse',
      city: 'Manisa',
      sponsor_id: 'USR-1031',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1039',
      full_name: 'Uğur Başaran',
      city: 'Manisa',
      sponsor_id: 'USR-1031',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1040',
      full_name: 'Nihan Sönmez',
      city: 'Manisa',
      sponsor_id: 'USR-1031',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },

    // ========================================================================
    // KOL 3 ALT AĞACI (USR-1004 Selin Arslan -> 4. Kariyer Mutmainne için 4 Aktif Kol + 1x Levvâme, PGV: 170.000 $)
    // ========================================================================
    {
      user_id: 'USR-1041',
      full_name: 'İlker Çakır (Kol-3A Levvâme)',
      city: 'Bursa',
      sponsor_id: 'USR-1004',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1042',
      full_name: 'Esra Yaman',
      city: 'Bursa',
      sponsor_id: 'USR-1004',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1043',
      full_name: 'Cihan Sezer',
      city: 'Bursa',
      sponsor_id: 'USR-1004',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1044',
      full_name: 'Berna Işık',
      city: 'Bursa',
      sponsor_id: 'USR-1004',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 40000,
    },
    // USR-1041 (İlker Çakır -> 2. Kariyer Levvâme için 2 kol, PGV: 30.000 $)
    {
      user_id: 'USR-1045',
      full_name: 'Eren Uslu',
      city: 'Bursa',
      sponsor_id: 'USR-1041',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1046',
      full_name: 'Hande Ateş',
      city: 'Bursa',
      sponsor_id: 'USR-1041',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },

    // ========================================================================
    // KOL 4 ALT AĞACI (USR-1005 Kerem Çelik -> 4. Kariyer Mutmainne için 4 Aktif Kol + 1x Levvâme, PGV: 170.000 $)
    // ========================================================================
    {
      user_id: 'USR-1047',
      full_name: 'Fatih Yüksel (Kol-4A Levvâme)',
      city: 'Antalya',
      sponsor_id: 'USR-1005',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1048',
      full_name: 'Gamze Soydan',
      city: 'Antalya',
      sponsor_id: 'USR-1005',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1049',
      full_name: 'Murat Kılıç',
      city: 'Antalya',
      sponsor_id: 'USR-1005',
      package_id: 'PKG_PLATIN_KLINIK',
      order_amount: 45000,
    },
    {
      user_id: 'USR-1050',
      full_name: 'Sibel Mutlu',
      city: 'Antalya',
      sponsor_id: 'USR-1005',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 40000,
    },
    // USR-1047 (Fatih Yüksel -> 2. Kariyer Levvâme için 2 kol, PGV: 30.000 $)
    {
      user_id: 'USR-1051',
      full_name: 'Orhan Gündüz',
      city: 'Antalya',
      sponsor_id: 'USR-1047',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },
    {
      user_id: 'USR-1052',
      full_name: 'Aylin Özdemir',
      city: 'Antalya',
      sponsor_id: 'USR-1047',
      package_id: 'PKG_GUMUS_STANDART',
      order_amount: 15000,
    },

    // ========================================================================
    // KOL 5 ALT AĞACI (USR-1006 Derya Korkmaz -> 3. Kariyer Mülhime için 3 Aktif Kol, PGV: 90.000 $)
    // ========================================================================
    {
      user_id: 'USR-1053',
      full_name: 'Tarık Bilgin',
      city: 'Adana',
      sponsor_id: 'USR-1006',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1054',
      full_name: 'Nazan Keskin',
      city: 'Mersin',
      sponsor_id: 'USR-1006',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },
    {
      user_id: 'USR-1055',
      full_name: 'Harun Albayrak',
      city: 'Gaziantep',
      sponsor_id: 'USR-1006',
      package_id: 'PKG_ALTIN_PRO',
      order_amount: 30000,
    },

    // ========================================================================
    // KOL 6 ALT AĞACI (USR-1007 Caner Özkan -> 2. Kariyer Levvâme + "3 Getir Bedavaya Getir" %105 Fast-ROI Testi: 3 x 10.000 $ = 30.000 $ PGV)
    // ========================================================================
    {
      user_id: 'USR-1056',
      full_name: 'Bora Şimşek',
      city: 'Kocaeli',
      sponsor_id: 'USR-1007',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1057',
      full_name: 'Fulya Ergin',
      city: 'Sakarya',
      sponsor_id: 'USR-1007',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
    {
      user_id: 'USR-1058',
      full_name: 'Melike Soylu',
      city: 'Yalova',
      sponsor_id: 'USR-1007',
      package_id: 'PKG_BRONZ_BASLANGIC',
      order_amount: 10000,
    },
  ];

  // 1. AŞAMA: Ağ yapısını ve hedef kariyer seviyelerini ön-hazırla ki 58 sipariş işlenirken
  // liderler (Kâmile #1, Marziyye #2, Râziye #3, Mutmainne #4-#5, Mülhime #6, Levvâme #7) kendi mertebelerinin
  // Unilevel Sonsuzluk (%2..%10), Liderlik Eşleşme (%10..%25) ve Dinamik Sıkıştırma primlerini eksiksiz alsın.
  simNodes.forEach((node, index) => {
    const nextLineId = index + 1;
    const matchedSponsor = node.sponsor_id
      ? members.find((m) => m.user_id === node.sponsor_id)
      : null;
    const orderTimestamp = new Date(baseMs + index * 3600 * 1000 * 3).toISOString();

    const preMember: MonolineMember = {
      id: nextLineId,
      user_id: node.user_id,
      global_line_id: nextLineId,
      ref_code: `AURA-BAYI-${1000 + nextLineId}`,
      full_name: node.full_name,
      email: `${node.user_id.toLowerCase()}@frekans.app`,
      phone: `+90 532 ${String(100 + index).padStart(3, '0')} ${String(1000 + index).slice(-4)}`,
      city: node.city,
      joined_at: orderTimestamp,
      sponsor_id: matchedSponsor ? matchedSponsor.user_id : null,
      sponsor_db_id: matchedSponsor ? matchedSponsor.id : null,
      highest_package_id: node.package_id,
      session_credits: 0,
      personal_volume: node.order_amount,
      group_volume: 0,
      personal_volume_30d: node.order_amount,
      group_volume_30d: 0,
      rolling_30d_personal_volume: node.order_amount,
      rolling_30d_pgv: 0,
      active_direct_referrals: 0,
      career_level: 1,
      career_title: 'Emmâre',
      manual_career_override: null,
      unlocked_depth: 1,
      wallets: {
        sponsor_wallet: 0,
        monoline_wallet: 0,
        career_pool_wallet: 0,
        infinity_wallet: 0,
        matching_wallet: 0,
        fast_roi_wallet: 0,
        total_earnings: 0,

        system_fund_balance: 0,
        total_withdrawn: 0,
      },
      bank_details: {
        iban_holder_name: node.full_name,
        bank_name: node.bank_name || 'Garanti BBVA',
        iban: node.iban || `TR32000620001001000629${String(8000 + nextLineId)}`,
        trc20_address: `TMonolineWalletAddress${1000 + nextLineId}TRC20`,
        preferred_method: 'IBAN',
      },
      two_factor: {
        enabled: nextLineId <= 8,
        secret_key: `JBSWY3DPEHPK3P${nextLineId}`,
        verified_at: nextLineId <= 8 ? orderTimestamp : null,
        backup_codes: [`NF-${nextLineId}-A1`],
      },
      is_active: true,
      is_locked: false,
      activity_expires_at: createFutureExpiryIso(),
      welcome_bonus_granted: false,
      welcome_bonus_credits: 0,
      tc_identity_no: node.tc_identity_no || `${10000000000 + nextLineId * 1234567}`,
      has_tax_company: Boolean(node.has_tax_company),
      last_login_ip: `176.240.${10 + Math.floor(index / 2)}.${10 + index}`,
      device_fingerprint: `DEV-SIM-${1001 + index}`,
      kvkk_approved_at: orderTimestamp,
      contract_version: 'v2.2',
      daily_withdrawal_limit: DAILY_WITHDRAWAL_LIMITS_BY_CAREER[1],
      fast_start_awarded: false,
    };
    members.push(preMember);
  });

  // Ön-kariyer seviyelerini hesapla, ardından ciro/cüzdan sayaçlarını sıfırlayıp gerçek siparişleri sırayla geçir
  recalculateAllCareers('POST_COMMISSION_EVENT');
  for (const m of members) {
    m.personal_volume = 0;
    m.group_volume = 0;
    m.personal_volume_30d = 0;
    m.group_volume_30d = 0;
    m.rolling_30d_personal_volume = 0;
    m.rolling_30d_pgv = 0;
    m.session_credits = 0;
    m.fast_start_awarded = false;
    m.wallets = {
      sponsor_wallet: 0,
      monoline_wallet: 0,
      career_pool_wallet: 0,
      infinity_wallet: 0,
      matching_wallet: 0,
      fast_roi_wallet: 0,
      total_earnings: 0,

      system_fund_balance: 0,
      total_withdrawn: 0,
    };
  }
  commissionLogs = [];
  userRewardsLog = [];
  notificationOutbox = [];
  nextCommissionLogId = 1;
  nextRewardLogId = 1;
  nextNotificationId = 1;

  // 2. AŞAMA: Her bir simülasyon üyesinin siparişini gerçek processOrderCommission motorundan geçir
  simNodes.forEach((node, index) => {
    const orderTimestamp = new Date(baseMs + index * 3600 * 1000 * 3).toISOString();
    const orderId = `ORD-SIM-${1001 + index}`;

    processOrderCommission({
      user_id: node.user_id,
      order_id: orderId,
      order_amount: node.order_amount,
      package_id: node.package_id,
      sponsor_id: node.sponsor_id || undefined,
      reseller_name: node.full_name,
      city: node.city,
      client_ip: `176.240.${10 + Math.floor(index / 2)}.${10 + index}`,
      device_fingerprint: `DEV-SIM-${1001 + index}`,
      timestamp: orderTimestamp,
    } as any);
  });

  // Tüm 7 kariyer terfisini organik olarak yeniden hesapla (#1 Kâmile, #2 Marziyye, #3 Râziye, #4-#5 Mutmainne, #6 Mülhime, #7 Levvâme, #8 Emmâre)
  recalculateAllCareers('POST_COMMISSION_EVENT');

  // V2.2 Revizyon 2: #1 Kâmile Liderin, 1. nesil direkt lideri #2 Zeynep Aydın'ın toplam komisyonu üzerinden %25 Liderlik Eşleşme Farkını tamamla
  const rootKamile = members.find((m) => m.user_id === 'USR-1001');
  const gen1Marziyye = members.find((m) => m.user_id === 'USR-1002');
  if (rootKamile && gen1Marziyye) {
    const zeynepBaseComm = roundCurrency(
      (gen1Marziyye.wallets.sponsor_wallet - (gen1Marziyye.wallets.fast_roi_wallet || 0)) +
        (gen1Marziyye.wallets.monoline_wallet - (gen1Marziyye.wallets.infinity_wallet || 0))
    );
    const targetRootMatchOnZeynep = roundCurrency(zeynepBaseComm * 0.25);
    const existingMatchFromZeynep = roundCurrency(
      (gen1Marziyye.wallets.monoline_wallet - (gen1Marziyye.wallets.infinity_wallet || 0)) * 0.25
    );
    const extraMatchDiff = Math.max(0, roundCurrency(targetRootMatchOnZeynep - existingMatchFromZeynep));
    if (extraMatchDiff > 0) {
      creditMemberWallet(rootKamile, 'MATCHING_BONUS', extraMatchDiff, true);
    }
  }

  // V2.2 Revizyon 6: Optimum %60 Saha Dağıtımı / %40 Şirket Net Kârı (712.000 $) Dengesi:
  // Saha dağıtım bütçesinin (%60 = 1.068.000 $) kalan kısmını Dinamik Liderlik Havuzu (DYNAMIC_POINTS_SPLIT) olarak 3. Kariyer ve üzeri liderlere dağıt
  const totalSimVolume = roundCurrency(
    transactions.reduce((acc, tx) => acc + tx.order_amount, 0)
  );
  const currentFieldDistributed = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.total_earnings, 0)
  );
  const targetTotalFieldPayout = roundCurrency(totalSimVolume * 0.6); // %60 Saha Dağıtımı (1.068.000 $), %40 Şirket Net Kârı (712.000 $)
  const targetPoolSplitAmount = Math.max(
    0,
    roundCurrency(targetTotalFieldPayout - currentFieldDistributed)
  );
  if (systemCareerFundBalance >= targetPoolSplitAmount && targetPoolSplitAmount > 0) {
    const poolToDistribute = targetPoolSplitAmount;
    const poolBefore = systemCareerFundBalance;
    const eligiblePoolMembers = members.filter(
      (m) =>
        m.is_active &&
        !m.is_locked &&
        (m.active_career_level || m.career_level) >= 3 &&
        (m.pool_leadership_points || 0) > 0
    );
    const totalPoints = eligiblePoolMembers.reduce(
      (acc, m) => acc + (m.pool_leadership_points || 0),
      0
    );
    const unitVal = totalPoints > 0 ? poolToDistribute / totalPoints : 0;

    let actualDistributed = 0;
    for (const m of eligiblePoolMembers) {
      const bonus = roundCurrency((m.pool_leadership_points || 0) * unitVal);
      if (bonus > 0) {
        creditMemberWallet(m, 'CAREER_POOL', bonus, false);
        actualDistributed = roundCurrency(actualDistributed + bonus);
      }
    }

    systemCareerFundBalance = Math.max(0, roundCurrency(systemCareerFundBalance - actualDistributed));
    systemWallet.system_pool_balance = Math.max(
      0,
      roundCurrency(systemWallet.system_pool_balance - actualDistributed)
    );
    if (members[0]) {
      members[0].wallets.system_fund_balance = systemCareerFundBalance;
    }

    const tierAllocations = careerTiers.map((tier) => {
      const tierMems = eligiblePoolMembers.filter(
        (m) => (m.active_career_level || m.career_level) === tier.level
      );
      const tierPts = tierMems.reduce((acc, m) => acc + (m.pool_leadership_points || 0), 0);
      const allocated = roundCurrency(tierPts * unitVal);
      const perMember = tierMems.length > 0 ? roundCurrency(allocated / tierMems.length) : 0;
      return {
        career_level: tier.level,
        career_title: tier.title,
        bonus_rate_percent: totalPoints > 0 ? roundCurrency((tierPts / totalPoints) * 100) : 0,
        tier_pool_amount: allocated,
        qualified_member_count: tierMems.length,
        amount_per_member: perMember,
        recipients: tierMems.map((m) => ({
          user_id: m.user_id,
          full_name: m.full_name,
          amount: perMember,
          leadership_points: m.pool_leadership_points || 0,
        })),
      };
    });

    poolDistributions.unshift({
      distribution_id: `POOL-SIM-01`,
      timestamp: new Date().toISOString(),
      pool_balance_before: poolBefore,
      total_distributed: actualDistributed,
      pool_balance_after: systemCareerFundBalance,
      distribution_mode: 'DYNAMIC_POINTS_SPLIT',
      total_leadership_points: totalPoints,
      tier_Allocations: tierAllocations,
    });
  }

  // V2.1 Hukuki & Mali Uyum (%20 Vergi Kesintisi Sistem Fonuna + Fatura Yükleme ile %20 Vergi İadesi) Çekim Talepleri Simülasyonu
  taxRefundInvoices = [];
  nextTaxRefundId = 1;
  const leader1 = members.find((m) => m.user_id === 'USR-1001');
  const leader2 = members.find((m) => m.user_id === 'USR-1002');
  const leader3 = members.find((m) => m.user_id === 'USR-1003');

  const sampleSvgInvoice = (dealerName: string, invoiceNo: string, gross: number, tax: number) =>
    `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="520" viewBox="0 0 800 520"><rect width="800" height="520" fill="#ffffff" stroke="#0f172a" stroke-width="4"/><rect x="24" y="24" width="752" height="72" rx="8" fill="#0f172a"/><text x="44" y="56" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#10b981">e-ARŞİV / e-FATURA RESMİ BELGESİ (GİB ONAYLI)</text><text x="44" y="80" font-family="Arial, sans-serif" font-size="13" fill="#cbd5e1">Fatura No: ${invoiceNo} | Düzenleyen Bayi: ${dealerName}</text><text x="44" y="138" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="#0f172a">ALICI: AKN FREKANS VE BİYO-REZONANS SİSTEMLERİ MERKEZİ</text><text x="44" y="166" font-family="Arial, sans-serif" font-size="14" fill="#334155">Açıklama: Bayi Komisyon Hak Ediş &amp; %20 Vergi İadesi Hizmet Faturası</text><rect x="44" y="195" width="712" height="170" rx="8" fill="#f8fafc" stroke="#cbd5e1"/><text x="64" y="232" font-family="monospace" font-size="15" fill="#0f172a">Brüt Çekim Tutarı              : ${gross.toLocaleString('tr-TR')},00 $</text><text x="64" y="266" font-family="monospace" font-size="15" fill="#dc2626">Sistem Fonuna Kesilen %20 Vergi : -${tax.toLocaleString('tr-TR')},00 $</text><text x="64" y="300" font-family="monospace" font-size="15" fill="#0f172a">Bankaya Ödenen Net Tutar (%80)  : ${(gross - tax).toLocaleString('tr-TR')},00 $</text><text x="64" y="340" font-family="monospace" font-size="17" font-weight="bold" fill="#059669">İADE TALEP EDİLEN %20 VERGİ TUTARI: +${tax.toLocaleString('tr-TR')},00 $</text><text x="44" y="420" font-family="Arial, sans-serif" font-size="13" fill="#475569">Bu fatura bayi tarafından cihazdan yüklenmiş olup Yönetici Vergi İadesi Panelinde onaylandığında %20 vergi tutarı bayi hesabına aktarılır.</text><rect x="540" y="440" width="216" height="44" rx="6" fill="#ecfdf5" stroke="#10b981"/><text x="562" y="467" font-family="Arial, sans-serif" font-size="13" font-weight="bold" fill="#047857">E-İMZALI RESMİ FATURA</text></svg>`
    )}`;

  if (leader1 && getMemberRegionalUsdBalance(leader1) >= 20000) {
    const gross1 = 20000;
    const tax1 = roundCurrency(gross1 * 0.2); // 4.000 $ %20 Vergi
    const net1 = roundCurrency(gross1 - tax1); // 16.000 $ Net
    debitMemberRegionalUsd(leader1, gross1);
    leader1.wallets.total_withdrawn = roundCurrency(leader1.wallets.total_withdrawn + gross1);
    // %20 vergi kesildikten sonra fatura yüklenip onaylandığı için 4.000 $ iade edilmiş örnek:
    creditMemberRegionalUsd(leader1, tax1);
    const invId1 = nextTaxRefundId++;
    const wdId1 = nextWithdrawalId++;
    withdrawalRequests.push({
      id: wdId1,
      user_id: leader1.id,
      external_user_id: leader1.user_id,
      user_full_name: leader1.full_name,
      monoline_position: leader1.global_line_id,
      career_title: leader1.career_title,
      amount: gross1,
      gross_amount: gross1,
      tax_rate_percent: 20,
      tax_deduction: tax1,
      net_amount: net1,
      has_tax_company: true,
      tc_identity_no: leader1.tc_identity_no,
      method: 'IBAN',
      payout_method: 'IBAN',
      payout_address: leader1.bank_details.iban,
      bank_details: {
        method: 'IBAN',
        holder_name: leader1.full_name,
        bank_name: 'Garanti BBVA',
        iban: leader1.bank_details.iban,
      },
      status: 'APPROVED',
      created_at: new Date(Date.now() - 3600000 * 5).toISOString(),
      processed_at: new Date(Date.now() - 3600000 * 4).toISOString(),
      admin_note: '%20 Vergi Kesildi (4.000 $) -> Fatura Onaylandı ve %20 Vergi İadesi Hesaba Aktarıldı.',
      tax_refund_status: 'APPROVED_CREDITED',
      tax_refund_invoice_id: invId1,
      invoice_no: 'GIB2026000001041',
      invoice_file_name: 'Dr_Selim_Karahan_Fatura_20000TL.svg',
      invoice_file_type: 'image/svg+xml',
      invoice_data_url: sampleSvgInvoice(leader1.full_name, 'GIB2026000001041', gross1, tax1),
    });
    taxRefundInvoices.push({
      id: invId1,
      refund_code: `TAX-REF-${1000 + invId1}`,
      withdrawal_id: wdId1,
      user_id: leader1.id,
      external_user_id: leader1.user_id,
      user_full_name: leader1.full_name,
      career_title: leader1.career_title,
      gross_withdrawal_amount: gross1,
      tax_deducted_amount: tax1,
      net_withdrawal_amount: net1,
      invoice_no: 'GIB2026000001041',
      tax_office_and_id: 'Beşiktaş V.D. / 4920183746',
      invoice_file_name: 'Dr_Selim_Karahan_Fatura_20000TL.svg',
      invoice_file_type: 'image/svg+xml',
      invoice_file_size: 4280,
      invoice_data_url: sampleSvgInvoice(leader1.full_name, 'GIB2026000001041', gross1, tax1),
      iban: leader1.bank_details.iban,
      bank_name: 'Garanti BBVA',
      holder_name: leader1.full_name,
      status: 'APPROVED_CREDITED',
      requested_at: new Date(Date.now() - 3600000 * 4.5).toISOString(),
      processed_at: new Date(Date.now() - 3600000 * 4).toISOString(),
      admin_note: 'Yönetici tarafından fatura onaylandı, +4.000 $ (%20 vergi iadesi) bayi hesabına aktarıldı.',
    });
  }

  if (leader2 && getMemberRegionalUsdBalance(leader2) >= 10000) {
    const gross2 = 10000;
    const tax2 = roundCurrency(gross2 * 0.2); // 2.000 $ %20 Vergi -> Sistem Fonuna
    const net2 = roundCurrency(gross2 - tax2); // 8.000 $ Net
    debitMemberRegionalUsd(leader2, gross2);
    leader2.wallets.total_withdrawn = roundCurrency(leader2.wallets.total_withdrawn + gross2);
    addSystemPoolBalance(tax2);
    systemWallet.system_pool_balance = roundCurrency(systemWallet.system_pool_balance + tax2);
    const invId2 = nextTaxRefundId++;
    const wdId2 = nextWithdrawalId++;
    withdrawalRequests.push({
      id: wdId2,
      user_id: leader2.id,
      external_user_id: leader2.user_id,
      user_full_name: leader2.full_name,
      monoline_position: leader2.global_line_id,
      career_title: leader2.career_title,
      amount: gross2,
      gross_amount: gross2,
      tax_rate_percent: 20,
      tax_deduction: tax2,
      net_amount: net2,
      has_tax_company: false,
      tc_identity_no: leader2.tc_identity_no,
      method: 'IBAN',
      payout_method: 'IBAN',
      payout_address: leader2.bank_details.iban,
      bank_details: {
        method: 'IBAN',
        holder_name: leader2.full_name,
        bank_name: 'Türkiye İş Bankası',
        iban: leader2.bank_details.iban,
      },
      status: 'APPROVED',
      created_at: new Date(Date.now() - 3600000 * 3).toISOString(),
      processed_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      admin_note: '%20 Vergi (2.000 $) Sistem Fonuna aktarıldı. Bayi fatura yükledi, Vergi İadesi onayı bekliyor.',
      tax_refund_status: 'PENDING_ADMIN_APPROVAL',
      tax_refund_invoice_id: invId2,
      invoice_no: 'GIB2026000001089',
      invoice_file_name: 'Zeynep_Aydin_Vergi_Iade_Faturasi.svg',
      invoice_file_type: 'image/svg+xml',
      invoice_data_url: sampleSvgInvoice(leader2.full_name, 'GIB2026000001089', gross2, tax2),
    });
    taxRefundInvoices.unshift({
      id: invId2,
      refund_code: `TAX-REF-${1000 + invId2}`,
      withdrawal_id: wdId2,
      user_id: leader2.id,
      external_user_id: leader2.user_id,
      user_full_name: leader2.full_name,
      career_title: leader2.career_title,
      gross_withdrawal_amount: gross2,
      tax_deducted_amount: tax2,
      net_withdrawal_amount: net2,
      invoice_no: 'GIB2026000001089',
      tax_office_and_id: 'Çankaya V.D. / 3184920175',
      invoice_file_name: 'Zeynep_Aydin_Vergi_Iade_Faturasi.svg',
      invoice_file_type: 'image/svg+xml',
      invoice_file_size: 4190,
      invoice_data_url: sampleSvgInvoice(leader2.full_name, 'GIB2026000001089', gross2, tax2),
      iban: leader2.bank_details.iban,
      bank_name: 'Türkiye İş Bankası',
      holder_name: leader2.full_name,
      status: 'PENDING_ADMIN_APPROVAL',
      requested_at: new Date(Date.now() - 3600000 * 1.5).toISOString(),
      processed_at: null,
      admin_note: 'Bayi cihazdan e-Arşiv faturasını yükledi; Yönetici Vergi İadesi Panelinde onay bekliyor.',
    });
  }

  if (leader3 && getMemberRegionalUsdBalance(leader3) >= 5000) {
    const gross3 = 5000;
    const tax3 = roundCurrency(gross3 * 0.2); // 1.000 $ %20 Vergi -> Sistem Fonuna
    const net3 = roundCurrency(gross3 - tax3); // 4.000 $ Net
    debitMemberRegionalUsd(leader3, gross3);
    addSystemPoolBalance(tax3);
    systemWallet.system_pool_balance = roundCurrency(systemWallet.system_pool_balance + tax3);
    const wdId3 = nextWithdrawalId++;
    withdrawalRequests.push({
      id: wdId3,
      user_id: leader3.id,
      external_user_id: leader3.user_id,
      user_full_name: leader3.full_name,
      monoline_position: leader3.global_line_id,
      career_title: leader3.career_title,
      amount: gross3,
      gross_amount: gross3,
      tax_rate_percent: 20,
      tax_deduction: tax3,
      net_amount: net3,
      has_tax_company: false,
      tc_identity_no: leader3.tc_identity_no,
      method: 'IBAN',
      payout_method: 'IBAN',
      payout_address: leader3.bank_details.iban,
      bank_details: {
        method: 'IBAN',
        holder_name: leader3.full_name,
        bank_name: 'QNB Finansbank',
        iban: leader3.bank_details.iban,
      },
      status: 'PENDING',
      created_at: new Date(Date.now() - 1800000).toISOString(),
      processed_at: null,
      admin_note: '%20 Vergi (1.000 $) Sistem Fonuna aktarıldı. Banka ödemesi bekliyor.',
      tax_refund_status: 'NONE',
      tax_refund_invoice_id: null,
    });
  }

  // ============================================================================
  // 5 STRATEJİK İYİLEŞTİRME ÖNERİSİ — SİMÜLASYON BAŞLANGIÇ VERİLERİ (FOMO 48S, P2P & VOUCHER)
  // ============================================================================
  fomoCountdownAlerts = [
    {
      id: nextFomoAlertId++,
      user_id: 8,
      external_user_id: 'USR-1008',
      user_full_name: 'Aslıhan Çelik',
      source_order_id: 'ORD-SIM-1015',
      source_buyer_name: 'Oğuzhan Demir',
      source_order_amount: 30000,
      at_risk_commission_amount: 2400,
      depth_level: 2,
      reason: 'INACTIVE_EXPIRED',
      warning_message:
        '⚠️ DİKKAT: Üst/Alt hattınızda 2.400 $ komisyon oluştu! Aktiflik sürenizin bitmesine 48 saat kaldı. Aktifliğinizi yenilemezseniz bu tutar Sistem Havuzuna devredilecektir.',
      expires_at: new Date(Date.now() + 47 * 3600 * 1000 + 42 * 60 * 1000).toISOString(),
      remaining_seconds: 47 * 3600 + 42 * 60,
      status: 'COUNTDOWN_ACTIVE_48H',
      created_at: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
    },
    {
      id: nextFomoAlertId++,
      user_id: 7,
      external_user_id: 'USR-1007',
      user_full_name: 'Caner Özkan',
      source_order_id: 'ORD-SIM-1022',
      source_buyer_name: 'Merve Kılıç',
      source_order_amount: 30000,
      at_risk_commission_amount: 1500,
      depth_level: 3,
      reason: 'INSUFFICIENT_CAREER_DEPTH',
      warning_message:
        '⚠️ DİKKAT: Üst/Alt hattınızda 1.500 $ (3. Derinlik) komisyon oluştu! Aktiflik/Kariyer tamamlama sürenizin bitmesine 48 saat kaldı. Paket/referans şartını tamamlamazsanız bu tutar Sistem Havuzuna devredilecektir.',
      expires_at: new Date(Date.now() + 45 * 3600 * 1000 + 15 * 60 * 1000).toISOString(),
      remaining_seconds: 45 * 3600 + 15 * 60,
      status: 'COUNTDOWN_ACTIVE_48H',
      created_at: new Date(Date.now() - 165 * 60 * 1000).toISOString(),
    },
    {
      id: nextFomoAlertId++,
      user_id: 6,
      external_user_id: 'USR-1006',
      user_full_name: 'Kerem Yıldırım',
      source_order_id: 'ORD-SIM-1030',
      source_buyer_name: 'Büşra Koçak',
      source_order_amount: 50000,
      at_risk_commission_amount: 2000,
      depth_level: 4,
      reason: 'INSUFFICIENT_CAREER_DEPTH',
      warning_message:
        '⚠️ DİKKAT: Üst/Alt hattınızda 2.000 $ (4. Derinlik) komisyon oluştu! 48 saat içinde Mutmainne kademesine yükselmezseniz veya aktifliğinizi yenilemezseniz bu tutar Sistem Havuzuna devredilecektir.',
      expires_at: new Date(Date.now() + 41 * 3600 * 1000 + 30 * 60 * 1000).toISOString(),
      remaining_seconds: 41 * 3600 + 30 * 60,
      status: 'COUNTDOWN_ACTIVE_48H',
      created_at: new Date(Date.now() - 390 * 60 * 1000).toISOString(),
    },
  ];

  activationVouchers = [
    {
      id: nextVoucherId++,
      voucher_code: 'AKN-VCH-5K-4820',
      creator_user_id: 1,
      creator_external_id: 'USR-1001',
      creator_user_name: 'Dr. Selim Karahan',
      package_id: 'PKG_MINI_DENEME',
      package_name: 'Mini Başlangıç & Deneme Paketi (5.000 $)',
      amount: 5000,
      session_credits: 32,
      status: 'ACTIVE_UNUSED',
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: nextVoucherId++,
      voucher_code: 'AKN-VCH-10K-7391',
      creator_user_id: 1,
      creator_external_id: 'USR-1001',
      creator_user_name: 'Dr. Selim Karahan',
      package_id: 'PKG_BRONZ_BASLANGIC',
      package_name: 'Bronz Başlangıç & Seans Paketi (10.000 $)',
      amount: 10000,
      session_credits: 70,
      status: 'ACTIVE_UNUSED',
      created_at: new Date(Date.now() - 5400000).toISOString(),
    },
    {
      id: nextVoucherId++,
      voucher_code: 'AKN-VCH-30K-9914',
      creator_user_id: 2,
      creator_external_id: 'USR-1002',
      creator_user_name: 'Uzm. Zeynep Aydın',
      package_id: 'PKG_ALTIN_PRO',
      package_name: 'Altın Pro Danışman Paketi (30.000 $)',
      amount: 30000,
      session_credits: 270,
      status: 'ACTIVE_UNUSED',
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: nextVoucherId++,
      voucher_code: 'AKN-VCH-15K-2105',
      creator_user_id: 1,
      creator_external_id: 'USR-1001',
      creator_user_name: 'Dr. Selim Karahan',
      package_id: 'PKG_GUMUS_STANDART',
      package_name: 'Gümüş Standart Terapist Paketi (15.000 $)',
      amount: 15000,
      session_credits: 115,
      status: 'REDEEMED',
      redeemed_by_user_id: 7,
      redeemed_by_external_id: 'USR-1007',
      redeemed_by_user_name: 'Caner Özkan',
      redeemed_at: new Date(Date.now() - 1800000).toISOString(),
      created_at: new Date(Date.now() - 10800000).toISOString(),
    },
  ];

  p2pTransfers = [
    {
      id: nextP2PTransferId++,
      tx_code: 'P2P-TX-9001',
      from_user_id: 1,
      from_external_id: 'USR-1001',
      from_user_name: 'Dr. Selim Karahan',
      to_user_id: 7,
      to_external_id: 'USR-1007',
      to_user_name: 'Caner Özkan',
      amount: 15000,
      transfer_type: 'VOUCHER_MINT',
      package_id: 'PKG_GUMUS_STANDART',
      voucher_code: 'AKN-VCH-15K-2105',
      note: 'Alt ekip lideri Caner Özkan için cüzdan bakiyesinden 15.000 $ Aktivasyon Kuponu üretildi ve kullanıldı.',
      status: 'COMPLETED',
      created_at: new Date(Date.now() - 1800000).toISOString(),
    },
    {
      id: nextP2PTransferId++,
      tx_code: 'P2P-TX-9002',
      from_user_id: 2,
      from_external_id: 'USR-1002',
      from_user_name: 'Uzm. Zeynep Aydın',
      to_user_id: 8,
      to_external_id: 'USR-1008',
      to_user_name: 'Aslıhan Çelik',
      amount: 5000,
      transfer_type: 'WALLET_TO_WALLET',
      package_id: null,
      voucher_code: null,
      note: '30 günlük süre uzatma desteği için P2P cüzdandan cüzdana anında iç bakiye transferi.',
      status: 'COMPLETED',
      created_at: new Date(Date.now() - 900000).toISOString(),
    },
  ];

  feedbackTickets = [
    {
      id: 'TKT-2026-101',
      user_id: 'USR-1002',
      member_name: 'Uzm. Zeynep Aydın',
      member_email: 'zeynep.aydin@aurabio.com',
      member_phone: '+90 532 234 56 78',
      member_ref_code: 'AURA-BAYI-1002',
      member_career_level: 2,
      member_career_title: 'Kariyer Seviyesi 2',
      type: 'COMPLAINT',
      subject: 'Banka IBAN Çekim Talebi Dekont ve Onay Süresi',
      message: 'Geçtiğimiz hafta vermiş olduğum 5.000 $ banka çekim talebim aynı gün içinde Ziraat Bankası IBAN hesabıma yattı. Süreç çok hızlıydı, sistemdeki bildirim dekont numarasını da panelimde görüntüledim, finans departmanına ve yönetime teşekkürler.',
      priority: 'NORMAL',
      category: 'COMMISSION_PAYOUT',
      status: 'RESOLVED',
      admin_reply: 'Sayın Zeynep Hanım, nazik bildiriminiz için teşekkür ederiz. Çekim talepleri her iş günü 10:00 - 17:00 arasında finans departmanımız ve mali müşavir kontrolüyle onaylanarak banka havaleleri anında gerçekleştirilmektedir.',
      admin_replied_at: new Date(Date.now() - 3600000 * 20).toISOString(),
      admin_replied_by: 'Abdulkadir kan (Yönetim Kurulu Başkanı)',
      created_at: new Date(Date.now() - 3600000 * 48).toISOString(),
      updated_at: new Date(Date.now() - 3600000 * 20).toISOString(),
    },
    {
      id: 'TKT-2026-102',
      user_id: 'USR-1003',
      member_name: 'Ecz. Murat Koç',
      member_email: 'murat.koc@aurabio.com',
      member_phone: '+90 533 345 67 89',
      member_ref_code: 'AURA-BAYI-1003',
      member_career_level: 3,
      member_career_title: 'Kariyer Seviyesi 3',
      type: 'SUGGESTION',
      subject: 'Klinik Frekans Seanslarında 15 Dakikalık Hızlı Dengeleme Protokolü',
      message: 'Danışanlarımıza klinik seans uygularken kariyer sistemi için 15 dakikalık hızlı ön seans modu harika olurdu. Frekans spektrumunda bu tarz bir hızlı ön protokol paneline veya cihaz modüllerine eklenebilir mi?',
      priority: 'HIGH',
      category: 'DEVICE_SESSION',
      status: 'IN_REVIEW',
      admin_reply: 'Harika bir öneri Murat Bey! Biyofizik ve yazılım Ar-Ge ekibimiz yeni güncelleme paketi için 15 dakikalık hızlı frekans rezonans ön ayarı üzerinde testlere başladı.',
      admin_replied_at: new Date(Date.now() - 3600000 * 4).toISOString(),
      admin_replied_by: 'AuraBio Ar-Ge ve Teknik Yönetim',
      created_at: new Date(Date.now() - 3600000 * 12).toISOString(),
      updated_at: new Date(Date.now() - 3600000 * 4).toISOString(),
    },
    {
      id: 'TKT-2026-103',
      user_id: 'USR-1004',
      member_name: 'Dyt. Ayşe Kaya',
      member_email: 'ayse.kaya@aurabio.com',
      member_phone: '+90 535 456 78 90',
      member_ref_code: 'AURA-BAYI-1004',
      member_career_level: 1,
      member_career_title: 'Kariyer Seviyesi 1',
      type: 'SUGGESTION',
      subject: 'Yeni Alt Bayiler İçin Tanıtım PDF Kitapçığı ve Sunum Materyalleri',
      message: 'AuraBio kariyer sistemini yeni danışan ve bayilerimize tanıtırken kullanabileceğimiz yüksek çözünürlüklü dijital sunum slaytları ve PDF tanıtım broşürleri bayi panelimize indirme bağlantısı olarak eklenirse saha çalışmalarımız çok daha hızlı ilerler.',
      priority: 'NORMAL',
      category: 'CAREER_SYSTEM',
      status: 'PENDING',
      created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
      updated_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    },
  ];
}

function buildUsdTryRateResponse() {
  return {
    usd_try_rate: usdTryRate,
    updated_at: usdTryRateUpdatedAt,
    updated_by: usdTryRateUpdatedBy,
  };
}

function buildStateResponse(): SystemStateResponse {
  const totalOrdersCount = transactions.length;
  const totalOrderVolume = roundCurrency(
    transactions.reduce((acc, tx) => acc + tx.order_amount, 0)
  );
  const totalSessionCreditsIssued = members.reduce((acc, m) => acc + m.session_credits, 0);
  const totalSponsorPaid = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.sponsor_wallet, 0)
  );
  const totalMonolinePaid = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.monoline_wallet, 0)
  );
  const totalCareerPoolPaid = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.career_pool_wallet, 0)
  );
  const totalInfinityPaid = roundCurrency(
    members.reduce((acc, m) => acc + (m.wallets.infinity_wallet || 0), 0)
  );
  const totalMatchingPaid = roundCurrency(
    members.reduce((acc, m) => acc + (m.wallets.matching_wallet || 0), 0)
  );
  const totalFastRoiPaid = roundCurrency(
    members.reduce((acc, m) => acc + (m.wallets.fast_roi_wallet || 0), 0)
  );
  const totalFieldPayoutAmount = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.total_earnings, 0)
  );
  const companyNetProfitAmount = Math.max(
    0,
    roundCurrency(totalOrderVolume - totalFieldPayoutAmount)
  );
  const companyNetProfitPercent =
    totalOrderVolume > 0 ? roundCurrency((companyNetProfitAmount / totalOrderVolume) * 100) : 40;
  const totalWithdrawnAmount = roundCurrency(
    members.reduce((acc, m) => acc + m.wallets.total_withdrawn, 0)
  );
  const pendingWithdrawals = withdrawalRequests.filter((w) => w.status === 'PENDING');
  const pendingWithdrawalsAmount = roundCurrency(
    pendingWithdrawals.reduce((acc, w) => acc + w.amount, 0)
  );
  const activeDealersCount = members.filter((m) => m.is_active).length;
  const expiredDealersCount = members.filter((m) => !m.is_active).length;
  const totalPendingClawbackBalance = roundCurrency(
    members.reduce((acc, m) => acc + getMemberRegionalPendingUsd(m), 0)
  );
  const unclaimedNoYetkiAmount = roundCurrency(
    unclaimedCommissions
      .filter((u) => u.reason_code === 'POOL_TRANSFER_NO_YETKI')
      .reduce((acc, u) => acc + u.amount, 0)
  );
  const unclaimedInactiveAmount = roundCurrency(
    unclaimedCommissions
      .filter((u) => u.reason_code === 'POOL_TRANSFER_INACTIVE')
      .reduce((acc, u) => acc + u.amount, 0)
  );
  const unclaimedNoUserAmount = roundCurrency(
    unclaimedCommissions
      .filter((u) => u.reason_code === 'POOL_TRANSFER_NO_USER')
      .reduce((acc, u) => acc + u.amount, 0)
  );
  const totalUnclaimedPoolTransfers = roundCurrency(
    unclaimedNoYetkiAmount + unclaimedInactiveAmount + unclaimedNoUserAmount
  );
  const totalTaxWithheldAmount = roundCurrency(
    withdrawalRequests
      .filter((w) => w.status !== 'REJECTED')
      .reduce((acc, w) => acc + (w.tax_deduction || 0), 0)
  );
  const totalRewardsCashValue = roundCurrency(
    userRewardsLog.reduce((acc, r) => acc + (r.cash_value || 0), 0)
  );
  const fraudReviewCount = fraudAlerts.filter((f) => f.status === 'FRAUD_REVIEW').length;

  return {
    members,
    career_tiers: careerTiers,
    distribution_params: distributionParams,

    activity_logs: activityLogs.slice(0, 150),
    transactions,
    commission_logs: commissionLogs.slice(0, 150),
    system_wallet: systemWallet,
    orders_log: ordersLog.slice(0, 150),
    unclaimed_commissions: unclaimedCommissions.slice(0, 200),
    queue_jobs: queueJobs.slice(0, 100),
    v2_architecture_config: v2ArchitectureConfig,
    unilevel_infinity_rules: UNILEVEL_INFINITY_RULES,
    withdrawal_requests: withdrawalRequests,
    tax_refund_invoices: taxRefundInvoices,
    feedback_tickets: feedbackTickets,
    user_rewards_log: userRewardsLog.slice(0, 100),
    notification_outbox: notificationOutbox.slice(0, 150),
    fomo_countdown_alerts: fomoCountdownAlerts.slice(0, 50),
    p2p_transfers: p2pTransfers.slice(0, 100),
    wallet_transactions: walletTransactions.slice(0, 500),
    activation_vouchers: activationVouchers.slice(0, 100),
    fraud_alerts: fraudAlerts.slice(0, 100),
    webhook_logs: webhookLogs.slice(0, 100),
    cron_logs: cronLogs.slice(0, 50),
    pool_distributions: poolDistributions,
    system_metrics: {
      total_orders_count: totalOrdersCount,
      total_order_volume: totalOrderVolume,
      total_session_credits_issued: totalSessionCreditsIssued,
      system_career_fund_balance: systemCareerFundBalance,
      system_career_fund_cumulative: systemCareerFundCumulative,
      total_sponsor_commissions_paid: totalSponsorPaid,
      total_monoline_commissions_paid: totalMonolinePaid,
      total_career_pool_bonuses_paid: totalCareerPoolPaid,
      total_infinity_bonuses_paid: totalInfinityPaid,
      total_matching_bonuses_paid: totalMatchingPaid,
      total_fast_roi_bonuses_paid: totalFastRoiPaid,
      total_field_payout_amount: totalFieldPayoutAmount,
      company_net_profit_amount: companyNetProfitAmount,
      company_net_profit_percent: companyNetProfitPercent,
      total_withdrawn_amount: totalWithdrawnAmount,
      pending_withdrawals_amount: pendingWithdrawalsAmount,
      pending_withdrawals_count: pendingWithdrawals.length,
      idempotent_blocked_count: idempotentBlockedCount,
      enforce_career_depth_lock: enforceCareerDepthLock,
      active_dealers_count: activeDealersCount,
      expired_dealers_count: expiredDealersCount,
      total_pending_clawback_balance: totalPendingClawbackBalance,
      total_unclaimed_pool_transfers: totalUnclaimedPoolTransfers,
      unclaimed_no_yetki_amount: unclaimedNoYetkiAmount,
      unclaimed_inactive_amount: unclaimedInactiveAmount,
      unclaimed_no_user_amount: unclaimedNoUserAmount,
      total_tax_withheld_amount: totalTaxWithheldAmount,
      total_rewards_cash_value: totalRewardsCashValue,
      fraud_review_count: fraudReviewCount,
      notifications_sent_count: notificationOutbox.length,
    },
  };
}

seedInitialData();

// Section 5: Admin oturum token'ı (HMAC-SHA256) ve Admin Endpoint Middleware
const ADMIN_TOKEN_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_LOGIN_EMAIL = 'psikologabdulkadirkan@gmail.com';

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function adminSecretsConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.ADMIN_JWT_SECRET);
}

function issueAdminToken(secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: 'ADMIN-AKN-01', role: 'ADMIN', exp: Date.now() + ADMIN_TOKEN_TTL_MS })
  ).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyAdminToken(token: string): string | null {
  const secret = process.env.ADMIN_JWT_SECRET;
  const [payload, signature, extra] = token.split('.');
  if (!secret || !payload || !signature || extra !== undefined) return null;

  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqual(sha256Digest(signature), sha256Digest(expected))) return null;

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const valid = claims.role === 'ADMIN' && typeof claims.exp === 'number' && claims.exp > Date.now();
    return valid && typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

const MEMBER_TOKEN_TTL_MS = 4 * 60 * 60 * 1000;

function issueMemberToken(userId: string): string {
  const secret = process.env.MEMBER_JWT_SECRET;
  if (!secret) throw new Error('MEMBER_JWT_SECRET yapılandırılmamış.');
  const payload = Buffer.from(JSON.stringify({ sub: userId, role: 'MEMBER', exp: Date.now() + MEMBER_TOKEN_TTL_MS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyMemberToken(token: string): string | null {
  const secret = process.env.MEMBER_JWT_SECRET;
  const [payload, signature, extra] = token.split('.');
  if (!secret || !payload || !signature || extra !== undefined) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqual(sha256Digest(signature), sha256Digest(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return claims.role === 'MEMBER' && typeof claims.exp === 'number' && claims.exp > Date.now()
      ? String(claims.sub || '') || null
      : null;
  } catch {
    return null;
  }
}

function hashMemberPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

function verifyMemberPassword(password: string, salt: string, expectedHash: string): boolean {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireWalletMember(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', code: 'MEMBER_AUTH_REQUIRED', message: 'Bayi oturumu gereklidir.' });
    return;
  }
  const tokenUserId = verifyMemberToken(authHeader.slice('Bearer '.length).trim());
  const payerUserId = String(req.body?.payer_user_id || '').trim();
  if (!tokenUserId) {
    res.status(401).json({ status: 'error', code: 'MEMBER_SESSION_INVALID', message: 'Bayi oturumu geçersiz veya süresi dolmuş.' });
    return;
  }
  if (tokenUserId !== payerUserId) {
    res.status(403).json({ status: 'error', code: 'PAYER_ID_MISMATCH', message: 'Cüzdan yalnızca oturum açmış bayiye ait olabilir.' });
    return;
  }
  next();
}

function requireWithdrawalMember(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', code: 'MEMBER_AUTH_REQUIRED', message: 'Bayi oturumu gereklidir.' });
    return;
  }
  const tokenUserId = verifyMemberToken(authHeader.slice('Bearer '.length).trim());
  if (!tokenUserId) {
    res.status(401).json({ status: 'error', code: 'MEMBER_SESSION_INVALID', message: 'Bayi oturumu geçersiz veya süresi dolmuş.' });
    return;
  }
  const bodyUserId = String(req.body?.user_id || '').trim();
  if (bodyUserId && bodyUserId !== tokenUserId) {
    res.status(403).json({ status: 'error', code: 'PAYER_ID_MISMATCH', message: 'Çekim talebi yalnızca oturum açmış bayiye ait olabilir.' });
    return;
  }
  res.locals.memberUserId = tokenUserId;
  next();
}

function requireAdminJwt(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      status: 'error',
      code: 'ADMIN_AUTH_REQUIRED',
      message: '401 Unauthorized — Bu endpoint için yönetici oturumu gereklidir.',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const adminUid = verifyAdminToken(token);
  if (!adminUid) {
    res.status(403).json({
      status: 'error',
      code: 'FORBIDDEN_ADMIN_ROLE_REQUIRED',
      message: '403 Forbidden — Geçersiz veya süresi dolmuş yönetici oturumu.',
    });
    return;
  }
  res.locals.adminUid = adminUid;
  next();
}

function requireAdminOrOwnMember(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', code: 'AUTH_REQUIRED', message: 'Yetkilendirme gereklidir.' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const adminUid = verifyAdminToken(token);
  if (adminUid) {
    res.locals.adminUid = adminUid;
    next();
    return;
  }
  const memberUid = verifyMemberToken(token);
  if (!memberUid) {
    res.status(403).json({ status: 'error', code: 'FORBIDDEN', message: 'Oturum geçersiz veya süresi dolmuş.' });
    return;
  }
  if (memberUid !== req.params.userId) {
    res.status(403).json({ status: 'error', code: 'MEMBER_SCOPE_MISMATCH', message: 'Yalnızca kendi hesabınız için işlem yapabilirsiniz.' });
    return;
  }
  next();
}

function requireDocumentViewer(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ status: 'error', message: 'Bayi veya yönetici oturumu gereklidir.' });
    return;
  }
  const token = authHeader.slice('Bearer '.length).trim();
  const userId = verifyAdminToken(token) || verifyMemberToken(token);
  if (!userId) {
    res.status(403).json({ status: 'error', message: 'Oturum geçersiz veya süresi dolmuş.' });
    return;
  }
  next();
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.post('/api/v1/member/session', (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const member = members.find((entry) => entry.email?.toLowerCase() === email);
    const credentials = member ? memberCredentials.get(member.user_id) : undefined;
    if (!member || !credentials || !verifyMemberPassword(password, credentials.salt, credentials.hash) || member.is_locked) {
      res.status(401).json({ status: 'error', code: 'MEMBER_LOGIN_FAILED', message: 'E-posta veya şifre hatalı.' });
      return;
    }
    if (!process.env.MEMBER_JWT_SECRET) {
      res.status(503).json({ status: 'error', code: 'MEMBER_AUTH_NOT_CONFIGURED', message: 'Bayi oturum servisi yapılandırılmamış.' });
      return;
    }
    res.json({ status: 'success', token: issueMemberToken(member.user_id), user_id: member.user_id, expires_in_ms: MEMBER_TOKEN_TTL_MS });
  });

  app.post('/api/v1/admin/login', (req, res) => {
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!adminSecretsConfigured() || !secret) {
      res.status(503).json({
        status: 'error',
        code: 'ADMIN_AUTH_NOT_CONFIGURED',
        message: 'Yönetici girişi yapılandırılmamış. Sunucu ortamında ADMIN_PASSWORD ve ADMIN_JWT_SECRET ayarlayıp sunucuyu yeniden başlatın.',
      });
      return;
    }

    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '').trim();
    const emailMatches = email === ADMIN_LOGIN_EMAIL;
    const passwordMatches =
      Boolean(password) &&
      (timingSafeEqual(sha256Digest(password), sha256Digest(process.env.ADMIN_PASSWORD as string)) ||
        (Boolean(process.env.ADMIN_SECRET_PIN) &&
          timingSafeEqual(
            sha256Digest(password),
            sha256Digest(process.env.ADMIN_SECRET_PIN as string)
          )));

    if (!emailMatches || !passwordMatches) {
      res.status(401).json({
        status: 'error',
        code: 'ADMIN_LOGIN_FAILED',
        message: 'E-posta veya şifre hatalı.',
      });
      return;
    }

    res.json({
      status: 'success',
      token: issueAdminToken(secret),
      expires_in_ms: ADMIN_TOKEN_TTL_MS,
    });
  });

  // CORS headers (Section 5)
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Idempotency-Key');
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: Date.now(),
      service: 'AuraBio Quantum Resonance & Monoline MLM Engine',
    });
  });

  app.get('/api/security/status', (_req, res) => {
    res.json({
      firewall: 'active',
      antiDosRateLimiter: 'enabled',
      securityHeaders: 'enforced',
      timestamp: Date.now(),
    });
  });

  app.get('/api/v1/documents', requireDocumentViewer, (_req, res) => {
    const documents = [...sharedDocuments.values()]
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .map(({ data: _data, ...document }) => document);
    res.json({ documents });
  });

  app.post('/api/v1/admin/documents', requireAdminJwt, (req, res) => {
    const name = path.basename(String(req.body?.name || '').replace(/\\\\/g, '/')).replace(/[\\u0000-\\u001f\\u007f]/g, '').trim().slice(0, 180);
    const extension = path.extname(name).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.ppt': 'application/vnd.ms-powerpoint',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    };
    const dataBase64 = String(req.body?.dataBase64 || '');
    if (!name || !mimeTypes[extension] || !dataBase64) {
      res.status(400).json({ status: 'error', message: 'Geçerli bir doküman dosyası seçin.' });
      return;
    }
    const data = Buffer.from(dataBase64, 'base64');
    if (data.length === 0 || data.length > 6 * 1024 * 1024 || data.toString('base64') !== dataBase64) {
      res.status(400).json({ status: 'error', message: 'Dosya boş, geçersiz veya 6 MB sınırını aşıyor.' });
      return;
    }
    const id = randomBytes(16).toString('hex');
    const document = {
      id,
      name,
      mimeType: mimeTypes[extension],
      size: data.length,
      uploadedAt: new Date().toISOString(),
      data,
    };
    sharedDocuments.set(id, document);
    res.status(201).json({ status: 'success', document: { ...document, data: undefined } });
  });

  app.get('/api/v1/documents/:documentId/download', requireDocumentViewer, (req, res) => {
    const document = sharedDocuments.get(req.params.documentId);
    if (!document) {
      res.status(404).json({ status: 'error', message: 'Doküman bulunamadı.' });
      return;
    }
    const fallbackName = document.id;
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Length', document.size);
    res.setHeader('Content-Disposition', `attachment; filename="${fallbackName}"; filename*=UTF-8''${encodeURIComponent(document.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(document.data);
  });

  app.get('/api/v1/state', (_req, res) => {
    res.json(buildStateResponse());
  });

  app.get('/api/v1/ethics-guidelines', (_req, res) => {
    res.json({ content: ethicsGuidelinesContent });
  });

  app.get('/api/v1/ethics-guidelines/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const sendContent = () => res.write(`data: ${JSON.stringify({ content: ethicsGuidelinesContent })}\n\n`);
    ethicsGuidelinesClients.add(res);
    sendContent();
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      ethicsGuidelinesClients.delete(res);
    });
  });

  app.put('/api/v1/admin/ethics-guidelines', requireAdminJwt, (req, res) => {
    const content = req.body?.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 40000) {
      res.status(400).json({ status: 'error', message: 'Etik kurallar metni boş olamaz ve 40.000 karakteri aşamaz.' });
      return;
    }

    ethicsGuidelinesContent = normalizeEthicsGuidelinesContent(content);
    ethicsGuidelinesClients.forEach((client) => {
      client.write(`data: ${JSON.stringify({ content: ethicsGuidelinesContent })}\n\n`);
    });
    res.json({ status: 'success', content: ethicsGuidelinesContent });
  });

  // ============================================================================
  // SECTION 4: 👤 BAYİ PANELİ ENDPOINT'LERİ (EXACT SPECIFICATION ROUTES)
  // ============================================================================

  // 1. GET /api/v1/user/dashboard
  // Dönen veri: Bakiye, Kariyer Seviyesi, Monoline Hat Sırası, Toplam Kazanç, Ekip Sayısı.
  app.get('/api/v1/user/dashboard', (req, res) => {
    const userId = String(req.query.user_id || 'USR-1001');
    const member =
      members.find((m) => m.user_id === userId || String(m.id) === userId) || members[0];

    if (!member) {
      res.status(404).json({ status: 'error', message: 'Kullanıcı bulunamadı.' });
      return;
    }

    const directTeamCount = members.filter((m) => m.sponsor_id === member.user_id).length;

    res.json({
      status: 'success',
      endpoint: 'GET /api/v1/user/dashboard',
      data: {
        user_id: member.id,
        external_app_user_id: member.user_id,
        full_name: member.full_name,
        ref_code: member.ref_code,
        balance: getMemberRegionalUsdBalance(member),
        pending_balance: getMemberRegionalPendingUsd(member),
        total_earnings: member.wallets.total_earnings,
        career_level: member.career_level,
        career_title: member.career_title,
        unlocked_depth: member.unlocked_depth,
        monoline_position: member.global_line_id,
        session_credits: member.session_credits,
        team_count: directTeamCount,
        users_ahead_in_monoline: member.global_line_id - 1,
        users_behind_in_monoline: members.length - member.global_line_id,
      },
    });
  });

  // 2. GET /api/v1/user/monoline-line
  // Dönen veri: Üyenin küresel hatta önündeki ve arkasındaki son 10 üye.
  app.get('/api/v1/user/monoline-line', (req, res) => {
    const userId = String(req.query.user_id || 'USR-1006');
    const sorted = [...members].sort((a, b) => a.global_line_id - b.global_line_id);
    const member =
      sorted.find((m) => m.user_id === userId || String(m.id) === userId) || sorted[0];

    const ahead10 = sorted
      .filter((m) => m.global_line_id < member.global_line_id)
      .slice(-10)
      .map((m) => ({
        id: m.id,
        external_app_user_id: m.user_id,
        full_name: m.full_name,
        monoline_position: m.global_line_id,
        distance_above: member.global_line_id - m.global_line_id,
        career_level: m.career_level,
        career_title: m.career_title,
      }));

    const behind10 = sorted
      .filter((m) => m.global_line_id > member.global_line_id)
      .slice(0, 10)
      .map((m) => ({
        id: m.id,
        external_app_user_id: m.user_id,
        full_name: m.full_name,
        monoline_position: m.global_line_id,
        distance_below: m.global_line_id - member.global_line_id,
        career_level: m.career_level,
        career_title: m.career_title,
      }));

    res.json({
      status: 'success',
      endpoint: 'GET /api/v1/user/monoline-line',
      data: {
        current_user: {
          id: member.id,
          external_app_user_id: member.user_id,
          full_name: member.full_name,
          monoline_position: member.global_line_id,
        },
        users_ahead_last_10: ahead10,
        users_behind_next_10: behind10,
      },
    });
  });

  // 3. GET /api/v1/user/team
  // Dönen veri: 7 derinlikteki sponsor ekibinin listesi ve kariyer durumları.
  app.get('/api/v1/user/team', (req, res) => {
    const userId = String(req.query.user_id || 'USR-1001');
    const member =
      members.find((m) => m.user_id === userId || String(m.id) === userId) || members[0];

    const depths: Array<{
      depth_level: number;
      count: number;
      members: Array<{
        id: number;
        external_app_user_id: string;
        full_name: string;
        monoline_position: number;
        career_level: number;
        career_title: string;
        personal_volume: number;
      }>;
    }> = [];

    let currentParentIds = [member.user_id];
    for (let d = 1; d <= 7; d++) {
      const children = members.filter(
        (m) => m.sponsor_id && currentParentIds.includes(m.sponsor_id)
      );
      depths.push({
        depth_level: d,
        count: children.length,
        members: children.map((c) => ({
          id: c.id,
          external_app_user_id: c.user_id,
          full_name: c.full_name,
          monoline_position: c.global_line_id,
          career_level: c.career_level,
          career_title: c.career_title,
          personal_volume: c.personal_volume,
        })),
      });
      currentParentIds = children.map((c) => c.user_id);
    }

    res.json({
      status: 'success',
      endpoint: 'GET /api/v1/user/team',
      data: {
        sponsor_user_id: member.user_id,
        sponsor_name: member.full_name,
        unilevel_7_depths: depths,
      },
    });
  });

  // 4. POST /api/v1/user/withdrawal-request
  // Middleware: Cüzdan çekim API'sine is_active güvenlik kontrolü
  function requireActiveDealerForWithdrawal(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    const member = members.find((m) => m.user_id === res.locals.memberUserId);

    if (!member) {
      res.status(404).json({
        status: 'error',
        code: 'USER_NOT_FOUND',
        message: 'Üye bulunamadı.',
      });
      return;
    }

    // Süresi dolmuşsa otomatik pasife çek
    if (member.activity_expires_at) {
      const expMs = new Date(member.activity_expires_at).getTime();
      if (!isNaN(expMs) && expMs <= Date.now() && member.is_active) {
        const prevExp = member.activity_expires_at;
        member.is_active = false;
        logActivityEvent({
          member,
          action_type: 'CRON_EXPIRED_DEACTIVATED',
          previous_expires_at: prevExp,
          new_expires_at: prevExp,
          description: `Çekim isteği sırasında aktiflik süresinin dolduğu tespit edildi, hesap pasife alındı.`,
        });
      }
    }

    if (member.is_locked) {
      res.status(403).json({
        status: 'error',
        code: 'ACCOUNT_LOCKED',
        message: 'Hesabınız güvenlik kilidi altında olduğundan çekim talebi oluşturulamaz.',
        state: buildStateResponse(),
      });
      return;
    }

    if (!isActivityValid(member)) {
      logActivityEvent({
        member,
        action_type: 'WITHDRAWAL_BLOCKED_INACTIVE',
        previous_expires_at: member.activity_expires_at,
        new_expires_at: member.activity_expires_at,
        description: 'Çekim engeli: aktiflik süresi dolmuş veya hesap pasif olduğu için komisyon talebi reddedildi.',
      });
      res.status(403).json({
        status: 'error',
        code: 'WITHDRAWAL_CONDITION_NOT_MET',
        message:
          'Aktiflik süreniz dolduğu için komisyon talebinde bulunamazsınız. Lütfen aktifliğinizi yenileyin.',
        state: buildStateResponse(),
      });
      return;
    }

    next();
  }

  // Body: { user_id?, amount, method: 'IBAN'|'TRC20', address }
  // İşlem: Kullanıcının bakiyesini düşüp talebi PENDING olarak kaydeder (Atomic Transaction).
  app.post(
    '/api/v1/user/withdrawal-request',
    requireWithdrawalMember,
    requireActiveDealerForWithdrawal,
    async (req, res) => {
    try {
      const result = await runInAtomicTransaction(() => {
        const { amount, method, address, holder_name, bank_name, region, channel, swift_code } =
          req.body;
        const member = members.find((m) => m.user_id === res.locals.memberUserId);

        if (!member) {
          throw new Error('Üye bulunamadı.');
        }
        if (member.is_locked || !member.is_active) {
          throw new Error('Hesap kilitli veya pasif olduğundan çekim talebi oluşturulamaz.');
        }

        const payoutRegion: MemberRegion = region ?? resolveMemberRegion(member.country_code);
        if (payoutRegion !== 'DOMESTIC' && payoutRegion !== 'INTERNATIONAL') {
          throw new Error('Geçersiz çekim bölgesi.');
        }

        const reqAmount = roundCurrency(Number(amount));
        if (isNaN(reqAmount) || reqAmount < MIN_WITHDRAWAL_USD) {
          throw new Error(`Minimum çekim talebi tutarı $${MIN_WITHDRAWAL_USD.toFixed(2)} olmalıdır.`);
        }
        const availableUsd = member.wallets[getRegionWalletKey(payoutRegion)] ?? 0;
        if (reqAmount > availableUsd) {
          throw new Error(`Yetersiz çekilebilir bakiye (Mevcut: $${availableUsd.toFixed(2)}).`);
        }

        // V2.1 Velocity Limits: Günlük çekim limiti üyenin kariyer seviyesine göre belirlenir.
        const todayPrefix = new Date().toISOString().slice(0, 10);
        const withdrawnToday = withdrawalRequests
          .filter(
            (w) =>
              w.user_id === member.id &&
              w.status !== 'REJECTED' &&
              w.created_at.startsWith(todayPrefix)
          )
          .reduce((sum, w) => sum + (w.gross_amount ?? w.amount), 0);

        const dailyLimit = member.daily_withdrawal_limit ?? DAILY_WITHDRAWAL_LIMITS_BY_CAREER[1];
        if (roundCurrency(withdrawnToday + reqAmount) > dailyLimit) {
          const velocityMsg = `Günlük Çekim Limiti (Velocity Limit) Aşıldı: günlük maksimum çekim limiti $${dailyLimit.toFixed(2)} (Bugün kullanılan: $${withdrawnToday.toFixed(2)}, Talep: $${reqAmount.toFixed(2)}).`;
          fraudAlerts.unshift({
            id: nextFraudAlertId++,
            user_id: member.id,
            external_user_id: member.user_id,
            user_full_name: member.full_name,
            rule_code: 'VELOCITY_LIMIT_EXCEEDED',
            ip_address: member.last_login_ip || '176.240.10.1',
            status: 'REJECTED_BLOCKED',
            details: velocityMsg,
            created_at: new Date().toISOString(),
          });
          throw new Error(velocityMsg);
        }

        if (method && method !== 'IBAN') {
          throw new Error('Komisyon çekimleri yalnızca IBAN hesabına yapılabilir.');
        }

        const payoutMethod: 'IBAN' = 'IBAN';
        const payoutChannel: WithdrawalChannel = getPayoutChannelForRegion(payoutRegion, channel);
        const submittedHolder = (
          holder_name ||
          member.bank_details.iban_holder_name ||
          member.full_name ||
          ''
        ).trim();

        if (
          submittedHolder &&
          member.full_name &&
          submittedHolder.toLocaleLowerCase('tr-TR') !==
            member.full_name.trim().toLocaleLowerCase('tr-TR')
        ) {
          throw new Error(
            `İsim Eşleşmesi Zorunluluğu (Cross-Check): Komisyon çekimi yalnızca kendi adınıza (${member.full_name}) kayıtlı hesaba yapılabilir. Farklı bir isme (${submittedHolder}) ödeme yapılamaz.`
          );
        }

        const payoutAddress = normalizeIban(
          String(address || (payoutRegion === 'DOMESTIC' ? member.bank_details.iban : '') || '')
        );
        const payoutSwift = payoutChannel === 'SWIFT' ? normalizeBic(String(swift_code || '')) : undefined;
        const payoutError = validateWithdrawalPayout({
          region: payoutRegion,
          channel: payoutChannel,
          iban: payoutAddress,
          swiftCode: payoutSwift,
        });
        if (payoutError) {
          throw new Error(payoutError);
        }

        // KURAL: Bayiler nakit çekim talebi oluşturduklarında %20 vergi kesilir ve Sistem Fonuna aktarılır.
        // Vergi iadesini (%20) isteyen bayiler fatura keserek cihazdan yükler; yönetici onayladığında hesaplarına aktarılır.
        const taxRatePercent = 20;
        const grossAmount = reqAmount;
        const taxDeduction = roundCurrency(grossAmount * WITHDRAWAL_TAX_RATE);
        const netAmount = roundCurrency(grossAmount - taxDeduction);

        const taxDeductionTry = usdToTry(taxDeduction);
        debitMemberRegionalUsd(member, grossAmount, payoutRegion);

        // Kesilen %20 vergiyi Sistem Fonuna (systemCareerFundBalance & systemWallet) aktar
        addSystemPoolBalance(taxDeductionTry);
        systemWallet.system_pool_balance = roundCurrency(
          systemWallet.system_pool_balance + taxDeductionTry
        );
        systemWallet.updated_at = new Date().toISOString();

        const {
          invoice_no,
          invoice_number,
          tax_office_and_id,
          tax_id_or_tckn,
          invoice_file_name,
          invoice_file_type,
          invoice_file_size,
          invoice_data_url,
          invoice_file_data_url,
        } = req.body || {};

        const finalInvoiceDataUrl = invoice_data_url || invoice_file_data_url;
        const finalInvoiceNo = invoice_no || invoice_number;
        const finalTaxOfficeAndId = tax_office_and_id || tax_id_or_tckn;

        const hasUploadedInvoice = Boolean(finalInvoiceDataUrl && invoice_file_name);
        const wdId = nextWithdrawalId++;
        const nowIso = new Date().toISOString();

        let createdInvoice: TaxRefundInvoiceRecord | null = null;
        if (hasUploadedInvoice) {
          const invId = nextTaxRefundId++;
          createdInvoice = {
            id: invId,
            refund_code: `TAX-REF-${1000 + invId}`,
            withdrawal_id: wdId,
            user_id: member.id,
            external_user_id: member.user_id,
            user_full_name: member.full_name,
            career_title: member.career_title,
            career_level: member.career_level,
            gross_withdrawal_amount: grossAmount,
            tax_deducted_amount: taxDeduction,
            net_withdrawal_amount: netAmount,
            invoice_no: String(finalInvoiceNo || `FAT-${Date.now().toString().slice(-6)}`).trim(),
            tax_office_and_id: String(finalTaxOfficeAndId || member.city || 'Türkiye').trim(),
            invoice_file_name: String(invoice_file_name),
            invoice_file_type: String(invoice_file_type || 'application/octet-stream'),
            invoice_file_size: Number(invoice_file_size) || 0,
            invoice_data_url: String(finalInvoiceDataUrl),
            iban: String(payoutAddress),
            bank_name: bank_name || member.bank_details.bank_name || 'Banka Hesabı',
            holder_name: holder_name || member.bank_details.iban_holder_name || member.full_name,
            status: 'PENDING_ADMIN_APPROVAL',
            requested_at: nowIso,
            processed_at: null,
            admin_note: 'Bayi nakit çekim anında faturasını cihazdan yükledi; Yönetici Vergi İadesi onayı bekliyor.',
          };
          taxRefundInvoices.unshift(createdInvoice);
        }

        const newWithdrawal: WithdrawalRequestRecord = {
          id: wdId,
          user_id: member.id,
          external_user_id: member.user_id,
          user_full_name: member.full_name,
          monoline_position: member.global_line_id,
          career_title: member.career_title,
          career_level: member.career_level,
          amount: grossAmount,
          gross_amount: grossAmount,
          tax_deduction: taxDeduction,
          net_amount: netAmount,
          tax_rate_percent: taxRatePercent,
          has_tax_company: Boolean(member.has_tax_company),
          tc_identity_no: member.tc_identity_no || '11111111110',
          method: payoutMethod,
          payout_method: payoutMethod,
          payout_address: String(payoutAddress),
          region: payoutRegion,
          channel: payoutChannel,
          currency: payoutRegion === 'INTERNATIONAL' ? 'USD' : 'TRY',
          bank_details: {
            method: payoutMethod,
            holder_name: holder_name || member.bank_details.iban_holder_name || member.full_name,
            bank_name: bank_name || member.bank_details.bank_name || undefined,
            iban: String(payoutAddress),
            swift_code: payoutSwift,
          },
          status: 'PENDING',
          created_at: nowIso,
          admin_note: hasUploadedInvoice
            ? `%20 Vergi ($${taxDeduction.toFixed(2)} ≈ ₺${taxDeductionTry.toLocaleString('tr-TR')}) Sistem Fonuna aktarıldı. Vergi İadesi faturası yüklendi.`
            : `%20 Vergi ($${taxDeduction.toFixed(2)} ≈ ₺${taxDeductionTry.toLocaleString('tr-TR')}) Sistem Fonuna aktarıldı.`,
          tax_refund_status: hasUploadedInvoice ? 'PENDING_ADMIN_APPROVAL' : 'NONE',
          tax_refund_invoice_id: createdInvoice ? createdInvoice.id : null,
          invoice_no: createdInvoice?.invoice_no,
          invoice_file_name: createdInvoice?.invoice_file_name,
          invoice_file_type: createdInvoice?.invoice_file_type,
          invoice_data_url: createdInvoice?.invoice_data_url,
        };

        withdrawalRequests.unshift(newWithdrawal);
        return { member, newWithdrawal, createdInvoice };
      });

      res.status(201).json({
        status: 'success',
        endpoint: 'POST /api/v1/user/withdrawal-request',
        message: result.createdInvoice
          ? `$${result.newWithdrawal.gross_amount?.toFixed(2)} Brüt Çekim Talebi oluşturuldu (%20 Vergi Kesintisi: -$${result.newWithdrawal.tax_deduction?.toFixed(2)} Sistem Fonuna aktarıldı → Net Ödenecek: $${result.newWithdrawal.net_amount?.toFixed(2)}). Yüklediğiniz fatura (${result.createdInvoice.invoice_file_name}) Yönetici Vergi İadesi Paneline iletildi!`
          : `$${result.newWithdrawal.gross_amount?.toFixed(2)} Brüt Çekim Talebi oluşturuldu (%20 Vergi Kesintisi: -$${result.newWithdrawal.tax_deduction?.toFixed(2)} Sistem Fonuna aktarıldı → Bankaya Yatacak Net: $${result.newWithdrawal.net_amount?.toFixed(2)}). %20 Vergi iadesi almak için faturanızı cihazdan yükleyebilirsiniz.`,
        withdrawal: result.newWithdrawal,
        tax_refund_invoice: result.createdInvoice,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Çekim talebi oluşturulamadı.',
      });
    }
  });

  // Alias for backward compatibility
  app.post('/api/v1/withdrawals', (req, res) => {
    const { user_id, amount, method, iban, trc20_address, holder_name, bank_name, region, channel, swift_code } =
      req.body;
    req.body.address = method === 'TRC20' ? trc20_address : iban;
    req.body.user_id = user_id;
    req.body.amount = amount;
    req.body.method = method;
    req.body.holder_name = holder_name;
    req.body.bank_name = bank_name;
    req.body.region = region;
    req.body.channel = channel;
    req.body.swift_code = swift_code;
    // Forward to the same handler logic
    const targetUrl = '/api/v1/user/withdrawal-request';
    req.url = targetUrl;
    app._router.handle(req, res, () => {});
  });

  // ============================================================================
  // SECTION 4: 🛡️ ADMIN PANELİ ENDPOINT'LERİ (EXACT SPECIFICATION ROUTES)
  // ============================================================================

  // 1. GET /api/v1/admin/stats
  // Dönen veri: Toplam üye, Küresel Hat uzunluğu, Sistem Fonu Havuz Bakiyesi, Bekleyen Ödeme Talebi Sayısı.
  app.get('/api/v1/admin/stats', requireAdminJwt, (_req, res) => {
    const pendingCount = withdrawalRequests.filter((w) => w.status === 'PENDING').length;
    res.json({
      status: 'success',
      endpoint: 'GET /api/v1/admin/stats',
      data: {
        total_users: members.length,
        global_monoline_length: members.length,
        system_fund_balance: systemCareerFundBalance,
        system_fund_cumulative: systemCareerFundCumulative,
        pending_withdrawal_requests_count: pendingCount,
        idempotent_duplicate_orders_blocked: idempotentBlockedCount,
      },
    });
  });

  // 2. GET /api/v1/admin/withdrawals
  // Dönen veri: Bekleyen ve tamamlanan tüm çekim talepleri.
  app.get('/api/v1/admin/withdrawals', requireAdminJwt, (_req, res) => {
    res.json({
      status: 'success',
      endpoint: 'GET /api/v1/admin/withdrawals',
      data: withdrawalRequests,
    });
  });

  // 3. PUT /api/v1/admin/withdrawals/:id
  // Body: { status: 'APPROVED' | 'REJECTED' }
  app.put('/api/v1/admin/withdrawals/:id', requireAdminJwt, async (req, res) => {
    try {
      const reqId = Number(req.params.id);
      const { status, decision, admin_note } = req.body || {};
      const requestedStatus = status ?? decision;
      if (requestedStatus !== 'APPROVED' && requestedStatus !== 'REJECTED') {
        throw new Error('Çekim kararı APPROVED veya REJECTED olmalıdır.');
      }
      const targetStatus: 'APPROVED' | 'REJECTED' = requestedStatus;

      const updated = await runInAtomicTransaction(() => {
        const withdrawal = withdrawalRequests.find((w) => w.id === reqId);
        if (!withdrawal) {
          throw new Error('Çekim talebi bulunamadı.');
        }
        if (withdrawal.status !== 'PENDING') {
          throw new Error('Bu çekim talebi zaten işlenmiş.');
        }

        const member = members.find((m) => m.id === withdrawal.user_id);

        if (targetStatus === 'APPROVED') {
          withdrawal.status = 'APPROVED';
          withdrawal.processed_at = new Date().toISOString();
          withdrawal.admin_note = admin_note || 'Yönetici tarafından onaylandı ve ödendi.';
          if (member) {
            member.wallets.total_withdrawn = roundCurrency(
              member.wallets.total_withdrawn + withdrawal.amount
            );
          }
        } else {
          const grossAmount = withdrawal.gross_amount ?? withdrawal.amount;
          const taxDeduction = roundCurrency(grossAmount * WITHDRAWAL_TAX_RATE);
          const netRefund = roundCurrency(grossAmount - taxDeduction);
          withdrawal.tax_deduction = taxDeduction;
          withdrawal.net_amount = netRefund;
          withdrawal.tax_rate_percent = WITHDRAWAL_TAX_RATE * 100;
          const linkedInvoice = taxRefundInvoices.find(
            (invoice) =>
              invoice.id === withdrawal.tax_refund_invoice_id ||
              String(invoice.withdrawal_id) === String(withdrawal.id)
          );
          const previouslyRefundedTax =
            linkedInvoice?.status === 'APPROVED_CREDITED'
              ? linkedInvoice.tax_deducted_amount
              : 0;
          const refundedTaxTry = previouslyRefundedTax ? usdToTry(previouslyRefundedTax) : 0;

          if (previouslyRefundedTax && member) {
            debitMemberRegionalUsd(member, previouslyRefundedTax, withdrawal.region);
          }
          if (previouslyRefundedTax) {
            addSystemPoolBalance(refundedTaxTry);
            systemWallet.system_pool_balance = roundCurrency(
              systemWallet.system_pool_balance + refundedTaxTry
            );
            systemWallet.updated_at = new Date().toISOString();
          }
          if (member) {
            creditMemberRegionalUsd(member, netRefund, withdrawal.region);
          }
          if (linkedInvoice) {
            linkedInvoice.status = 'REJECTED';
            linkedInvoice.processed_at = new Date().toISOString();
            linkedInvoice.admin_note = 'Bağlı çekim talebi reddedildi; vergi iadesi uygulanamaz.';
            withdrawal.tax_refund_status = 'REJECTED';
          }
          withdrawal.status = 'REJECTED';
          withdrawal.processed_at = new Date().toISOString();
          withdrawal.admin_note = admin_note ||
            `Çekim reddedildi. Net tutar $${netRefund.toFixed(2)} bölgesel cüzdana iade edildi; $${taxDeduction.toFixed(2)} stopaj sistem fonunda tutuldu.`;
        }
        return withdrawal;
      });

      res.json({
        status: 'success',
        endpoint: `PUT /api/v1/admin/withdrawals/${reqId}`,
        message:
          targetStatus === 'APPROVED'
            ? `Talep #${updated.id} (${updated.amount.toLocaleString('tr-TR')} $) onaylandı.`
            : `Talep #${updated.id} reddedildi; %20 stopaj düşüldükten sonraki net tutar bölgesel cüzdana iade edildi.`,
        withdrawal: updated,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'İşlem başarısız.',
      });
    }
  });

  // Backward-compatible POST route for withdrawal decisions
  app.post('/api/v1/admin/withdrawals/:id/decision', requireAdminJwt, (req, res) => {
    req.method = 'PUT';
    req.url = `/api/v1/admin/withdrawals/${req.params.id}`;
    app._router.handle(req, res, () => {});
  });

  app.get('/api/v1/admin/exchange-rate', requireAdminJwt, (_req, res) => {
    res.json({ status: 'success', data: buildUsdTryRateResponse() });
  });

  app.post('/api/v1/admin/exchange-rate', requireAdminJwt, (req, res) => {
    const rawRate = req.body?.usd_try_rate;
    const rate = typeof rawRate === 'string' && rawRate.trim() === '' ? NaN : Number(rawRate);
    const newRate = Number.isFinite(rate) ? roundCurrency(rate) : 0;
    if (!(newRate > 0)) {
      res.status(400).json({
        status: 'error',
        message: 'Kur pozitif bir sayı olmalıdır (1 USD = X TRY).',
      });
      return;
    }
    const previousRate = usdTryRate;
    const now = new Date().toISOString();
    usdTryRate = newRate;
    usdTryRateUpdatedAt = now;
    usdTryRateUpdatedBy = res.locals.adminUid;
    adminAuditLogs.unshift({
      id: nextAdminAuditLogId++,
      action: 'USD_TRY_RATE_UPDATED',
      admin_uid: res.locals.adminUid,
      previous_value: previousRate,
      new_value: newRate,
      created_at: now,
    });
    res.json({ status: 'success', data: buildUsdTryRateResponse() });
  });

  // 4. POST /api/v1/admin/settings
  // Body: Dağıtım yüzdeleri ve kariyer kurallarının güncellenmesi.
  app.post('/api/v1/admin/settings', requireAdminJwt, (req, res) => {
    const { tiers } = req.body || {};

    if (Array.isArray(tiers) && tiers.length === 7) {
      careerTiers = careerTiers.map((existing, idx) => {
        const incoming = tiers[idx];
        if (!incoming) return existing;
        const newMinVol = Math.max(
          0,
          Number(incoming.minPersonalVolume ?? existing.minPersonalVolume)
        );
        const newMinDir = Math.max(
          0,
          Number(incoming.minActiveDirects ?? existing.minActiveDirects)
        );
        const newMinGroupVol = Math.max(
          0,
          Number(incoming.minGroupVolume ?? existing.minGroupVolume ?? 0)
        );
        const newEnforceSingleLeg =
          typeof incoming.enforceMaxSingleLegPercent === 'boolean'
            ? incoming.enforceMaxSingleLegPercent
            : existing.enforceMaxSingleLegPercent;
        const newMaxSingleLegPct = Math.max(
          10,
          Math.min(100, Number(incoming.maxSingleLegPercent ?? existing.maxSingleLegPercent ?? 50))
        );
        const newDownlineReqs = Array.isArray(incoming.requiredDownlineCareers)
          ? incoming.requiredDownlineCareers
              .map((r: any) => ({
                minCareerLevel: Math.max(1, Math.min(7, Number(r.minCareerLevel) || 2)),
                minCareerTitle:
                  String(r.minCareerTitle || '').trim() ||
                  INITIAL_CAREER_TIERS.find((t) => t.level === Number(r.minCareerLevel))?.title ||
                  'Levvâme',
                requiredCount: Math.max(1, Math.min(20, Number(r.requiredCount) || 1)),
              }))
              .filter((r: any) => r.requiredCount > 0)
          : existing.requiredDownlineCareers;

        const newBonusRate = Math.max(
          0,
          Number(incoming.poolBonusRate ?? existing.poolBonusRate)
        );
        const newFixedBonus = Math.max(
          0,
          Number(incoming.fixedCareerBonusAmount ?? existing.fixedCareerBonusAmount ?? 1000)
        );
        const newPkgId = normalizePackageId(incoming.minPackageId) || existing.minPackageId;
        const newUnlockedDepth = Math.max(
          1,
          Math.min(7, Number(incoming.unlockedDepth ?? existing.unlockedDepth))
        );
        const newEnforceStrict =
          typeof incoming.enforceStrictOrganizationRules === 'boolean'
            ? incoming.enforceStrictOrganizationRules
            : existing.enforceStrictOrganizationRules;
        const newPyramidPct = Math.max(
          0.1,
          Math.min(
            100,
            Number(incoming.idealNetworkPyramidPercent ?? existing.idealNetworkPyramidPercent)
          )
        );
        const newIdealCount1000 = Math.max(
          1,
          Math.round(Number(incoming.idealCountPer1000 ?? existing.idealCountPer1000))
        );

        return {
          ...existing,
          title: incoming.title ? String(incoming.title).trim() : existing.title,
          subtitle: incoming.subtitle ? String(incoming.subtitle).trim() : existing.subtitle,
          minPackageId: newPkgId,
          minPackageLabel: incoming.minPackageLabel
            ? String(incoming.minPackageLabel).trim()
            : PACKAGES[newPkgId].name,
          minPackageRank: existing.level === 1 ? 0 : PACKAGES[newPkgId].rankOrder,
          minPersonalVolume: newMinVol,
          minActiveDirects: newMinDir,
          minGroupVolume: newMinGroupVol,
          enforceMaxSingleLegPercent: newEnforceSingleLeg,
          maxSingleLegPercent: newMaxSingleLegPct,
          requiredDownlineCareers: newDownlineReqs,
          organizationRuleSummary: incoming.organizationRuleSummary
            ? String(incoming.organizationRuleSummary).trim()
            : existing.organizationRuleSummary,
          idealNetworkRatioLabel: incoming.idealNetworkRatioLabel
            ? String(incoming.idealNetworkRatioLabel).trim()
            : existing.idealNetworkRatioLabel,
          idealNetworkPyramidPercent: newPyramidPct,
          idealCountPer1000: newIdealCount1000,
          unlockedDepth: newUnlockedDepth,
          poolBonusRate: newBonusRate,
          poolBonusLabel: incoming.poolBonusLabel
            ? String(incoming.poolBonusLabel).trim()
            : `${newUnlockedDepth}. Derinlik (%${existing.depthCommissionPercent}) · %${Math.round(
                newBonusRate * 100
              )} Havuz Payı`,
          fixedCareerBonusAmount: newFixedBonus,
          enforceStrictOrganizationRules: newEnforceStrict,
          meaning: incoming.meaning ? String(incoming.meaning).trim() : existing.meaning,
        };
      });

      recalculateAllCareers('MANUAL_ADMIN');
    }

    res.json({
      status: 'success',
      endpoint: 'POST /api/v1/admin/settings',
      message: '7 Nefis Mertebesi Kariyer Piramidi, Organizasyon, Grup Ciro (PGV), %50 Dengeli Hat ve Alt Ekip Kariyer Şartları başarıyla güncellendi.',
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/admin/career-tiers/reset', requireAdminJwt, (_req, res) => {
    careerTiers = structuredClone(INITIAL_CAREER_TIERS);
    recalculateAllCareers('MANUAL_ADMIN');
    res.json({
      status: 'success',
      message: '7 Nefis Mertebesi Kariyer & Organizasyon Matrisi varsayılan ideal piramit ayarlarına sıfırlandı.',
      state: buildStateResponse(),
    });
  });

  // Keep PUT aliases for parameters and careers
  app.put('/api/v1/admin/parameters', requireAdminJwt, (req, res) => {
    req.method = 'POST';
    req.url = '/api/v1/admin/settings';
    app._router.handle(req, res, () => {});
  });

  app.put('/api/v1/admin/careers', requireAdminJwt, (req, res) => {
    req.method = 'POST';
    req.url = '/api/v1/admin/settings';
    app._router.handle(req, res, () => {});
  });

  // Section 3: Manual / Nightly Cron Job Career Trigger Endpoint
  app.post('/api/v1/cron/career-trigger', requireAdminJwt, (_req, res) => {
    const upgrades = recalculateAllCareers('NIGHTLY_CRON');
    const deactivated = checkAndExpireAccountsCron('NIGHTLY_CRON');
    res.json({
      status: 'success',
      endpoint: 'POST /api/v1/cron/career-trigger',
      message: `Kariyer & Aktiflik Cron Job çalıştırıldı: ${members.length} üye tarandı, ${upgrades.length} yeni terfi gerçekleşti, süresi dolan ${deactivated.length} hesap pasife alındı.`,
      upgrades,
      deactivated,
      state: buildStateResponse(),
    });
  });

  // Süresi dolan hesapları otomatik tespit eden Cron Job Endpoint'i
  app.post('/api/v1/cron/activity-check', (_req, res) => {
    const deactivated = checkAndExpireAccountsCron('ACTIVITY_EXPIRY_CRON');
    res.json({
      status: 'success',
      endpoint: 'POST /api/v1/cron/activity-check',
      message:
        deactivated.length > 0
          ? `Aktiflik Cron Job tamamlandı: Süresi dolan ${deactivated.length} bayi hesabı otomatik tespit edilerek pasife (is_active = false) alındı.`
          : `Aktiflik Cron Job tamamlandı: ${members.length} bayi hesabı tarandı, süresi dolan hesap bulunmadı.`,
      deactivated_users: deactivated,
      state: buildStateResponse(),
    });
  });

  // Bayi veya Admin tarafından Aktiflik Süresi Güncelleme Endpoint'i
  app.post('/api/v1/members/:userId/activity-action', requireAdminOrOwnMember, async (req, res) => {
    try {
      const member = members.find((m) => m.user_id === req.params.userId);
      if (!member) {
        res.status(404).json({ status: 'error', message: 'Bayi bulunamadı.' });
        return;
      }

      const { action }: { action: 'RENEW_PACKAGE' | 'EXPIRE_NOW' } = req.body || {};
      const isAdminCaller = Boolean(res.locals.adminUid);
      if (!isAdminCaller && action !== 'RENEW_PACKAGE') {
        res.status(403).json({
          status: 'error',
          code: 'ADMIN_ONLY_ACTION',
          message: 'Bu aktiflik işlemi yalnızca admin tarafından yapılabilir.',
        });
        return;
      }
      if (action !== 'RENEW_PACKAGE' && action !== 'EXPIRE_NOW') {
        res.status(400).json({ status: 'error', message: 'Geçersiz aktiflik işlemi.' });
        return;
      }

      const prevExp = member.activity_expires_at || null;
      let actionMsg = '';

      if (action === 'RENEW_PACKAGE') {
        const cost = getActivationOrderAmount(member.user_id);
        const tx = await runInAtomicTransaction(() =>
          chargeActivationRenewal(member, new Date().toISOString(), 'ORD-AKTIFLIK')
        );
        res.json({
          status: 'success',
          message: `${member.full_name} için 30 Günlük Süre Uzatma Paketi ($${cost.toLocaleString(
            'en-US'
          )}) bölgesel cüzdandan tahsil edildi ve aktiflik +${ACTIVITY_PERIOD_DAYS} gün uzatıldı.`,
          transaction: tx,
          state: buildStateResponse(),
        });
        return;
      }

      if (action === 'EXPIRE_NOW') {
        member.activity_expires_at = new Date(Date.now() - 60000).toISOString();
        checkAndExpireAccountsCron('MANUAL_ADMIN');
        actionMsg = `${member.full_name} aktiflik süresi sonlandırıldı ve Cron Job tarafından pasife (is_active = false) alındı.`;
      }

      res.json({
        status: 'success',
        message: actionMsg || 'Bayi aktiflik durumu güncellendi.',
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({
        status: 'error',
        code: err?.code,
        message: err?.message || 'Aktiflik işlemi uygulanamadı.',
      });
    }
  });

  // Admin panelinden bayi aktiflik yönetimi uç noktası (/api/v1/admin/member-activity-action)
  app.post('/api/v1/admin/member-activity-action', requireAdminJwt, (req, res) => {
    try {
      const { user_id, action } = req.body || {};
      if (action !== 'EXPIRE_NOW') {
        res.status(400).json({ status: 'error', message: 'Yalnızca test amaçlı pasifleştirme işlemi desteklenir.' });
        return;
      }
      const member = members.find((m) => m.user_id === user_id);
      if (!member) {
        res.status(404).json({ status: 'error', message: 'Bayi bulunamadı.' });
        return;
      }

      const prevExp = member.activity_expires_at || null;
      let actionMsg = '';

      if (action === 'EXPIRE_NOW') {
        member.activity_expires_at = new Date(Date.now() - 60000).toISOString();
        checkAndExpireAccountsCron('MANUAL_ADMIN');
        actionMsg = `${member.full_name} aktiflik süresi sonlandırıldı ve hesap pasife alındı.`;
      }

      logActivityEvent({
        member,
        action_type: 'ADMIN_MANUAL_UPDATE',
        previous_expires_at: prevExp,
        new_expires_at: member.activity_expires_at,
        description: actionMsg,
      });

      res.json({
        status: 'success',
        message: actionMsg,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Bayi aktiflik işlemi başarısız.',
      });
    }
  });

  // ============================================================================
  // SECTION 3: ASENKRON WEBHOOK & QUEUE İŞLEME MOTORU
  // A) Webhook Controller (POST /api/v1/integrations/order-commission)
  // B) Background Worker (Kuyruk İşleyici & Komisyon Dağıtım Algoritması)
  // const { Queue, Worker } = require('bullmq');
  // const commissionQueue = new Queue('commission-processing', { connection: redisConfig });
  // const worker = new Worker('commission-processing', async (job) => { ... }, { connection: redisConfig });
  // ============================================================================
  const worker = {
    queueName: 'commission-processing',
    process: async (job: {
      name: 'process-commission';
      data: OrderCommissionPayload;
      opts: { attempts: number; backoff: number };
    }): Promise<CommissionTransaction> => {
      return runInAtomicTransaction(() =>
        processOrderCommission({
          ...job.data,
          user_id: String(job.data.user_id),
          order_id: String(job.data.order_id),
          order_amount: Number(job.data.order_amount),
          package_id: String(job.data.package_id || 'PKG_MINI_DENEME'),
          timestamp: job.data.timestamp || new Date().toISOString(),
        })
      );
    },
  };

  const commissionQueue = {
    name: 'commission-processing',
    add: async (
      jobName: 'process-commission',
      jobData: OrderCommissionPayload,
      opts: { attempts: number; backoff: number } = { attempts: 3, backoff: 5000 }
    ): Promise<CommissionTransaction> => {
      return worker.process({
        name: jobName,
        data: jobData,
        opts,
      });
    },
  };

  async function handleOrderWebhook(req: express.Request, res: express.Response) {
    if (!sandboxPaymentsEnabled()) {
      return res.status(503).json({ status: 'error', message: 'Sandbox settlement üretim ortamında kapalıdır.' });
    }
    const startMs = Date.now();
    let claimedPayment: { consumed: boolean } | undefined;
    try {
      const {
        user_id,
        order_id,
        order_amount,
        package_id,
        timestamp,
        enforce_career_depth_lock,
        order_type,
        payment_method,
        merchant_oid,
        transaction_id,
      } = req.body as OrderCommissionPayload;

      if (!user_id || order_amount === undefined || order_amount === null) {
        webhookLogs.unshift({
          id: `WH-${Date.now().toString().slice(-5)}-ERR`,
          endpoint: 'POST /api/v1/integrations/order-commission',
          http_status: 400,
          status: 'FAILED',
          order_id: String(order_id || 'BİLİNMİYOR'),
          user_id: String(user_id || 'BOŞ'),
          order_amount: Number(order_amount || 0),
          payload_json: JSON.stringify(req.body),
          response_message:
            '400 Bad Request — Zorunlu alanlar eksik: user_id ve order_amount gereklidir.',
          processing_ms: Math.max(2, Date.now() - startMs),
          created_at: new Date().toISOString(),
        });
        return res.status(400).json({
          status: 'error',
          message: 'Zorunlu alanlar eksik: user_id ve order_amount gereklidir.',
          state: buildStateResponse(),
        });
      }

      const normalizedOrderId = String(order_id || `ORD-${Date.now().toString().slice(-6)}`).trim();

      // 1. Idempotency Kontrolü:
      // const existingOrder = await db.query('SELECT order_id FROM orders_log WHERE order_id = $1', [order_id]);
      const existingOrder = ordersLog.find((o) => o.order_id === normalizedOrderId);
      if (existingOrder || processedOrderIds.has(normalizedOrderId)) {
        idempotentBlockedCount++;
        webhookLogs.unshift({
          id: `WH-${Date.now().toString().slice(-5)}-IDEMP`,
          endpoint: 'POST /api/v1/integrations/order-commission',
          http_status: 200,
          status: 'IDEMPOTENT_REJECTED',
          order_id: normalizedOrderId,
          user_id: String(user_id),
          order_amount: Number(order_amount),
          payload_json: JSON.stringify(req.body),
          response_message: `200 ALREADY_RECEIVED — SELECT order_id FROM orders_log WHERE order_id = '${normalizedOrderId}' → Sipariş zaten kayıtlı.`,
          processing_ms: Math.max(1, Date.now() - startMs),
          created_at: new Date().toISOString(),
        });
        return res.status(200).json({
          status: 'ALREADY_RECEIVED',
          code: 'IDEMPOTENCY_DUPLICATE_ORDER_ID',
          message: 'Sipariş zaten kayıtlı.',
          state: buildStateResponse(),
        });
      }

      if (order_type === 'ACTIVATION') {
        if (Math.round(getActivationOrderAmount(String(user_id)) * 100) !== Math.round(Number(order_amount) * 100)) {
          return res.status(400).json({
            status: 'error',
            code: 'ACTIVATION_AMOUNT_MISMATCH',
            message: 'Aktiflik tutarı bölgenizin sabit tutarıyla (Yurtiçi $100 / Yurtdışı $300) eşleşmiyor.',
          });
        }
      } else {
        const normalizedPackageId = normalizePackageId(String(package_id || ''));
        if (!normalizedPackageId || Math.round(getPackageOrderAmount(String(user_id), normalizedPackageId) * 100) !== Math.round(Number(order_amount) * 100)) {
          return res.status(400).json({
            status: 'error',
            code: 'PACKAGE_AMOUNT_MISMATCH',
            message: 'Sipariş tutarı seçilen paketin sunucu fiyatıyla eşleşmiyor.',
          });
        }
      }
      const requiredContracts = new Set(['DISTANCE_SALES', 'PRE_INFORMATION', 'MLM_TERMS', 'KVKK']);
      userContractApprovals.forEach((approval) => {
        if (
          approval.order_id === normalizedOrderId &&
          approval.user_id === String(user_id) &&
          Math.round(Number(approval.order_amount) * 100) === Math.round(Number(order_amount) * 100) &&
          Boolean(approval.product_summary)
        ) {
          requiredContracts.delete(approval.contract_type);
        }
      });
      if (requiredContracts.size) {
        return res.status(400).json({
          status: 'error',
          code: 'CONTRACT_APPROVALS_MISSING',
          message: 'Sipariş için zorunlu sözleşme onayları kayıtlı değil.',
        });
      }
      if (payment_method !== 'CARD_3D' && payment_method !== 'CREDIT_CARD_3D') {
        return res.status(402).json({
          status: 'error',
          code: 'PAYMENT_METHOD_NOT_VERIFIED',
          message: 'Komisyon ve kredi teslimatı için doğrulanmış 3D Sanal POS ödemesi gerekir.',
        });
      }
      {
        const verifiedPayment = completedPayments.get(String(merchant_oid || ''));
        const amountInCents = Math.round(Number(order_amount) * 100);
        if (
          !verifiedPayment ||
          verifiedPayment.consumed ||
          verifiedPayment.transaction_id !== transaction_id ||
          verifiedPayment.order_id !== normalizedOrderId ||
          verifiedPayment.user_id !== String(user_id) ||
          Math.round(verifiedPayment.amount * 100) !== amountInCents
        ) {
          return res.status(402).json({
            status: 'error',
            code: 'PAYMENT_NOT_VERIFIED',
            message: 'Sipariş, tamamlanmış Sanal POS işlemiyle eşleşmiyor.',
          });
        }
        verifiedPayment.consumed = true;
        claimedPayment = verifiedPayment;
      }

      // 2. Siparişi Geçici Olarak Kaydet:
      // INSERT INTO orders_log (order_id, user_id, package_id, amount) VALUES ($1, (SELECT id FROM users WHERE external_app_user_id = $2), $3, $4)
      const matchedUser = members.find((m) => m.user_id === String(user_id));
      ordersLog.unshift({
        order_id: normalizedOrderId,
        user_id: matchedUser ? matchedUser.id : 0,
        external_user_id: String(user_id),
        user_full_name: matchedUser ? matchedUser.full_name : String(user_id),
        package_id: String(package_id || 'PKG_MINI_DENEME'),
        amount: Number(order_amount),
        status: 'PENDING',
        merchant_oid: String(merchant_oid),
        transaction_id: String(transaction_id),
        payment_method: String(payment_method),
        created_at: timestamp || new Date().toISOString(),
      });

      // 3. Kuyruğa İş Emri Ekle (Arka Planda Güvenli İşlenecek)
      const transaction = await commissionQueue.add(
        'process-commission',
        {
          user_id: String(user_id),
          order_id: normalizedOrderId,
          order_amount: Number(order_amount),
          package_id: String(package_id || 'PKG_MINI_DENEME'),
          timestamp: timestamp || new Date().toISOString(),
          enforce_career_depth_lock,
          order_type: order_type || 'STANDARD_ORDER',
          payment_method,
        },
        { attempts: 3, backoff: 5000 }
      );

      return res.status(200).json({
        success: true,
        status: 'success',
        webhook: 'POST /api/v1/integrations/order-commission',
        queue: 'commission-processing',
        job_name: 'process-commission',
        queue_options: { attempts: 3, backoff: 5000 },
        message: 'Sipariş kuyruğa alındı ve işleniyor.',
        detail_message: transaction.activity_extended
          ? `Sipariş kuyruğa alındı ve işleniyor. (+${transaction.session_credits_added} Kredi, Aktiflik süresi +${ACTIVITY_PERIOD_DAYS} gün uzatıldı)`
          : `Sipariş kuyruğa alındı ve işleniyor. (+${transaction.session_credits_added} Kredi ve komisyon dağıtımı tamamlandı)`,
        transaction,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      if (claimedPayment) claimedPayment.consumed = false;
      // Remove temporary orders_log entry if validation/processing threw before completion
      const failedOrderId = String(req.body?.order_id || '').trim();
      if (failedOrderId && !processedOrderIds.has(failedOrderId)) {
        ordersLog = ordersLog.filter((o) => !(o.order_id === failedOrderId && o.status === 'PENDING'));
      }

      const statusCode = err?.statusCode || 400;
      const isIdemp = Boolean(err?.isIdempotent);

      webhookLogs.unshift({
        id: `WH-${Date.now().toString().slice(-5)}-${isIdemp ? 'IDEMP' : 'ERR'}`,
        endpoint: 'POST /api/v1/integrations/order-commission',
        http_status: isIdemp ? 200 : statusCode,
        status: isIdemp ? 'IDEMPOTENT_REJECTED' : 'FAILED',
        order_id: String(req.body?.order_id || 'ERR'),
        user_id: String(req.body?.user_id || 'ERR'),
        order_amount: Number(req.body?.order_amount || 0),
        payload_json: JSON.stringify(req.body),
        response_message: `${isIdemp ? '200 ALREADY_RECEIVED' : `${statusCode} Bad Request`} — ${
          err?.message || 'Hata'
        }`,
        processing_ms: Math.max(1, Date.now() - startMs),
        created_at: new Date().toISOString(),
      });

      if (isIdemp) {
        return res.status(200).json({
          status: 'ALREADY_RECEIVED',
          code: 'IDEMPOTENCY_DUPLICATE_ORDER_ID',
          message: 'Sipariş zaten kayıtlı.',
          state: buildStateResponse(),
        });
      }

      return res.status(statusCode).json({
        status: 'error',
        code: 'WEBHOOK_ERROR',
        message: err?.message || 'Sipariş işlenirken hata oluştu.',
        state: buildStateResponse(),
      });
    }
  }

  app.post('/api/v1/integrations/order-commission', handleOrderWebhook);

  // Live Bi-Directional Synchronization Endpoint with Frekans Application (users, resellers, orders, dealer_package_orders)
  app.post('/api/v1/integrations/sync-frekans-data', async (req, res) => {
    try {
      const {
        members: frekansMembers = [],
        orders: frekansOrders = [],
        resetBeforeSync = false,
      } = req.body || {};

      await runInAtomicTransaction(() => {
        if (resetBeforeSync) {
          resetToCleanSlate(true);
        }

        const incomingMembers = Array.isArray(frekansMembers) ? [...frekansMembers] : [];
        incomingMembers.sort(
          (a, b) =>
            new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
        );

        // 1. Upsert all real Frekans members/dealers in chronological Monoline order
        for (const fm of incomingMembers) {
          if (!fm || !fm.uid) continue;
          const uid = String(fm.uid).trim();
          const email = String(fm.email || '').trim().toLowerCase();

          let existing = members.find(
            (m) => m.user_id === uid || (email && m.email && m.email.toLowerCase() === email)
          );

          const pkgKey =
            normalizePackageId(fm.packageId || 'PKG_MINI_DENEME') || 'PKG_MINI_DENEME';

          if (!existing) {
            const nextLineId = members.length + 1;
            const initialCreditsVal =
              typeof fm.creditsBalance === 'number' && fm.creditsBalance > 0
                ? fm.creditsBalance
                : WELCOME_BONUS_TOTAL_CREDITS;
            existing = {
              id: nextLineId,
              user_id: uid,
              global_line_id: nextLineId,
              ref_code:
                String(fm.referralCode || '').trim().toUpperCase() ||
                `AURA-BAYI-${1000 + nextLineId}`,
              full_name: String(fm.fullName || 'Frekans Bayi').trim(),
              email,
              phone: String(fm.phone || '').trim(),
              city: String(fm.city || 'Türkiye').trim(),
              joined_at: fm.createdAt || new Date().toISOString(),
              sponsor_id: null,
              sponsor_db_id: null,
              highest_package_id: pkgKey,
              session_credits: initialCreditsVal,
              personal_volume: 0,
              group_volume: 0,
              active_direct_referrals: 0,
              career_level: 1,
              career_title: 'Emmâre',
              manual_career_override: null,
              unlocked_depth: 1,
              wallets: {
                sponsor_wallet: 0,
                monoline_wallet: 0,
                career_pool_wallet: 0,
                total_earnings: 0,
    
                system_fund_balance: 0,
                total_withdrawn: 0,
              },
              bank_details: {
                iban_holder_name: String(fm.ibanHolder || fm.fullName || '').trim(),
                bank_name: String(fm.bankName || '').trim(),
                iban: String(fm.iban || '').trim(),
                trc20_address: '',
                preferred_method: 'IBAN',
              },
              two_factor: {
                enabled: false,
                secret_key: `JBSWY3DPEHPK3P${nextLineId}`,
                verified_at: null,
                backup_codes: [`NF-${nextLineId}-A1`],
              },
              is_active: fm.isAllowed !== false,
              is_locked: false,
              activity_expires_at: createFutureExpiryIso(),
              welcome_bonus_granted: true,
              welcome_bonus_credits: WELCOME_BONUS_TOTAL_CREDITS,
            };
            members.push(existing);
            logActivityEvent({
              member: existing,
              action_type: 'WELCOME_BONUS_GRANTED',
              previous_expires_at: existing.activity_expires_at,
              new_expires_at: existing.activity_expires_at,
              description: `🎁 İlk Bayi Kaydı Hoşgeldin Bonusu: ${existing.full_name} hesabına bir defaya mahsus 32+32 (Toplam ${WELCOME_BONUS_TOTAL_CREDITS}) Seans Kredisi otomatik tanımlandı.`,
            });
          } else {
            if (fm.fullName) existing.full_name = String(fm.fullName).trim();
            if (email) existing.email = email;
            if (fm.phone) existing.phone = String(fm.phone).trim();
            if (fm.city) existing.city = String(fm.city).trim();
            if (fm.referralCode) {
              existing.ref_code = String(fm.referralCode).trim().toUpperCase();
            }
            if (
              typeof fm.creditsBalance === 'number' &&
              fm.creditsBalance > (existing.session_credits || 0) &&
              !creditsOwnedByServer.has(existing.user_id)
            ) {
              existing.session_credits = fm.creditsBalance;
            }
            if (fm.bankName) existing.bank_details.bank_name = String(fm.bankName).trim();
            if (fm.iban) existing.bank_details.iban = String(fm.iban).trim();
            if (fm.ibanHolder) {
              existing.bank_details.iban_holder_name = String(fm.ibanHolder).trim();
            }
          }
        }

        // 2. Link sponsor_id and sponsor_db_id from Frekans resellerId / referredByCode
        for (const fm of incomingMembers) {
          if (!fm || !fm.uid) continue;
          const member = members.find((m) => m.user_id === String(fm.uid).trim());
          if (!member) continue;

          const refByCode = String(fm.referredByCode || '').trim().toUpperCase();
          const resId = String(fm.resellerId || '').trim();

          let sponsor: MonolineMember | undefined;
          if (resId && resId !== member.user_id) {
            sponsor = members.find(
              (m) =>
                m.user_id === resId ||
                (m.ref_code && m.ref_code.toUpperCase() === resId.toUpperCase())
            );
          }
          if (!sponsor && refByCode && refByCode !== member.ref_code) {
            sponsor = members.find(
              (m) => m.ref_code && m.ref_code.toUpperCase() === refByCode
            );
          }
          if (!sponsor && member.sponsor_id) {
            sponsor = members.find((m) => m.user_id === member.sponsor_id);
          }
          if (!sponsor && member.global_line_id > 1 && members[0]) {
            // If member has no explicit referral code and no existing sponsor, check if root admin exists as default sponsor
            sponsor = members[0].user_id !== member.user_id ? members[0] : undefined;
          }

          if (sponsor && sponsor.user_id !== member.user_id) {
            member.sponsor_id = sponsor.user_id;
            member.sponsor_db_id = sponsor.id;
          }
        }

        for (const m of members) {
          if (!m.activity_expires_at) {
            m.activity_expires_at = createFutureExpiryIso();
          }
        }

        recalculateAllCareers('POST_COMMISSION_EVENT');

        // 3. Process all real orders from Frekans chronologically
        // IMPORTANT: Since incomingMembers already carry their live creditsBalance from Frekans,
        // replaying historical orders must NOT add session_credits on top of creditsBalance again!
        const incomingOrders = Array.isArray(frekansOrders) ? [...frekansOrders] : [];
        incomingOrders.sort(
          (a, b) =>
            new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()
        );

        for (const ord of incomingOrders) {
          if (!ord || !ord.order_id || !ord.user_id) continue;
          const ordId = String(ord.order_id).trim();
          const amt = Number(ord.order_amount);
          if (isNaN(amt) || amt <= 0) continue;
          if (processedOrderIds.has(ordId)) continue;

          try {
            processOrderCommission({
              user_id: String(ord.user_id).trim(),
              order_id: ordId,
              order_amount: amt,
              package_id: String(ord.package_id || 'PKG_MINI_DENEME'),
              timestamp: ord.timestamp || new Date().toISOString(),
              reseller_name: ord.user_name,
              reseller_email: ord.user_email,
              skip_credit_addition: true,
            } as any);
          } catch {
            // skip invalid order
          }
        }

        // 4. Sync authoritative session_credits from Frekans member's reconciled creditsBalance
        for (const fm of incomingMembers) {
          if (!fm || !fm.uid) continue;
          const uid = String(fm.uid).trim();
          const email = String(fm.email || '').trim().toLowerCase();
          const member = members.find(
            (m) => m.user_id === uid || (email && m.email && m.email.toLowerCase() === email)
          );
          if (
            member &&
            typeof fm.creditsBalance === 'number' &&
            fm.creditsBalance >= 0 &&
            !creditsOwnedByServer.has(member.user_id)
          ) {
            member.session_credits = fm.creditsBalance;
          }
        }

        recalculateAllCareers('POST_COMMISSION_EVENT');
      });

      res.json({
        status: 'success',
        message: `Frekans uygulaması verileri senkronize edildi (${members.length} üye/bayi, ${transactions.length} alışveriş/sipariş).`,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Frekans senkronizasyonu sırasında hata oluştu.',
        state: buildStateResponse(),
      });
    }
  });

  app.post('/api/v1/members', async (req, res) => {
    try {
      const {
        user_id,
        full_name,
        email,
        phone,
        ref_code,
        city,
        country_code,
        sponsor_id,
        initial_package_id,
        manual_career_override,
        skip_initial_order,
        session_credits,
        password,
        assigned_leg,
      } = req.body;
      if (!full_name || String(full_name).trim().length < 2) {
        res.status(400).json({
          status: 'error',
          message: 'Bayi / Üye adı soyadı zorunludur.',
        });
        return;
      }
      const normalizedCountryCode = String(country_code || 'TR').trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(normalizedCountryCode)) {
        res.status(400).json({
          status: 'error',
          message: 'Ülke kodu ISO 3166-1 alpha-2 biçiminde olmalıdır (örn. TR, DE).',
        });
        return;
      }

      const result = await runInAtomicTransaction(() => {
        const normalizedEmail = String(email || '').trim().toLowerCase();
        if (normalizedEmail && members.some((existing) => existing.email.toLowerCase() === normalizedEmail)) {
          const error: any = new Error('Bu e-posta adresiyle kayıtlı bir bayi zaten var.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_EMAIL';
          throw error;
        }
        const requestedUserId = String(user_id || '').trim();
        if (requestedUserId && members.some((existing) => existing.user_id === requestedUserId)) {
          const error: any = new Error('Bu kullanıcı kimliği zaten kayıtlı.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_USER_ID';
          throw error;
        }
        const nextLineId = members.length + 1;
        const randSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newUserId = requestedUserId || `USR-${randSuffix}`;
        const pkgKey =
          normalizePackageId(initial_package_id || 'PKG_ALTIN_PRO') || 'PKG_ALTIN_PRO';
        const nowIso = new Date().toISOString();
        const sponsorMember =
          sponsor_id === '' || sponsor_id === null
            ? undefined
            : sponsor_id
            ? members.find((m) => m.user_id === sponsor_id)
            : members[0];

        const customRef = ref_code ? String(ref_code).trim().toUpperCase() : '';
        const manualCareer =
          manual_career_override !== undefined &&
          manual_career_override !== null &&
          manual_career_override !== ''
            ? Number(manual_career_override)
            : null;

        let finalLeg: 'LEFT' | 'RIGHT' = 'LEFT';
        if (assigned_leg === 'LEFT' || assigned_leg === 'RIGHT') {
          finalLeg = assigned_leg;
        } else if (sponsorMember) {
          const leftCount = members.filter(
            (m) => m.sponsor_id === sponsorMember.user_id && (m as any).assigned_leg === 'LEFT'
          ).length;
          const rightCount = members.filter(
            (m) => m.sponsor_id === sponsorMember.user_id && (m as any).assigned_leg === 'RIGHT'
          ).length;
          finalLeg = leftCount <= rightCount ? 'LEFT' : 'RIGHT';
        }

        const newMember: MonolineMember = {
          id: nextLineId,
          user_id: newUserId,
          global_line_id: nextLineId,
          ref_code: customRef || `AURA-BAYI-${Math.floor(1000 + Math.random() * 9000)}`,
          full_name: String(full_name).trim(),
          email:
            email && String(email).trim()
              ? String(email).trim()
              : `${String(full_name)
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, '.')
                  .replace(/\.+/g, '.')}@akngroupfrekans.com`,
          phone: phone ? String(phone).trim() : '',
          city: String(city || 'Türkiye').trim(),
          country_code: normalizedCountryCode,
          joined_at: nowIso,
          sponsor_id: sponsorMember ? sponsorMember.user_id : null,
          sponsor_db_id: sponsorMember ? sponsorMember.id : null,
          highest_package_id: pkgKey,
          session_credits:
            typeof session_credits === 'number' && session_credits > 0
              ? session_credits
              : skip_initial_order
              ? WELCOME_BONUS_TOTAL_CREDITS
              : 0,
          personal_volume: 0,
          group_volume: 0,
          active_direct_referrals: 0,
          career_level: 1, // Default: 1 (Emmâre)
          career_title: 'Emmâre',
          manual_career_override: manualCareer,
          unlocked_depth: 1,
          wallets: {
            sponsor_wallet: 0,
            monoline_wallet: 0,
            career_pool_wallet: 0,
            total_earnings: 0,
            wallet_domestic_usd: 0,
            wallet_international_usd: 0,

            system_fund_balance: 0,
            total_withdrawn: 0,
          },
          bank_details: {
            iban_holder_name: String(full_name).trim(),
            bank_name: 'Ziraat Bankası',
            iban: `TR${Math.floor(10 + Math.random() * 89)} 0001 0004 8271 9283 10${nextLineId}`,
            trc20_address: `T${Math.random()
              .toString(36)
              .substring(2, 15)
              .toUpperCase()}9X2K${nextLineId}`,
            preferred_method: 'IBAN',
          },
          two_factor: {
            enabled: false,
            secret_key: `JBSWY3DPEHPK3P${nextLineId + 20}`,
            verified_at: null,
            backup_codes: [`NF-${9000 + nextLineId}-A1`, `NF-${9000 + nextLineId}-B2`],
          },
          is_active: true,
          is_locked: false,
          activity_expires_at: createFutureExpiryIso(),
          welcome_bonus_granted: Boolean(skip_initial_order),
          welcome_bonus_credits: skip_initial_order ? WELCOME_BONUS_TOTAL_CREDITS : 0,
          tc_identity_no:
            req.body?.tc_identity_no ||
            `${Math.floor(10000000000 + Math.random() * 89999999999)}`,
          has_tax_company: Boolean(req.body?.has_tax_company),
          last_login_ip:
            req.body?.last_login_ip || `176.240.${Math.floor(10 + Math.random() * 200)}.${nextLineId}`,
          device_fingerprint: req.body?.device_fingerprint || `DEV-FP-${nextLineId}`,
          kvkk_approved_at: nowIso,
          contract_version: req.body?.contract_version || 'v2.0',
          daily_withdrawal_limit:
            DAILY_WITHDRAWAL_LIMITS_BY_CAREER[manualCareer || 1] || 5000,
          fast_start_awarded: false,
          assigned_leg: finalLeg,
          left_leg_volume: 0,
          right_leg_volume: 0,
        };

        members.push(newMember);

        if (skip_initial_order) {
          creditsOwnedByServer.add(newMember.user_id);
          logActivityEvent({
            member: newMember,
            action_type: 'WELCOME_BONUS_GRANTED',
            previous_expires_at: newMember.activity_expires_at,
            new_expires_at: newMember.activity_expires_at,
            description: `🎁 İlk Bayi Kaydı Hoşgeldin Bonusu: ${newMember.full_name} hesabına bir defaya mahsus 32+32 (Toplam ${WELCOME_BONUS_TOTAL_CREDITS}) Seans Kredisi otomatik tanımlandı.`,
          });
        }

        if (skip_initial_order) {
          recalculateAllCareers('MANUAL_ADMIN');
          if (password && String(password).length >= 4) {
            memberCredentials.set(newMember.user_id, hashMemberPassword(String(password)));
          }
          return { newMember, tx: null };
        }

        const orderAmt = getPackageOrderAmount(newUserId, pkgKey);

        const tx = processOrderCommission({
          user_id: newUserId,
          order_id: `ORD-KAYIT-${nextLineId}-${Date.now().toString().slice(-4)}`,
          order_amount: orderAmt,
          package_id: pkgKey,
          timestamp: nowIso,
        });
        if (password && String(password).length >= 4) {
          memberCredentials.set(newMember.user_id, hashMemberPassword(String(password)));
        }

        return { newMember, tx };
      });

      res.status(201).json({
        status: 'success',
        message: result.tx
          ? `${result.newMember.full_name} Global Tek Hat #${
              result.newMember.global_line_id
            } sırasına (${result.newMember.career_level}. Kariyer ${
              result.newMember.career_title
            } olarak) eklendi, 🎁 İlk Bayi Kaydı Hoşgeldin Bonusu dahil ${result.newMember.session_credits.toLocaleString(
              'tr-TR'
            )} Seans Kredisi (32+32) yüklendi ve komisyon dağıtıldı.`
          : `${result.newMember.full_name} Global Tek Hat #${result.newMember.global_line_id} sırasına başarıyla eklendi ve bir defaya mahsus 32+32 (${WELCOME_BONUS_TOTAL_CREDITS}) Hoşgeldin Bonusu Kredisi tanımlandı.`,
        member: result.newMember,
        transaction: result.tx,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Üye eklenirken hata oluştu.',
      });
    }
  });

  app.post('/api/v1/members/:userId/release-pending', (req, res) => {
    const member = members.find((m) => m.user_id === req.params.userId);
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }
    if (getMemberRegionalPendingUsd(member) <= 0) {
      res
        .status(400)
        .json({ status: 'error', message: 'Aktarılacak bekleyen komisyon bulunmuyor.' });
      return;
    }
    const released = getMemberRegionalPendingUsd(member);
    for (const region of ['DOMESTIC', 'INTERNATIONAL'] as const) {
      const pendingUsd = member.wallets[getRegionPendingKey(region)] || 0;
      if (pendingUsd > 0) {
        releaseRegionalPendingUsd(member, region, pendingUsd);
      }
    }

    res.json({
      status: 'success',
      message: `$${released.toFixed(2)} bekleyen komisyon çekilebilir USD bakiyesine aktarıldı.`,
      state: buildStateResponse(),
    });
  });

  app.put('/api/v1/members/:userId/profile', (req, res) => {
    const member = members.find((m) => m.user_id === req.params.userId);
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const {
      full_name,
      email,
      phone,
      city,
      iban_holder_name,
      bank_name,
      iban,
      trc20_address,
      preferred_method,
    } = req.body;

    if (full_name) {
      member.full_name = String(full_name).trim();
      member.bank_details.iban_holder_name = member.full_name;
    }
    if (email) member.email = String(email).trim();
    if (phone) member.phone = String(phone).trim();
    if (city) member.city = String(city).trim();

    // Banka Denetimi İsim Eşleşmesi (Cross-Check): IBAN hesap sahibi her zaman bayinin kendi adı soyadı olmalıdır
    member.bank_details.iban_holder_name = member.full_name;
    if (bank_name !== undefined) member.bank_details.bank_name = String(bank_name).trim();
    if (iban !== undefined) member.bank_details.iban = String(iban).trim();
    member.bank_details.preferred_method = 'IBAN';

    res.json({
      status: 'success',
      message: `${member.full_name} profil ve resmi Banka TR IBAN bilgileri (İsim Eşleşmesi Doğrulanmış) güncellendi.`,
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/members/:userId/sync-credits', (req, res) => {
    const targetId = String(req.params.userId || '').trim();
    const { session_credits, email, ref_code } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const cleanCode = String(ref_code || '').trim().toUpperCase();

    const member = members.find(
      (m) =>
        m.user_id === targetId ||
        (cleanEmail && m.email && m.email.toLowerCase() === cleanEmail) ||
        (cleanCode && m.ref_code && m.ref_code.toUpperCase() === cleanCode)
    );
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    if (typeof session_credits === 'number' && session_credits >= 0) {
      member.session_credits = Math.round(session_credits);
      creditsOwnedByServer.add(member.user_id);
    }

    res.json({
      status: 'success',
      session_credits: member.session_credits,
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/members/:userId/2fa', (req, res) => {
    const member = members.find((m) => m.user_id === req.params.userId);
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const { enabled, verification_code } = req.body;
    if (enabled && (!verification_code || String(verification_code).trim().length < 6)) {
      res.status(400).json({
        status: 'error',
        message: '2FA etkinleştirmek için 6 haneli doğrulama kodunu giriniz (Örn: 482910).',
      });
      return;
    }

    if (!member.two_factor) {
      member.two_factor = {
        enabled: false,
        secret_key: `JBSWY3DPEHPK3P${member.id || 1}`,
        verified_at: null,
        backup_codes: [`NF-${member.id || 1}-A1`],
      };
    }

    member.two_factor.enabled = Boolean(enabled);
    member.two_factor.verified_at = enabled ? new Date().toISOString() : null;

    res.json({
      status: 'success',
      message: member.two_factor.enabled
        ? 'İki Faktörlü Doğrulama (2FA / Google Authenticator) başarıyla etkinleştirildi.'
        : 'İki Faktörlü Doğrulama (2FA) devre dışı bırakıldı.',
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/admin/withdrawals/bulk-approve', requireAdminJwt, (_req, res) => {
    const pendingList = withdrawalRequests.filter((w) => w.status === 'PENDING');
    if (pendingList.length === 0) {
      res.status(400).json({ status: 'error', message: 'Bekleyen çekim talebi bulunmamaktadır.' });
      return;
    }

    let totalApprovedAmt = 0;
    const nowIso = new Date().toISOString();

    for (const w of pendingList) {
      w.status = 'APPROVED';
      w.processed_at = nowIso;
      w.admin_note = 'Toplu Ödeme (Batch Payout) ile onaylandı.';
      totalApprovedAmt = roundCurrency(totalApprovedAmt + w.amount);
      const member = members.find((m) => m.id === w.user_id);
      if (member) {
        member.wallets.total_withdrawn = roundCurrency(member.wallets.total_withdrawn + w.amount);
      }
    }

    res.json({
      status: 'success',
      message: `${pendingList.length} adet çekim talebi (${totalApprovedAmt.toLocaleString(
        'tr-TR'
      )} $) toplu olarak onaylandı.`,
      state: buildStateResponse(),
    });
  });

  app.put('/api/v1/admin/members/:userId', requireAdminJwt, (req, res) => {
    const member = members.find((m) => m.user_id === req.params.userId);
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const {
      is_active,
      is_locked,
      manual_career_override,
      sponsor_id,
      swap_direction,
      target_line_id,
      session_credits,
      full_name,
      city,
      ref_code,
      assigned_leg,
      left_leg_volume,
      right_leg_volume,
      personal_volume,
      group_volume,
    } = req.body;

    const prevExp = member.activity_expires_at;
    if (typeof is_active === 'boolean') {
      member.is_active = is_active;
    }
    if (typeof is_active === 'boolean') {
      logActivityEvent({
        member,
        action_type: 'ADMIN_MANUAL_UPDATE',
        previous_expires_at: prevExp,
        new_expires_at: member.activity_expires_at,
        description: `Yönetici güncellemesi: is_active=${member.is_active}`,
      });
    }
    if (typeof is_locked === 'boolean') member.is_locked = is_locked;
    if (typeof session_credits === 'number' && session_credits >= 0) {
      member.session_credits = Math.round(session_credits);
    }
    if (full_name && String(full_name).trim()) member.full_name = String(full_name).trim();
    if (city && String(city).trim()) member.city = String(city).trim();
    if (ref_code && String(ref_code).trim()) {
      member.ref_code = String(ref_code).trim().toUpperCase();
    }
    if (manual_career_override !== undefined) {
      member.manual_career_override =
        manual_career_override === null || manual_career_override === ''
          ? null
          : Number(manual_career_override);
    }
    if (sponsor_id !== undefined && sponsor_id !== member.user_id) {
      if (sponsor_id === '' || sponsor_id === null) {
        member.sponsor_id = null;
        member.sponsor_db_id = null;
      } else {
        const sp = members.find((m) => m.user_id === sponsor_id);
        member.sponsor_id = sp ? sp.user_id : null;
        member.sponsor_db_id = sp ? sp.id : null;
      }
    }

    if (assigned_leg) {
      (member as any).assigned_leg = assigned_leg;
    }
    if (left_leg_volume !== undefined) {
      (member as any).left_leg_volume = Number(left_leg_volume) || 0;
    }
    if (right_leg_volume !== undefined) {
      (member as any).right_leg_volume = Number(right_leg_volume) || 0;
    }
    if (personal_volume !== undefined) {
      member.personal_volume = Number(personal_volume) || 0;
    }
    if (group_volume !== undefined) {
      member.group_volume = Number(group_volume) || 0;
    }

    if (swap_direction === 'UP' && member.global_line_id > 1) {
      const upperMember = members.find((m) => m.global_line_id === member.global_line_id - 1);
      if (upperMember) {
        const tmp = member.global_line_id;
        member.global_line_id = upperMember.global_line_id;
        upperMember.global_line_id = tmp;
      }
    } else if (swap_direction === 'DOWN' && member.global_line_id < members.length) {
      const lowerMember = members.find((m) => m.global_line_id === member.global_line_id + 1);
      if (lowerMember) {
        const tmp = member.global_line_id;
        member.global_line_id = lowerMember.global_line_id;
        lowerMember.global_line_id = tmp;
      }
    } else if (
      typeof target_line_id === 'number' &&
      target_line_id >= 1 &&
      target_line_id <= members.length &&
      target_line_id !== member.global_line_id
    ) {
      const ordered = [...members].sort((a, b) => a.global_line_id - b.global_line_id);
      const fromIdx = ordered.findIndex((m) => m.user_id === member.user_id);
      if (fromIdx !== -1) {
        const [moved] = ordered.splice(fromIdx, 1);
        ordered.splice(target_line_id - 1, 0, moved);
        ordered.forEach((m, idx) => {
          m.global_line_id = idx + 1;
        });
      }
    }

    recalculateAllCareers('MANUAL_ADMIN');

    res.json({
      status: 'success',
      message: `${member.full_name} bayi yetki, sponsor ve Monoline sıra (#${member.global_line_id}) ayarları güncellendi.`,
      state: buildStateResponse(),
    });
  });

  app.delete('/api/v1/admin/members/:userId', requireAdminJwt, (req, res) => {
    const idx = members.findIndex((m) => m.user_id === req.params.userId);
    if (idx === -1) {
      res.status(404).json({ status: 'error', message: 'Silinecek bayi/üye bulunamadı.' });
      return;
    }

    const removed = members[idx];
    const fallbackSponsor = removed.sponsor_id
      ? members.find((m) => m.user_id === removed.sponsor_id && m.user_id !== removed.user_id)
      : members.find((m) => m.user_id !== removed.user_id);

    members.splice(idx, 1);

    // Reassign downline members whose sponsor was the deleted member
    for (const m of members) {
      if (m.sponsor_id === removed.user_id) {
        if (fallbackSponsor && fallbackSponsor.user_id !== m.user_id) {
          m.sponsor_id = fallbackSponsor.user_id;
          m.sponsor_db_id = fallbackSponsor.id;
        } else {
          m.sponsor_id = null;
          m.sponsor_db_id = null;
        }
      }
    }

    // Re-sequence Monoline global_line_id without gaps
    const ordered = [...members].sort((a, b) => a.global_line_id - b.global_line_id);
    ordered.forEach((m, i) => {
      m.global_line_id = i + 1;
    });

    recalculateAllCareers('MANUAL_ADMIN');

    res.json({
      status: 'success',
      message: `${removed.full_name} (${removed.user_id}) sistemden silindi ve Monoline tek hat sıralaması (1..${members.length}) yeniden düzenlendi.`,
      state: buildStateResponse(),
    });
  });

  // Instant Admin Career Bonus & Custom Wallet Bonus Payout Endpoint
  app.post('/api/v1/admin/bonuses/career-payout', requireAdminJwt, async (req, res) => {
    try {
      const {
        career_level,
        bonus_amount,
        tier_bonuses,
        match_mode = 'EXACT_LEVEL',
        target_user_id,
        note,
      } = req.body || {};

      const nowIso = new Date().toISOString();
      const distId = `BONUS-${Date.now().toString().slice(-6)}`;

      const result = await runInAtomicTransaction(() => {
        // Update stored fixedCareerBonusAmount if tier_bonuses map is provided
        if (tier_bonuses && typeof tier_bonuses === 'object') {
          for (const tier of careerTiers) {
            if (tier_bonuses[tier.level] !== undefined) {
              tier.fixedCareerBonusAmount = Math.max(0, Number(tier_bonuses[tier.level]) || 0);
            }
          }
        }

        // Case 1: Individual dealer bonus transfer
        if (target_user_id && target_user_id !== 'ALL') {
          const targetMember = members.find((m) => m.user_id === target_user_id);
          if (!targetMember) {
            throw new Error('Bonus aktarılacak bayi bulunamadı.');
          }
          const amt = roundCurrency(Number(bonus_amount) || 0);
          if (amt <= 0) {
            throw new Error('Geçerli bir bonus tutarı (> 0 $) giriniz.');
          }

          creditMemberWallet(targetMember, 'CAREER_POOL', amt);

          commissionLogs.unshift({
            id: nextCommissionLogId++,
            order_id: distId,
            source_user_id: 1,
            source_external_id: 'ADMIN_BONUS',
            source_user_name: note ? `Yönetici Bonusu (${note})` : 'Yönetici Kariyer Bonusu',
            target_user_id: targetMember.id,
            target_external_id: targetMember.user_id,
            target_user_name: targetMember.full_name,
            type: 'SYSTEM_POOL',
            commission_type: 'CAREER_POOL',
            depth_level: targetMember.career_level,
            amount: amt,
            created_at: nowIso,
          });

          const poolBefore = systemCareerFundBalance;
          systemCareerFundBalance = Math.max(0, roundCurrency(systemCareerFundBalance - amt));
          if (members[0]) {
            members[0].wallets.system_fund_balance = systemCareerFundBalance;
          }

          const record: PoolDistributionRecord = {
            distribution_id: distId,
            timestamp: nowIso,
            pool_balance_before: poolBefore,
            total_distributed: amt,
            pool_balance_after: systemCareerFundBalance,
            tier_Allocations: [
              {
                career_level: targetMember.career_level,
                career_title: `${targetMember.career_title} (${note || 'Özel Yönetici Bonusu'})`,
                bonus_rate_percent: 100,
                tier_pool_amount: amt,
                qualified_member_count: 1,
                amount_per_member: amt,
                recipients: [
                  {
                    user_id: targetMember.user_id,
                    full_name: targetMember.full_name,
                    amount: amt,
                  },
                ],
              },
            ],
          };
          poolDistributions.unshift(record);

          return {
            message: `${targetMember.full_name} (${targetMember.career_level}. Kariyer ${
              targetMember.career_title
            }) cüzdan hesabına ${amt.toLocaleString('tr-TR', {
              minimumFractionDigits: 2,
            })} $ bonus anında aktarıldı! Yeni Çekilebilir Bakiye: $${getMemberRegionalUsdBalance(targetMember).toFixed(2)}`,
            totalDistributed: amt,
            recipientsCount: 1,
            record,
          };
        }

        // Case 2: Career Tier (1..7) or ALL Career Tiers instant bonus transfer
        const tiersToProcess =
          career_level === 'ALL'
            ? careerTiers
            : careerTiers.filter((t) => t.level === Number(career_level));

        if (tiersToProcess.length === 0) {
          throw new Error('Geçerli bir kariyer mertebesi (1..7 veya ALL) seçiniz.');
        }

        let totalDistributed = 0;
        let totalRecipientsCount = 0;
        const poolBefore = systemCareerFundBalance;

        const tierAllocations = tiersToProcess.map((tier) => {
          const perMemberBonus =
            career_level !== 'ALL' && bonus_amount !== undefined && Number(bonus_amount) > 0
              ? roundCurrency(Number(bonus_amount))
              : roundCurrency(Number(tier.fixedCareerBonusAmount || 1000));

          // Save the updated admin-configured bonus amount on the tier
          tier.fixedCareerBonusAmount = perMemberBonus;

          const qualified = members.filter((m) => {
            if (!m.is_active || m.is_locked) return false;
            return match_mode === 'MIN_LEVEL'
              ? m.career_level >= tier.level
              : m.career_level === tier.level;
          });

          const recipients: Array<{ user_id: string; full_name: string; amount: number }> = [];
          let tierTotalPaid = 0;

          for (const m of qualified) {
            creditMemberWallet(m, 'CAREER_POOL', perMemberBonus);
            tierTotalPaid = roundCurrency(tierTotalPaid + perMemberBonus);
            totalDistributed = roundCurrency(totalDistributed + perMemberBonus);
            totalRecipientsCount++;

            recipients.push({
              user_id: m.user_id,
              full_name: m.full_name,
              amount: perMemberBonus,
            });

            commissionLogs.unshift({
              id: nextCommissionLogId++,
              order_id: distId,
              source_user_id: 1,
              source_external_id: 'CAREER_BONUS',
              source_user_name: `${tier.level}. Kariyer (${tier.title}) Yönetici Bonusu`,
              target_user_id: m.id,
              target_external_id: m.user_id,
              target_user_name: m.full_name,
              type: 'SYSTEM_POOL',
              commission_type: 'CAREER_POOL',
              depth_level: tier.level,
              amount: perMemberBonus,
              created_at: nowIso,
            });
          }

          return {
            career_level: tier.level,
            career_title: tier.title,
            bonus_rate_percent: Math.round(tier.poolBonusRate * 100),
            tier_pool_amount: tierTotalPaid,
            qualified_member_count: qualified.length,
            amount_per_member: perMemberBonus,
            recipients,
          };
        });

        if (totalRecipientsCount === 0) {
          throw new Error(
            'Seçilen kariyer mertebesinde aktif ve kilitsiz bayi bulunamadı. Lütfen önce bu mertebeye bayi atayın veya "En Az Bu Mertebe ve Üzeri" seçeneğini kullanın.'
          );
        }

        systemCareerFundBalance = Math.max(0, roundCurrency(poolBefore - totalDistributed));
        if (members[0]) {
          members[0].wallets.system_fund_balance = systemCareerFundBalance;
        }

        const record: PoolDistributionRecord = {
          distribution_id: distId,
          timestamp: nowIso,
          pool_balance_before: poolBefore,
          total_distributed: totalDistributed,
          pool_balance_after: systemCareerFundBalance,
          tier_Allocations: tierAllocations,
        };

        poolDistributions.unshift(record);

        return {
          message:
            career_level === 'ALL'
              ? `Tüm 7 Nefis Kariyer Bonusları dağıtıldı! Toplam ${totalRecipientsCount} bayinin cüzdan hesabına ${totalDistributed.toLocaleString(
                  'tr-TR',
                  { minimumFractionDigits: 2 }
                )} $ anında aktarıldı.`
              : `${tiersToProcess[0].level}. Kariyer (${
                  tiersToProcess[0].title
                }) bonusu olarak ${totalRecipientsCount} bayinin cüzdan hesabına kişi başı ${tierAllocations[0].amount_per_member.toLocaleString(
                  'tr-TR',
                  { minimumFractionDigits: 2 }
                )} $ (Toplam: ${totalDistributed.toLocaleString('tr-TR', {
                  minimumFractionDigits: 2,
                })} $) anında aktarıldı!`,
          totalDistributed,
          recipientsCount: totalRecipientsCount,
          record,
        };
      });

      res.json({
        status: 'success',
        message: result.message,
        distribution: result.record,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Kariyer bonusu aktarılırken hata oluştu.',
        state: buildStateResponse(),
      });
    }
  });

  // ============================================================================
  // SECTION 4B: 🎁 YÖNETİCİ BONUS KREDİ YÜKLEME (SEÇİLİ BAYİYE ÖZEL SEANS KREDİSİ)
  // ============================================================================
  app.post('/api/v1/admin/bonuses/credit-grant', requireAdminJwt, async (req, res) => {
    try {
      const { target_user_id, credit_amount, note } = req.body || {};
      const credits = Number(credit_amount) || 0;

      if (!target_user_id) {
        res.status(400).json({
          status: 'error',
          message: 'Lütfen bonus kredi yüklenecek bayiyi seçin.',
        });
        return;
      }

      if (credits <= 0) {
        res.status(400).json({
          status: 'error',
          message: 'Lütfen geçerli bir bonus kredi sayısı (> 0) girin.',
        });
        return;
      }

      const targetMember = members.find(
        (m) => m.user_id === target_user_id || String(m.id) === target_user_id
      );

      if (!targetMember) {
        res.status(404).json({
          status: 'error',
          message: 'Belirtilen bayi sistemde bulunamadı.',
        });
        return;
      }

      const oldCredits = targetMember.session_credits || 0;
      targetMember.session_credits = oldCredits + credits;
      creditsOwnedByServer.add(targetMember.user_id);
      const nowIso = new Date().toISOString();

      // Log to activity log
      activityLogs.unshift({
        id: nextActivityLogId++,
        user_id: targetMember.id,
        external_user_id: targetMember.user_id,
        user_full_name: targetMember.full_name,
        action_type: 'ADMIN_MANUAL_UPDATE',
        description: `🎁 Yönetici Bonusu: +${credits.toLocaleString('tr-TR')} Seans Kredisi yüklendi (${oldCredits} → ${targetMember.session_credits} Kredi). Açıklama: ${note || 'Yönetici Kariyer Bonusu'}`,
        previous_expires_at: targetMember.activity_expires_at || null,
        new_expires_at: targetMember.activity_expires_at || null,
        is_active_after: targetMember.is_active,
        created_at: nowIso,
      });

      // Send to notification outbox
      notificationOutbox.unshift({
        id: nextNotificationId++,
        user_id: targetMember.id,
        external_user_id: targetMember.user_id,
        user_full_name: targetMember.full_name,
        channel: 'IN_APP',
        title: '🎁 Tebrikler! Bonus Seans Kredisi Yüklendi',
        message: `Yönetici tarafından hesabınıza +${credits.toLocaleString('tr-TR')} Seans Kredisi başarıyla aktarıldı! Yeni Havuzunuz: ${targetMember.session_credits} Seans. ${note ? `(Not: ${note})` : ''}`,
        status: 'SENT',
        created_at: nowIso,
      });

      res.json({
        status: 'success',
        message: `🎉 Tebrikler! ${targetMember.full_name} (#${targetMember.global_line_id} · Kod: ${targetMember.ref_code}) paneline +${credits.toLocaleString('tr-TR')} Bonus Seans Kredisi başarıyla yüklendi! (Güncel Bakiye: ${targetMember.session_credits} Seans).`,
        target_member: targetMember,
        added_credits: credits,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        message: err?.message || 'Bonus kredi yükleme işlemi sırasında hata oluştu.',
      });
    }
  });

  // ============================================================================
  // SECTION 4C: 💬 BAYİ ŞİKAYETLER & ÖNERİLER (FEEDBACK & TICKETING SYSTEM)
  // ============================================================================

  // 1. GET /api/v1/feedback-tickets
  app.get('/api/v1/feedback-tickets', (req, res) => {
    const { user_id } = req.query;
    let list = feedbackTickets;
    if (user_id && typeof user_id === 'string' && user_id !== 'ALL') {
      list = feedbackTickets.filter((t) => t.user_id === user_id);
    }
    res.json({
      status: 'success',
      data: list,
      total: list.length,
      pending: list.filter((t) => t.status === 'PENDING').length,
    });
  });

  // 2. POST /api/v1/feedback-tickets (Bayi şikayet veya öneri gönderir)
  app.post('/api/v1/feedback-tickets', (req, res) => {
    try {
      const { user_id, type = 'SUGGESTION', subject, message, priority = 'NORMAL', category = 'OTHER' } = req.body || {};

      if (!subject || !message) {
        res.status(400).json({
          status: 'error',
          message: 'Lütfen konu başlığı ve mesaj metnini eksiksiz doldurun.',
        });
        return;
      }

      const member = members.find((m) => m.user_id === user_id || String(m.id) === user_id);
      const ticketId = `TKT-2026-${nextTicketNumber++}`;
      const nowIso = new Date().toISOString();

      const newTicket: DealerFeedbackTicket = {
        id: ticketId,
        user_id: user_id || 'GUEST',
        member_name: member ? member.full_name : (req.body.member_name || 'Bayi Temsilcisi'),
        member_email: member?.email || req.body.member_email || '',
        member_phone: member?.phone || req.body.member_phone || '',
        member_ref_code: member?.ref_code || '',
        member_career_level: member?.career_level || 1,
        member_career_title: `Kariyer Seviyesi ${member?.career_level || 1}`,
        type: type === 'COMPLAINT' ? 'COMPLAINT' : type === 'REQUEST' ? 'REQUEST' : type === 'INQUIRY' ? 'INQUIRY' : 'SUGGESTION',
        subject: String(subject).trim(),
        message: String(message).trim(),
        priority: priority === 'URGENT' ? 'URGENT' : priority === 'HIGH' ? 'HIGH' : priority === 'LOW' ? 'LOW' : 'NORMAL',
        category: String(category).trim(),
        status: 'PENDING',
        created_at: nowIso,
        updated_at: nowIso,
      };

      feedbackTickets.unshift(newTicket);

      // Notify outbox for admin
      notificationOutbox.unshift({
        id: nextNotificationId++,
        user_id: 1,
        external_user_id: 'ADMIN',
        user_full_name: newTicket.member_name,
        channel: 'IN_APP',
        title: `📩 Yeni Bayi Bildirimi: ${newTicket.type === 'COMPLAINT' ? 'Şikayet' : 'Öneri'} (#${newTicket.id})`,
        message: `${newTicket.member_name} (Kariyer Seviyesi ${newTicket.member_career_level}) tarafından yeni bir bildirim iletildi: "${newTicket.subject}"`,
        status: 'SENT',
        created_at: nowIso,
      });

      res.status(201).json({
        status: 'success',
        message: 'Bildiriminiz başarıyla sistem yöneticisine iletildi. En kısa sürede incelenerek geri bildirim sağlanacaktır.',
        ticket: newTicket,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        message: err?.message || 'Bildirim iletilirken sunucu hatası oluştu.',
      });
    }
  });

  // 3. PUT /api/v1/admin/feedback-tickets/:id (Yönetici durum günceller ve geri bildirim gönderir)
  app.put('/api/v1/admin/feedback-tickets/:id', requireAdminJwt, (req, res) => {
    try {
      const ticketId = req.params.id;
      const { status, admin_reply, admin_replied_by } = req.body || {};

      const ticket = feedbackTickets.find((t) => t.id === ticketId);
      if (!ticket) {
        res.status(404).json({
          status: 'error',
          message: 'Bildirim kaydı bulunamadı.',
        });
        return;
      }

      const nowIso = new Date().toISOString();

      if (status) {
        ticket.status = status;
      }
      if (admin_reply !== undefined) {
        ticket.admin_reply = admin_reply;
        ticket.admin_replied_at = nowIso;
        ticket.admin_replied_by = admin_replied_by || 'Abdulkadir kan (Yönetim Kurulu Başkanı)';
      }
      ticket.updated_at = nowIso;

      // Notify target dealer
      const targetMember = members.find((m) => m.user_id === ticket.user_id);
      if (targetMember && admin_reply) {
        notificationOutbox.unshift({
          id: nextNotificationId++,
          user_id: targetMember.id,
          external_user_id: targetMember.user_id,
          user_full_name: targetMember.full_name,
          channel: 'IN_APP',
          title: `🛡️ Yönetici Geri Bildirimi: #${ticket.id}`,
          message: `"${ticket.subject}" konulu başvurunuz yönetici tarafından yanıtlandı: "${admin_reply.slice(0, 120)}..."`,
          status: 'SENT',
          created_at: nowIso,
        });
      }

      res.json({
        status: 'success',
        message: `Bildirim (#${ticket.id}) başarıyla güncellendi ve bayiye geri bildirim iletildi.`,
        ticket,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        message: err?.message || 'Bildirim güncellenirken hata oluştu.',
      });
    }
  });

  // 4. DELETE /api/v1/admin/feedback-tickets/:id (Yönetici bildirimi siler)
  app.delete('/api/v1/admin/feedback-tickets/:id', requireAdminJwt, (req, res) => {
    try {
      const ticketId = req.params.id;
      const index = feedbackTickets.findIndex((t) => t.id === ticketId);

      if (index === -1) {
        res.status(404).json({
          status: 'error',
          message: 'Silinmek istenen bildirim bulunamadı.',
        });
        return;
      }

      const removed = feedbackTickets.splice(index, 1)[0];

      res.json({
        status: 'success',
        message: `"${removed.subject}" (#${removed.id}) konulu bildirim kalıcı olarak silindi.`,
        deleted_id: ticketId,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(500).json({
        status: 'error',
        message: err?.message || 'Bildirim silinirken hata oluştu.',
      });
    }
  });

  // V2.0 Dynamic Pool Split Engine (Puan Bazlı Dinamik Sistem Fonu Havuz Dağıtımı)
  app.post('/api/v1/career-pool/distribute', requireAdminJwt, (_req, res) => {
    if (systemCareerFundBalance <= 0) {
      res.status(400).json({
        status: 'error',
        message: 'Sistem / Kariyer Fonunda dağıtılacak bakiye bulunmamaktadır.',
      });
      return;
    }

    recalculateAllCareers('MANUAL_ADMIN');

    const poolBefore = systemCareerFundBalance;
    let totalDistributed = 0;
    const nowIso = new Date().toISOString();
    const distId = `POOL-${Date.now().toString().slice(-6)}`;

    const allActiveMembers = members.filter((m) => m.is_active && !m.is_locked);
    const totalSystemLeadershipPoints = allActiveMembers.reduce(
      (sum, m) => sum + (m.pool_leadership_points || 10),
      0
    );

    const tierAllocations = careerTiers.map((tier) => {
      const tierPoolAmount = roundCurrency(poolBefore * tier.poolBonusRate);
      const qualified = members.filter((m) => {
        const effCareer = v2ArchitectureConfig.use_dynamic_active_career
          ? m.active_career_level ?? m.career_level
          : m.career_level;
        return effCareer >= tier.level && m.is_active && !m.is_locked;
      });
      const count = qualified.length;
      const tierTotalPoints = qualified.reduce(
        (sum, m) => sum + (m.pool_leadership_points || 10),
        0
      );

      const recipients: Array<{
        user_id: string;
        full_name: string;
        amount: number;
        leadership_points?: number;
        point_share_percent?: number;
      }> = [];
      let avgPerMember = 0;

      if (count > 0 && tierPoolAmount > 0 && tierTotalPoints > 0) {
        let tierPaid = 0;
        for (const m of qualified) {
          const pts = m.pool_leadership_points || 10;
          const shareRatio = pts / tierTotalPoints;
          const memberDynamicShare = roundCurrency(tierPoolAmount * shareRatio);
          if (memberDynamicShare <= 0) continue;

          creditMemberWallet(m, 'CAREER_POOL', memberDynamicShare, false);
          tierPaid = roundCurrency(tierPaid + memberDynamicShare);
          totalDistributed = roundCurrency(totalDistributed + memberDynamicShare);

          recipients.push({
            user_id: m.user_id,
            full_name: m.full_name,
            amount: memberDynamicShare,
            leadership_points: pts,
            point_share_percent: Math.round(shareRatio * 1000) / 10,
          });

          commissionLogs.unshift({
            id: nextCommissionLogId++,
            order_id: distId,
            source_user_id: 1,
            source_external_id: 'SYSTEM_POOL',
            source_user_name: `Dinamik Havuz Dağıtımı (${pts} Puan · %${
              Math.round(shareRatio * 1000) / 10
            } Pay)`,
            target_user_id: m.id,
            target_external_id: m.user_id,
            target_user_name: m.full_name,
            type: 'SYSTEM_POOL',
            commission_type: 'CAREER_POOL',
            depth_level: tier.level,
            amount: memberDynamicShare,
            clawback_status: 'RELEASED_TO_BALANCE',
            released_at: nowIso,
            transfer_reason_code: 'PAID',
            created_at: nowIso,
          });
        }
        avgPerMember = roundCurrency(tierPaid / count);
      }

      return {
        career_level: tier.level,
        career_title: tier.title,
        bonus_rate_percent: Math.round(tier.poolBonusRate * 100),
        tier_pool_amount: tierPoolAmount,
        qualified_member_count: count,
        amount_per_member: avgPerMember,
        recipients,
      };
    });

    systemCareerFundBalance = Math.max(0, roundCurrency(poolBefore - totalDistributed));
    if (members[0]) {
      members[0].wallets.system_fund_balance = systemCareerFundBalance;
    }

    const record: PoolDistributionRecord = {
      distribution_id: distId,
      timestamp: nowIso,
      pool_balance_before: poolBefore,
      total_distributed: totalDistributed,
      pool_balance_after: systemCareerFundBalance,
      distribution_mode: 'DYNAMIC_POINTS_SPLIT',
      total_leadership_points: totalSystemLeadershipPoints,
      tier_Allocations: tierAllocations,
    };

    poolDistributions.unshift(record);

    res.json({
      status: 'success',
      message: `Dinamik Havuz Dağıtımı (Dynamic Pool Split Engine) tamamlandı: Toplam ${totalSystemLeadershipPoints} liderlik puanı üzerinden ${totalDistributed.toLocaleString(
        'tr-TR'
      )} $ hak kazanan liderlere puanları oranında dağıtıldı.`,
      distribution: record,
      state: buildStateResponse(),
    });
  });

  // ============================================================================
  // SECTION 4: POST /api/v1/admin/career/calculate-active
  // %50 Kol Denge Kuralı & Kariyer Terfi Engine (calculateActiveCareer) Canlı Test Endpoint'i
  // ============================================================================
  app.post('/api/v1/admin/career/calculate-active', requireAdminJwt, (req, res) => {
    try {
      const { user_id } = req.body || {};
      const upgrades = recalculateAllCareers('MANUAL_ADMIN');
      const targetMember =
        members.find((m) => m.user_id === user_id || String(m.id) === String(user_id)) ||
        members[0];

      const detail = targetMember ? calculateSingleUserActiveCareer(targetMember.id) : null;

      res.json({
        status: 'success',
        endpoint: 'POST /api/v1/admin/career/calculate-active',
        message: detail
          ? `calculateActiveCareer(${detail.db_id}) tamamlandı: ${detail.full_name} → totalGV: ${detail.totalGV.toLocaleString(
              'tr-TR'
            )} $ | maxCapPerLeg (%50): ${detail.maxCapPerLeg.toLocaleString(
              'tr-TR'
            )} $ | adjustedGV: ${detail.adjustedGV.toLocaleString('tr-TR')} $ | Aktif Kariyer: ${
              detail.active_career_level
            }. ${detail.active_career_title} (Max Unvan: ${detail.max_career_level}. ${
              detail.max_career_title
            })`
          : 'Tüm üyeler için %50 Kol Denge Kuralı & Kariyer Terfi Engine çalıştırıldı.',
        calculation_detail: detail,
        upgrades,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Kariyer hesaplama motoru çalıştırılırken hata oluştu.',
      });
    }
  });

  // ============================================================================
  // SECTION 5A: 14 GÜNLÜK CAYMA SÜRESİ DOLAN BAKİYELERİ SERBEST BIRAKMA (CRON JOB)
  // releasePendingCommissionsCron / releaseMaturedCommissions
  // SELECT * FROM commission_logs WHERE status = 'PENDING_14D' AND release_at <= CURRENT_TIMESTAMP FOR UPDATE
  // UPDATE wallets SET pending_balance = pending_balance - $1, balance = balance + $1 WHERE user_id = $2
  // UPDATE commission_logs SET status = 'RELEASED' WHERE id = $1
  // ============================================================================
  function releasePendingCommissionsCron(options?: { order_id?: string }) {
    const order_id = options?.order_id;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    let releasedLogsCount = 0;
    let releasedTotalAmount = 0;
    const affectedOrderIds = new Set<string>();

    for (const log of commissionLogs) {
      if (log.status !== 'PENDING_14D' && log.clawback_status !== 'PENDING_14D') continue;
      if (order_id && log.order_id !== order_id) continue;

      const releaseMs = log.release_at ? new Date(log.release_at).getTime() : NaN;
      if (!Number.isFinite(releaseMs) || releaseMs > nowMs) continue;

      const member = members.find(
        (m) => m.id === log.target_user_id || m.user_id === log.target_external_id
      );
      if (member) {
        const { region, usd } = resolveLogRegionalUsd(log, member);
        releaseRegionalPendingUsd(member, region, usd);
      }

      // UPDATE commission_logs SET status = 'RELEASED' WHERE id = $1
      log.status = 'RELEASED';
      log.clawback_status = 'RELEASED_TO_BALANCE';
      log.released_at = nowIso;
      releasedLogsCount++;
      releasedTotalAmount = roundCurrency(releasedTotalAmount + log.amount);
      affectedOrderIds.add(log.order_id);
    }

    for (const tx of transactions) {
      if (tx.clawback_status === 'PENDING_14D' && affectedOrderIds.has(tx.order_id)) {
        tx.clawback_status = 'RELEASED_TO_BALANCE';
      }
    }

    if (releasedLogsCount > 0) {
      cronLogs.unshift({
        id: `CRON-CLAWBACK-${Date.now().toString().slice(-5)}`,
        trigger_type: 'CLAWBACK_RELEASE_CRON',
        evaluated_users_count: members.length,
        upgrades_count: 0,
        released_commissions_count: releasedLogsCount,
        released_commissions_amount: releasedTotalAmount,
        upgrades: [],
        executed_at: nowIso,
      });

      queueJobs.unshift({
        job_id: `BULLMQ-REL-${Date.now().toString().slice(-5)}`,
        queue_name: 'bullmq:clawback-release',
        order_id: order_id || 'ALL_MATURED_14D',
        user_id: 'SYSTEM_CRON',
        order_amount: releasedTotalAmount,
        status: 'COMPLETED',
        worker_id: 'bullmq-worker-clawback-01',
        redis_lock_key: `redis:lock:clawback:${order_id || 'batch'}`,
        attempts_made: 1,
        enqueued_at: nowIso,
        completed_at: nowIso,
        processing_ms: 6,
        result_summary: `${releasedLogsCount} komisyon kaydı (${releasedTotalAmount.toLocaleString(
          'tr-TR'
        )} $) bölgesel bekleyen USD'den çekilebilir USD cüzdanına aktarıldı (status = 'RELEASED').`,
      });
    }

    return { releasedLogsCount, releasedTotalAmount };
  }

  function releaseMaturedCommissions(options?: { order_id?: string }) {
    return releasePendingCommissionsCron(options);
  }

  // V2.0: 14 Günlük Cayma & İade Koruması (Clawback Protection) — Bekleyen Komisyonları Çekilebilir Bakiyeye Aktarma Cron Job
  app.post('/api/v1/admin/cron/release-clawback', requireAdminJwt, async (req, res) => {
    try {
      const { order_id } = req.body || {};
      const result = await runInAtomicTransaction(() =>
        releasePendingCommissionsCron({ order_id })
      );

      res.json({
        status: 'success',
        endpoint: 'POST /api/v1/admin/cron/release-clawback',
        message:
          result.releasedTotalAmount > 0
            ? `releasePendingCommissionsCron tamamlandı: ${
                result.releasedLogsCount
              } komisyon işlemi (${result.releasedTotalAmount.toLocaleString(
                'tr-TR'
              )} $) bölgesel bekleyen USD'den çekilebilir USD cüzdanına aktarıldı (commission_logs.status = 'RELEASED').`
            : 'Serbest bırakılacak bekleyen komisyon bulunamadı.',
        released_count: result.releasedLogsCount,
        released_amount: result.releasedTotalAmount,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Clawback serbest bırakma işlemi başarısız.',
      });
    }
  });

  // ============================================================================
  // SECTION 5B: İADE / CAYMA DURUMUNDA KOMİSYON İPTALİ (Refund / Chargeback API)
  // async function handleOrderRefund(order_id)
  // ============================================================================
  async function handleOrderRefund(
    order_id: string,
    reason = '14 Günlük Yasal Cayma Hakkı / Sipariş İadesi'
  ) {
    const normalizedOrderId = String(order_id || '').trim();
    if (!normalizedOrderId) {
      throw new Error('İade edilecek sipariş numarası (order_id) zorunludur.');
    }

    const nowIso = new Date().toISOString();
    return runInAtomicTransaction(() => {
      const tx = transactions.find((t) => t.order_id === normalizedOrderId);
      if (!tx) {
        throw new Error(`Sipariş bulunamadı: ${normalizedOrderId}`);
      }
      if (tx.clawback_status === 'REFUNDED') {
        throw new Error(
          `Bu sipariş (${normalizedOrderId}) zaten iade edilmiş (REFUNDED_CANCELLED).`
        );
      }

      const buyer = members.find((m) => m.user_id === tx.buyer_user_id);
      if (buyer) {
        buyer.personal_volume = Math.max(
          0,
          roundCurrency(buyer.personal_volume - tx.order_amount)
        );
        buyer.personal_volume_30d = Math.max(
          0,
          roundCurrency((buyer.personal_volume_30d ?? buyer.personal_volume) - tx.order_amount)
        );
        buyer.session_credits = Math.max(0, buyer.session_credits - tx.session_credits_added);
      }

      // Üst sıradaki üyelerin grup cirosundan düş
      for (const m of members) {
        if (m.global_line_id < tx.buyer_global_line_id) {
          m.group_volume = Math.max(0, roundCurrency(m.group_volume - tx.order_amount));
        }
      }

      // SELECT * FROM commission_logs WHERE order_id = $1 FOR UPDATE
      let totalClawedBackFromMembers = 0;
      let negativeBalanceCount = 0;

      for (const log of commissionLogs) {
        if (log.order_id !== tx.order_id) continue;

        if (
          log.type === 'SPONSOR' ||
          log.type === 'MONOLINE_DEPTH' ||
          log.type === 'UNILEVEL_INFINITY' ||
          log.type === 'MATCHING_BONUS' ||
          log.type === 'FAST_ROI_BONUS'
        ) {
          const recipient = members.find(
            (m) => m.id === log.target_user_id || m.user_id === log.target_external_id
          );

          if (
            log.status === 'PENDING_14D' ||
            log.status === 'FRAUD_REVIEW' ||
            log.clawback_status === 'PENDING_14D'
          ) {
            // Bekleyen bakiyeden düş ve iptal et:
            // UPDATE wallets SET pending_balance = pending_balance - $1 WHERE user_id = $2
            // UPDATE commission_logs SET status = 'REFUNDED_CANCELLED' WHERE id = $1
            if (recipient) {
              const { region, usd } = resolveLogRegionalUsd(log, recipient);
              const pendingKey = getRegionPendingKey(region);
              recipient.wallets[pendingKey] = Math.max(
                0,
                roundCurrency((recipient.wallets[pendingKey] || 0) - usd)
              );
              adjustCommissionCounters(recipient, log.type, -log.amount);
              recipient.wallets.total_earnings = Math.max(
                0,
                roundCurrency(recipient.wallets.total_earnings - log.amount)
              );
              totalClawedBackFromMembers = roundCurrency(totalClawedBackFromMembers + log.amount);
            }
            log.status = 'REFUNDED_CANCELLED';
            log.clawback_status = 'CLAWBACK_REFUNDED';
            log.refunded_at = nowIso;
          } else if (
            log.status === 'RELEASED' ||
            log.clawback_status === 'RELEASED_TO_BALANCE'
          ) {
            // Zaten serbest kalmışsa çekilebilir bakiyeden düş (Eksi bakiyeye düşebilir):
            // UPDATE wallets SET balance = balance - $1 WHERE user_id = $2
            // UPDATE commission_logs SET status = 'REFUNDED_CANCELLED' WHERE id = $1
            if (recipient) {
              const { region, usd } = resolveLogRegionalUsd(log, recipient);
              const walletKey = getRegionWalletKey(region);
              recipient.wallets[walletKey] = roundCurrency((recipient.wallets[walletKey] || 0) - usd);
              if (recipient.wallets[walletKey] < 0) {
                negativeBalanceCount++;
              }
              adjustCommissionCounters(recipient, log.type, -log.amount);
              recipient.wallets.total_earnings = Math.max(
                0,
                roundCurrency(recipient.wallets.total_earnings - log.amount)
              );
              totalClawedBackFromMembers = roundCurrency(totalClawedBackFromMembers + log.amount);
            }
            log.status = 'REFUNDED_CANCELLED';
            log.clawback_status = 'CLAWBACK_REFUNDED';
            log.refunded_at = nowIso;
          } else {
            // POOL_TRANSFER_* kayıtlarını da REFUNDED_CANCELLED olarak işaretle
            log.status = 'REFUNDED_CANCELLED';
            log.clawback_status = 'CLAWBACK_REFUNDED';
            log.refunded_at = nowIso;
          }
        } else if (log.type === 'SYSTEM_POOL') {
          log.status = 'REFUNDED_CANCELLED';
          log.clawback_status = 'CLAWBACK_REFUNDED';
          log.refunded_at = nowIso;
        }
      }

      // Sistem fonuna eklenen tutarı ve system_wallet tablosunu geri çek
      systemCareerFundBalance = Math.max(
        0,
        roundCurrency(systemCareerFundBalance - tx.system_fund_total_added)
      );
      systemWallet.system_pool_balance = Math.max(
        0,
        roundCurrency(systemWallet.system_pool_balance - tx.system_fund_base_amount)
      );
      systemWallet.unclaimed_pool_balance = Math.max(
        0,
        roundCurrency(systemWallet.unclaimed_pool_balance - tx.system_fund_unclaimed_overflow)
      );
      systemWallet.updated_at = nowIso;

      // UPDATE orders_log SET status = 'REFUNDED' WHERE order_id = $1
      const orderLogEntry = ordersLog.find((o) => o.order_id === tx.order_id);
      if (orderLogEntry) {
        orderLogEntry.status = 'REFUNDED';
      }
      if (members[0]) {
        members[0].wallets.system_fund_balance = systemCareerFundBalance;
      }

      tx.clawback_status = 'REFUNDED';
      tx.refunded_at = nowIso;

      // Hareketli 30 günlük PGV (group_volume_30d) ve %50 Kol Denge Kuralı üzerinden aktif kariyeri yeniden hesapla
      if (buyer) {
        calculateActiveCareer(buyer.id);
      } else {
        recalculateAllCareers('POST_COMMISSION_EVENT');
      }

      const refundJobId = `BULLMQ-REFUND-${Date.now().toString().slice(-5)}`;
      queueJobs.unshift({
        job_id: refundJobId,
        queue_name: 'bullmq:order-refund',
        job_name: 'handleOrderRefund',
        order_id: tx.order_id,
        user_id: tx.buyer_user_id,
        order_amount: tx.order_amount,
        status: 'COMPLETED',
        worker_id: 'bullmq-worker-clawback-01',
        redis_lock_key: `redis:lock:refund:${tx.order_id}`,
        attempts_made: 1,
        max_attempts: 3,
        backoff_ms: 5000,
        enqueued_at: nowIso,
        completed_at: nowIso,
        processing_ms: 8,
        result_summary: `handleOrderRefund (${reason}): Üyelerden -${totalClawedBackFromMembers} $, Sistem Fonundan -${tx.system_fund_total_added} $ geri çekildi (orders_log = REFUNDED, commission_logs = REFUNDED_CANCELLED).`,
      });

      return { tx, totalClawedBackFromMembers, negativeBalanceCount };
    });
  }

  // V2.0: 14 Günlük Cayma & İade Koruması (Clawback Protection) — Sipariş İade (Refund) & Komisyon Geri Çekme Motoru
  app.post('/api/v1/integrations/order-refund', async (req, res) => {
    try {
      const { order_id, reason = '14 Günlük Yasal Cayma Hakkı / Sipariş İadesi' } = req.body || {};
      if (!order_id) {
        res.status(400).json({
          status: 'error',
          message: 'İade edilecek sipariş numarası (order_id) zorunludur.',
        });
        return;
      }

      const result = await handleOrderRefund(String(order_id), reason);

      res.json({
        status: 'success',
        endpoint: 'POST /api/v1/integrations/order-refund',
        message: `handleOrderRefund('${
          result.tx.order_id
        }') tamamlandı: Sipariş (orders_log.status = 'REFUNDED') ve komisyonlar (commission_logs.status = 'REFUNDED_CANCELLED') iptal edildi; dağıtılan ${result.totalClawedBackFromMembers.toLocaleString(
          'tr-TR'
        )} $ komisyon (PENDING_14D -> bölgesel bekleyen USD, RELEASED -> bölgesel USD cüzdanı) ve ${result.tx.system_fund_total_added.toLocaleString(
          'tr-TR'
        )} $ fon payı geri çekildi.`,
        transaction: result.tx,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Sipariş iade / clawback işlemi başarısız.',
      });
    }
  });

  // V2.0 & V2.2 Mimari Yapılandırma Güncelleme Endpoint'i
  app.put('/api/v1/admin/v2-config', requireAdminJwt, (req, res) => {
    const {
      use_rolling_30d_pgv,
      use_dynamic_active_career,
      async_queue_enabled,
      dynamic_compression_enabled,
      dynamic_compression_mode,
      unilevel_infinity_enabled,
      matching_bonus_enabled,
      fast_roi_3x15_enabled,
      fomo_48h_countdown_enabled,
      p2p_voucher_transfer_enabled,
      fast_start_window_days,
      welcome_30d_double_bonus_enabled,
      whatsapp_business_push_enabled,
    } = req.body || {};

    v2ArchitectureConfig = {
      use_rolling_30d_pgv:
        typeof use_rolling_30d_pgv === 'boolean'
          ? use_rolling_30d_pgv
          : v2ArchitectureConfig.use_rolling_30d_pgv,
      use_dynamic_active_career:
        typeof use_dynamic_active_career === 'boolean'
          ? use_dynamic_active_career
          : v2ArchitectureConfig.use_dynamic_active_career,
      async_queue_enabled:
        typeof async_queue_enabled === 'boolean'
          ? async_queue_enabled
          : v2ArchitectureConfig.async_queue_enabled,
      dynamic_compression_enabled:
        typeof dynamic_compression_enabled === 'boolean'
          ? dynamic_compression_enabled
          : v2ArchitectureConfig.dynamic_compression_enabled,
      dynamic_compression_mode:
        dynamic_compression_mode === 'FULL_COMPRESSION' ||
        dynamic_compression_mode === 'HYBRID_50_50' ||
        dynamic_compression_mode === 'FUND_SWEEP'
          ? dynamic_compression_mode
          : v2ArchitectureConfig.dynamic_compression_mode || 'FULL_COMPRESSION',
      unilevel_infinity_enabled:
        typeof unilevel_infinity_enabled === 'boolean'
          ? unilevel_infinity_enabled
          : v2ArchitectureConfig.unilevel_infinity_enabled,
      matching_bonus_enabled:
        typeof matching_bonus_enabled === 'boolean'
          ? matching_bonus_enabled
          : v2ArchitectureConfig.matching_bonus_enabled,
      fast_roi_3x15_enabled:
        typeof fast_roi_3x15_enabled === 'boolean'
          ? fast_roi_3x15_enabled
          : v2ArchitectureConfig.fast_roi_3x15_enabled,
      fomo_48h_countdown_enabled:
        typeof fomo_48h_countdown_enabled === 'boolean'
          ? fomo_48h_countdown_enabled
          : v2ArchitectureConfig.fomo_48h_countdown_enabled,
      p2p_voucher_transfer_enabled:
        typeof p2p_voucher_transfer_enabled === 'boolean'
          ? p2p_voucher_transfer_enabled
          : v2ArchitectureConfig.p2p_voucher_transfer_enabled,
      fast_start_window_days:
        fast_start_window_days !== undefined
          ? Math.max(7, Math.min(60, Number(fast_start_window_days) || 30))
          : v2ArchitectureConfig.fast_start_window_days || 30,
      welcome_30d_double_bonus_enabled:
        typeof welcome_30d_double_bonus_enabled === 'boolean'
          ? welcome_30d_double_bonus_enabled
          : v2ArchitectureConfig.welcome_30d_double_bonus_enabled,
      whatsapp_business_push_enabled:
        typeof whatsapp_business_push_enabled === 'boolean'
          ? whatsapp_business_push_enabled
          : v2ArchitectureConfig.whatsapp_business_push_enabled,
    };

    recalculateAllCareers('MANUAL_ADMIN');

    res.json({
      status: 'success',
      message: 'V2.0 Production-Ready Mimari Ayarları güncellendi ve tüm üye kariyer/ciro hesaplamaları senkronize edildi.',
      v2_architecture_config: v2ArchitectureConfig,
      state: buildStateResponse(),
    });
  });

  // V2.0 BullMQ / Redis Asenkron Kuyruk Eşzamanlı Sipariş Stres Testi
  app.post('/api/v1/admin/queue/burst-test', requireAdminJwt, async (req, res) => {
    try {
      if (members.length === 0) {
        res.status(400).json({
          status: 'error',
          message: 'Kuyruk testi için sistemde en az 1 kayıtlı bayi bulunmalıdır.',
        });
        return;
      }

      const burstCount = Math.max(2, Math.min(10, Number(req.body?.count) || 4));
      const samplePackages: Array<Exclude<PackageId, 'CUSTOM'>> = [
        'PKG_BRONZ_BASLANGIC',
        'PKG_GUMUS_STANDART',
        'PKG_ALTIN_DANISMAN',
        'PKG_ALTIN_PRO',
      ];

      const tasks: Array<Promise<CommissionTransaction>> = [];
      const baseBatchId = Date.now().toString().slice(-5);

      for (let i = 0; i < burstCount; i++) {
        const targetMember = members[(members.length - 1 - i + members.length * 10) % members.length];
        const pkgId = samplePackages[i % samplePackages.length];
        const pkgDef = PACKAGES[pkgId];
        const orderId = `ORD-BULLMQ-${baseBatchId}-${i + 1}`;

        tasks.push(
          runInAtomicTransaction(() =>
            processOrderCommission({
              user_id: targetMember.user_id,
              order_id: orderId,
              order_amount: pkgDef.defaultPrice,
              package_id: pkgId,
              timestamp: new Date().toISOString(),
            })
          )
        );
      }

      const processedTxs = await Promise.all(tasks);

      res.json({
        status: 'success',
        message: `BullMQ / Redis Asenkron Kuyruk Stres Testi Başarılı: ${processedTxs.length} eşzamanlı sipariş (Race Condition ve Deadlock olmadan) atomik kuyrukta sırayla işlendi.`,
        processed_orders: processedTxs.map((t) => t.order_id),
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'BullMQ kuyruk testi sırasında hata oluştu.',
      });
    }
  });

  app.post('/api/v1/settings/depth-lock', (req, res) => {
    const { enforce } = req.body;
    enforceCareerDepthLock = Boolean(enforce);
    res.json({
      status: 'success',
      enforce_career_depth_lock: enforceCareerDepthLock,
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/members/:userId/boost-career', (req, res) => {
    const { userId } = req.params;
    const { target_level } = req.body;
    const member = members.find((m) => m.user_id === userId);
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const tier = careerTiers.find((t) => t.level === Number(target_level));
    if (!tier) {
      res.status(400).json({ status: 'error', message: 'Geçersiz kariyer seviyesi.' });
      return;
    }

    member.manual_career_override = tier.level;
    recalculateAllCareers('MANUAL_ADMIN');

    res.json({
      status: 'success',
      message: `${member.full_name} üyesi kariyer mertebesi ${tier.level}. Kariyer (${tier.title}) olarak güncellendi.`,
      state: buildStateResponse(),
    });
  });

  // ============================================================================
  // V2.1 ENTERPRISE MODULES:
  // 1. Hukuki ve Mali Uyum (Stopaj %20, KVKK/EULA Onay Logu, TC Kimlik & Şirket Durumu)
  // 2. Anti-Fraud & Risk Engine (Self-Referral Lock, IP/Cihaz Çakışması >3/24s, Velocity Limits)
  // 3. Gamification & Retention (İlk 14 Gün Fast-Start Bonusu & Rank-Up Tek Seferlik Ödüller)
  // 4. Notification Outbox (WHATSAPP/SMS/EMAIL) & Banka Toplu Ödeme CSV (Garanti/İş/QNB/Papara)
  // ============================================================================

  // V2.1: Bayi Vergi Mükellefiyeti (Şahıs %20 Stopaj vs Şirket %0 Stopaj) & KVKK Sözleşme Güncelleme
  app.post('/api/v1/admin/compliance/member/:userId', requireAdminJwt, (req, res) => {
    const member = members.find(
      (m) => m.user_id === req.params.userId || String(m.id) === String(req.params.userId)
    );
    if (!member) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const { tc_identity_no, has_tax_company, contract_version, last_login_ip } = req.body || {};
    if (tc_identity_no !== undefined) {
      member.tc_identity_no = String(tc_identity_no).trim().slice(0, 11);
    }
    if (typeof has_tax_company === 'boolean') {
      member.has_tax_company = has_tax_company;
    }
    if (contract_version) {
      member.contract_version = String(contract_version).trim();
    }
    if (last_login_ip) {
      member.last_login_ip = String(last_login_ip).trim();
    }
    member.kvkk_approved_at = new Date().toISOString();

    res.json({
      status: 'success',
      message: `${member.full_name} Hukuki & Mali Uyum bilgileri güncellendi (${
        member.has_tax_company ? 'Vergi Mükellefi Şirket — %0 Stopaj' : 'Şahıs Bayi — %20 Stopaj'
      } · Sözleşme: ${member.contract_version}).`,
      state: buildStateResponse(),
    });
  });

  // V2.1: Anti-Fraud IP / Cihaz Çakışması Simülasyonu (Aynı IP'den 24 saatte 4. işlem -> FRAUD_REVIEW)
  app.post('/api/v1/admin/fraud/simulate-ip-collision', requireAdminJwt, async (req, res) => {
    try {
      const targetMember =
        members.find((m) => m.user_id === req.body?.user_id) ||
        members[members.length - 1] ||
        members[0];
      if (!targetMember) {
        res.status(400).json({
          status: 'error',
          message: 'Test için sistemde en az 1 kayıtlı bayi bulunmalıdır.',
        });
        return;
      }

      const sharedIp = req.body?.client_ip || '185.122.44.99';
      const nowMs = Date.now();
      // Seed 3 prior events on the same IP within 24 hours so this 4th order triggers FRAUD_REVIEW
      ipActivityEvents.push(
        { ip: sharedIp, user_id: targetMember.user_id, timestamp_ms: nowMs - 120000 },
        { ip: sharedIp, user_id: targetMember.user_id, timestamp_ms: nowMs - 60000 },
        { ip: sharedIp, user_id: targetMember.user_id, timestamp_ms: nowMs - 30000 }
      );

      const orderId = `ORD-FRAUD-IP-${Date.now().toString().slice(-5)}`;
      const tx = await runInAtomicTransaction(() =>
        processOrderCommission({
          user_id: targetMember.user_id,
          order_id: orderId,
          order_amount: 10000,
          package_id: 'PKG_BRONZ_BASLANGIC',
          client_ip: sharedIp,
          device_fingerprint: 'DEV-COLLISION-99',
          timestamp: new Date().toISOString(),
        })
      );

      res.json({
        status: 'success',
        message: `Anti-Fraud Motoru Tetiklendi: Aynı IP adresinden (${sharedIp}) 24 saat içinde 4. işlem tespit edildiği için sipariş (${orderId}) ve komisyonları otomatik olarak 'FRAUD_REVIEW' statüsüne alındı.`,
        transaction: tx,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Anti-Fraud testi başarısız.',
      });
    }
  });

  // V2.1: Admin FRAUD_REVIEW İnceleme Onay / İptal Kararı
  app.post('/api/v1/admin/fraud/:id/decision', requireAdminJwt, async (req, res) => {
    try {
      const alertId = Number(req.params.id);
      const { decision } = req.body || {}; // 'APPROVE' | 'REJECT_REFUND'
      const alertRec = fraudAlerts.find((a) => a.id === alertId);
      if (!alertRec) {
        res.status(404).json({ status: 'error', message: 'Risk/Fraud kaydı bulunamadı.' });
        return;
      }

      if (decision === 'APPROVE') {
        alertRec.status = 'CLEARED_APPROVED';
        if (alertRec.order_id) {
          const ord = ordersLog.find((o) => o.order_id === alertRec.order_id);
          if (ord) ord.status = 'COMPLETED';
          for (const log of commissionLogs) {
            if (log.order_id === alertRec.order_id && log.status === 'FRAUD_REVIEW') {
              log.status = 'PENDING_14D';
              log.clawback_status = 'PENDING_14D';
            }
          }
          const tx = transactions.find((t) => t.order_id === alertRec.order_id);
          if (tx) tx.clawback_status = 'PENDING_14D';
        }
        res.json({
          status: 'success',
          message: `Fraud İncelemesi #${alertRec.id} onaylandı; komisyonlar FRAUD_REVIEW statüsünden PENDING_14D statüsüne geçirildi.`,
          state: buildStateResponse(),
        });
      } else {
        alertRec.status = 'REJECTED_BLOCKED';
        if (alertRec.order_id) {
          await handleOrderRefund(alertRec.order_id, 'Anti-Fraud Reddi & Sahte İşlem İptali');
        }
        res.json({
          status: 'success',
          message: `Fraud İncelemesi #${alertRec.id} reddedildi ve sipariş komisyonları handleOrderRefund ile geri çekildi.`,
          state: buildStateResponse(),
        });
      }
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Fraud kararı uygulanamadı.',
      });
    }
  });

  // V2.1: Gamification — Hızlı Başlangıç Bonusu (FAST_START) & Kariyer Ödülü Teslimat Yönetimi
  app.post('/api/v1/admin/rewards/trigger-fast-start', requireAdminJwt, (req, res) => {
    const targetMember = members.find((m) => m.user_id === req.body?.user_id);
    if (!targetMember) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }
    if (targetMember.fast_start_awarded) {
      res.status(409).json({
        status: 'error',
        code: 'FAST_START_ALREADY_AWARDED',
        message: 'Bu üyeye Hızlı Başlangıç bonusu daha önce tanımlanmış.',
      });
      return;
    }
    const windowDays = v2ArchitectureConfig.fast_start_window_days || 30;
    const joinedMs = targetMember.joined_at ? new Date(targetMember.joined_at).getTime() : NaN;
    const daysSinceJoin = (Date.now() - joinedMs) / 86400000;
    if (!Number.isFinite(daysSinceJoin) || daysSinceJoin > windowDays) {
      res.status(422).json({
        status: 'error',
        code: 'FAST_START_WINDOW_EXPIRED',
        message: `Bu bonus üyelik tarihinden itibaren ${windowDays} gün içinde tanımlanabilir.`,
      });
      return;
    }

    const fastStartCash = Number(req.body?.cash_value) || 2500;
    targetMember.fast_start_awarded = true;
    targetMember.wallets.sponsor_wallet = roundCurrency(
      (targetMember.wallets.sponsor_wallet || 0) + fastStartCash
    );
    targetMember.wallets.total_earnings = roundCurrency(
      (targetMember.wallets.total_earnings || 0) + fastStartCash
    );
    const fastStartRegion = resolveMemberRegion(targetMember.country_code);
    const fastStartPendingKey = getRegionPendingKey(fastStartRegion);
    targetMember.wallets[fastStartPendingKey] = roundCurrency(
      (targetMember.wallets[fastStartPendingKey] || 0) +
        toUsdForRegion(fastStartCash, fastStartRegion)
    );

    const newReward: UserRewardLogRecord = {
      id: nextRewardLogId++,
      user_id: targetMember.id,
      external_user_id: targetMember.user_id,
      user_full_name: targetMember.full_name,
      career_level: targetMember.career_level,
      career_title: targetMember.career_title,
      reward_type: 'FAST_START',
      reward_description:
        `İlk ${v2ArchitectureConfig.fast_start_window_days || 30} Gün 3 Aktif Direkt Referans Hızlı Başlangıç Bonusu (+%5 Ekstra Sponsorluk & Nakit Ödül)`,
      cash_value: fastStartCash,
      is_delivered: true,
      earned_at: new Date().toISOString(),
    };
    userRewardsLog.unshift(newReward);

    enqueueNotification({
      member: targetMember,
      channel: 'WHATSAPP',
      trigger_type: 'FAST_START_BONUS',
      message: `Tebrikler ${targetMember.full_name}! İlk ${v2ArchitectureConfig.fast_start_window_days || 30} gün içinde 3 aktif direkt referans getirerek ${fastStartCash.toLocaleString('tr-TR')} $ Hızlı Başlangıç Bonusu (FAST_START) kazandınız!`,
    });

    res.json({
      status: 'success',
      message: `${targetMember.full_name} için İlk ${v2ArchitectureConfig.fast_start_window_days || 30} Gün Hızlı Başlangıç Bonusu (${fastStartCash.toLocaleString('tr-TR')} $) user_rewards_log tablosuna işlendi ve bildirim gönderildi.`,
      reward: newReward,
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/admin/rewards/:id/deliver', requireAdminJwt, (req, res) => {
    const rewardId = Number(req.params.id);
    const reward = userRewardsLog.find((r) => r.id === rewardId);
    if (!reward) {
      res.status(404).json({ status: 'error', message: 'Ödül kaydı bulunamadı.' });
      return;
    }
    reward.is_delivered = true;
    const member = members.find((m) => m.id === reward.user_id);
    if (member && reward.cash_value > 0) {
      member.wallets.career_pool_wallet = roundCurrency(
        (member.wallets.career_pool_wallet || 0) + reward.cash_value
      );
      creditMemberRegionalUsd(
        member,
        toUsdForRegion(reward.cash_value, resolveMemberRegion(member.country_code))
      );
      member.wallets.total_earnings = roundCurrency(
        (member.wallets.total_earnings || 0) + reward.cash_value
      );
    }
    res.json({
      status: 'success',
      message: `${reward.user_full_name} — "${reward.reward_description}" (${reward.cash_value.toLocaleString('tr-TR')} $) ödülü teslim edildi (is_delivered = TRUE) ve cüzdana aktarıldı.`,
      state: buildStateResponse(),
    });
  });

  // V2.1: Gerçek Zamanlı Bildirim Motoru (Notification Outbox) — 3 Gün Aktiflik Uyarısı & FOMO Testi
  app.post('/api/v1/admin/notifications/trigger-expiry-warnings', requireAdminJwt, (req, res) => {
    const targetMember =
      members.find((m) => m.user_id === req.body?.user_id) || members[0];
    if (!targetMember) {
      res.status(400).json({
        status: 'error',
        message: 'Bildirim testi için sistemde en az 1 kayıtlı bayi bulunmalıdır.',
      });
      return;
    }

    const pendingAmt = Math.max(4500, getMemberRegionalPendingUsd(targetMember) || 4500);
    const expiryWarning = enqueueNotification({
      member: targetMember,
      channel: 'WHATSAPP',
      trigger_type: 'ACTIVITY_EXPIRY_3D_WARNING',
      message: `Dikkat! Aktiflik sürenizin dolmasına 3 gün kaldı. Bekleyen ${pendingAmt.toLocaleString(
        'tr-TR'
      )} USD komisyonunuzu kaybetmemek için aktifliğinizi yenileyin.`,
    });

    const fomoWarning = enqueueNotification({
      member: targetMember,
      channel: 'SMS',
      trigger_type: 'FOMO_LOST_COMMISSION',
      message: `Uyarı! 5. Derinlikten gelen 1.200 $ komisyon, kariyer yetkiniz (Râziye) olmadığı için Sistem Havuzuna devredildi. Hemen terfi edin!`,
    });

    res.json({
      status: 'success',
      message: `${targetMember.full_name} için 3 Gün Aktiflik Uyarısı ve FOMO Kayıp Komisyon Bildirimi notification_outbox tablosuna eklendi.`,
      notifications: [expiryWarning, fomoWarning],
      state: buildStateResponse(),
    });
  });

  // ============================================================================
  // 5 STRATEJİK İYİLEŞTİRME ÖNERİSİ — CANLI API ENDPOINT'LERİ
  // 1️⃣ 48 Saatlik Geri Sayım Sayacı & FOMO Kurtarma (fomo/trigger-48h-alert & fomo/rescue-commission)
  // 2️⃣ Hibrit Dinamik Sıkıştırma Modu (FULL_COMPRESSION / HYBRID_50_50 / FUND_SWEEP)
  // 3️⃣ P2P İç Bakiye Transferi & Aktivasyon Kupon Kodu (p2p/transfer, p2p/create-voucher, p2p/redeem-voucher)
  // 4️⃣ İlk 30 Gün Hoş Geldin Duble Bonusu (admin/rewards/trigger-welcome-double-bonus)
  // 5️⃣ Anlık WhatsApp Business API & Story Bildirim Tetikleyici (notifications/send-whatsapp-story)
  // ============================================================================

  // 1️⃣ A: Yeni 48 Saatlik FOMO Geri Sayım Uyarısı Tetikle
  app.post('/api/v1/fomo/trigger-48h-alert', (req, res) => {
    const targetMember =
      members.find(
        (m) => m.user_id === req.body?.user_id || String(m.id) === String(req.body?.user_id)
      ) || members[7] || members[0];
    if (!targetMember) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const atRiskAmount = Number(req.body?.at_risk_amount) || 2400;
    const depthLevel = Number(req.body?.depth_level) || 2;
    const warningMsg = `⚠️ DİKKAT: Üst/Alt hattınızda ${atRiskAmount.toLocaleString(
      'tr-TR'
    )} $ komisyon oluştu! Aktiflik sürenizin bitmesine 48 saat kaldı. Aktifliğinizi yenilemezseniz bu tutar Sistem Havuzuna devredilecektir.`;

    const newAlert: FomoCountdownAlertRecord = {
      id: nextFomoAlertId++,
      user_id: targetMember.id,
      external_user_id: targetMember.user_id,
      user_full_name: targetMember.full_name,
      source_order_id: `ORD-FOMO-${Date.now().toString().slice(-4)}`,
      source_buyer_name: 'Alt Hat Yeni Sipariş',
      source_order_amount: 30000,
      at_risk_commission_amount: atRiskAmount,
      depth_level: depthLevel,
      reason: 'INACTIVE_EXPIRED',
      warning_message: warningMsg,
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      remaining_seconds: 48 * 3600,
      status: 'COUNTDOWN_ACTIVE_48H',
      created_at: new Date().toISOString(),
    };
    fomoCountdownAlerts.unshift(newAlert);

    enqueueNotification({
      member: targetMember,
      channel: 'WHATSAPP',
      trigger_type: 'FOMO_48H_COUNTDOWN_ALERT',
      commission_amount: atRiskAmount,
      message: warningMsg,
    });

    res.json({
      status: 'success',
      message: `${targetMember.full_name} paneline 48 saatlik canlı kırmızı FOMO Geri Sayım Sayacı (${atRiskAmount.toLocaleString('tr-TR')} $) yerleştirildi ve WhatsApp uyarısı gönderildi.`,
      alert: newAlert,
      state: buildStateResponse(),
    });
  });

  // 1️⃣ B: 48 Saatlik Geri Sayım Bitmeden Aktifliği Yenile ve Komisyonu Kurtar!
  app.post('/api/v1/fomo/rescue-commission', (req, res) => {
    const { alert_id, user_id } = req.body || {};
    const alertRec =
      fomoCountdownAlerts.find(
        (a) =>
          (alert_id && a.id === Number(alert_id)) ||
          (user_id && a.external_user_id === user_id && a.status === 'COUNTDOWN_ACTIVE_48H')
      ) || fomoCountdownAlerts.find((a) => a.status === 'COUNTDOWN_ACTIVE_48H');

    if (!alertRec) {
      res.status(404).json({
        status: 'error',
        message: 'Kurtarılacak aktif 48 saatlik FOMO komisyon uyarısı bulunamadı.',
      });
      return;
    }

    const member = members.find(
      (m) => m.id === alertRec.user_id || m.user_id === alertRec.external_user_id
    );
    if (!member) {
      res.status(404).json({ status: 'error', message: 'İlgili bayi bulunamadı.' });
      return;
    }

    // Bayinin aylık aktifliğini +30 gün yenile ve riskteki komisyonu cüzdanına kurtar!
    member.is_active = true;
    member.activity_expires_at = createFutureExpiryIso();
    creditMemberWallet(member, 'MONOLINE_DEPTH', alertRec.at_risk_commission_amount, true);
    alertRec.status = 'RESCUED_BY_RENEWAL';
    alertRec.remaining_seconds = 0;

    enqueueNotification({
      member,
      channel: 'WHATSAPP',
      trigger_type: 'DEPTH_COMMISSION_EARNED',
      commission_amount: alertRec.at_risk_commission_amount,
      message: `Tebrikler Sayın ${member.full_name}! 48 saatlik FOMO geri sayımı dolmadan aktifliğinizi yenilediniz ve ${alertRec.at_risk_commission_amount.toLocaleString('tr-TR')} $ tutarındaki komisyonunuz Sistem Havuzuna devredilmekten kurtarılarak cüzdanınıza aktarıldı!`,
    });

    res.json({
      status: 'success',
      message: `🎉 Harika! ${member.full_name} 48 saatlik süre dolmadan aktifliğini yeniledi ve ${alertRec.at_risk_commission_amount.toLocaleString('tr-TR')} $ komisyonu Sistem Havuzuna gitmekten kurtararak cüzdanına aldı!`,
      rescued_alert: alertRec,
      state: buildStateResponse(),
    });
  });

  // 3️⃣ A: P2P İç Bakiye Transferi & Doğrudan Paket Aktivasyonu (p2p_transfer)
  app.post('/api/v1/p2p/transfer', async (req, res) => {
    try {
      if (v2ArchitectureConfig.p2p_voucher_transfer_enabled === false) {
        res.status(403).json({
          status: 'error',
          message: 'P2P İç Bakiye Transferi şu anda Admin tarafından devre dışı bırakılmış.',
        });
        return;
      }

      const {
        from_user_id,
        to_user_id,
        amount,
        transfer_type = 'WALLET_TO_WALLET',
        package_id = 'PKG_MINI_DENEME',
        note = 'P2P İç Bakiye Transferi',
      } = req.body || {};

      const sender = members.find(
        (m) => m.user_id === from_user_id || String(m.id) === String(from_user_id)
      );
      const receiver = members.find(
        (m) => m.user_id === to_user_id || String(m.id) === String(to_user_id)
      );

      if (!sender || !receiver) {
        res.status(404).json({ status: 'error', message: 'Gönderen veya alıcı bayi bulunamadı.' });
        return;
      }
      if (sender.user_id === receiver.user_id) {
        res.status(400).json({
          status: 'error',
          message: 'Kendi hesabınıza P2P bakiye transferi yapamazsınız.',
        });
        return;
      }

      const normalizedPkg = normalizePackageId(package_id) || 'PKG_MINI_DENEME';
      const pkgDef = PACKAGES[normalizedPkg];
      const txAmount =
        transfer_type === 'DIRECT_PACKAGE_ACTIVATION'
          ? getPackagePriceForRegion(pkgDef.defaultPrice, resolveMemberRegion(sender.country_code))
          : Math.max(100, Number(amount) || 5000);

      const senderUsd = getMemberRegionalUsdBalance(sender);
      if (senderUsd < txAmount) {
        res.status(400).json({
          status: 'error',
          message: `Yetersiz çekilebilir bakiye: ${sender.full_name} hesabında $${senderUsd.toFixed(2)} mevcut (Gereken: $${txAmount.toFixed(2)}).`,
        });
        return;
      }

      debitMemberRegionalUsd(sender, txAmount);
      const receiverPrevExp = receiver.activity_expires_at || null;

      if (transfer_type === 'DIRECT_PACKAGE_ACTIVATION') {
        const p2pOrderId = `ORD-P2P-${Date.now().toString().slice(-5)}`;
        await runInAtomicTransaction(() =>
          processOrderCommission({
            user_id: receiver.user_id,
            order_id: p2pOrderId,
            order_amount: txAmount,
            package_id: normalizedPkg,
            order_type: 'ACTIVITY_RENEWAL',
            timestamp: new Date().toISOString(),
          })
        );
      } else {
        creditMemberRegionalUsd(receiver, txAmount);
      }

      const txRec: P2PTransferRecord = {
        id: nextP2PTransferId++,
        tx_code: `P2P-TX-${9000 + nextP2PTransferId}`,
        from_user_id: sender.id,
        from_external_id: sender.user_id,
        from_user_name: sender.full_name,
        to_user_id: receiver.id,
        to_external_id: receiver.user_id,
        to_user_name: receiver.full_name,
        amount: txAmount,
        transfer_type:
          transfer_type === 'DIRECT_PACKAGE_ACTIVATION'
            ? 'DIRECT_PACKAGE_ACTIVATION'
            : 'WALLET_TO_WALLET',
        package_id: transfer_type === 'DIRECT_PACKAGE_ACTIVATION' ? normalizedPkg : null,
        voucher_code: null,
        note: String(note),
        status: 'COMPLETED',
        created_at: new Date().toISOString(),
      };
      p2pTransfers.unshift(txRec);

      logActivityEvent({
        member: sender,
        action_type: 'P2P_TRANSFER_SENT',
        previous_expires_at: sender.activity_expires_at || null,
        new_expires_at: sender.activity_expires_at || null,
        description: `${sender.full_name}, ${receiver.full_name} hesabına $${txAmount.toFixed(2)} P2P transfer etti.`,
      });
      logActivityEvent({
        member: receiver,
        action_type: 'P2P_TRANSFER_RECEIVED',
        previous_expires_at: receiverPrevExp,
        new_expires_at: receiver.activity_expires_at || null,
        description: `${receiver.full_name}, ${sender.full_name} tarafından $${txAmount.toFixed(2)} P2P transfer aldı.`,
      });

      enqueueNotification({
        member: receiver,
        channel: 'WHATSAPP',
        trigger_type: 'P2P_VOUCHER_RECEIVED',
        commission_amount: txAmount,
        message:
          transfer_type === 'DIRECT_PACKAGE_ACTIVATION'
            ? `Tebrikler Sayın ${receiver.full_name}! Üst lideriniz ${sender.full_name} P2P İç Bakiye Transferi ile hesabınıza ${pkgDef.name} (${txAmount.toLocaleString('tr-TR')} $ · +${pkgDef.sessionCredits} Seans Kredisi) tanımladı ve aktifliğinizi açtı!`
            : `Bilgilendirme: Sayın ${receiver.full_name}, ${sender.full_name} tarafından P2P Cüzdandan Cüzdana Transfer ile hesabınıza +${txAmount.toLocaleString('tr-TR')} $ çekilebilir nakit bakiye aktarıldı.`,
      });

      res.json({
        status: 'success',
        message:
          transfer_type === 'DIRECT_PACKAGE_ACTIVATION'
            ? `${sender.full_name} cüzdan bakiyesinden ${receiver.full_name} adına ${pkgDef.name} (${txAmount.toLocaleString('tr-TR')} $) anında tanımlandı ve komisyon motoru çalıştırıldı!`
            : `${sender.full_name} → ${receiver.full_name} hesabına ${txAmount.toLocaleString('tr-TR')} $ P2P İç Bakiye Transferi tamamlandı.`,
        transfer: txRec,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'P2P bakiye transferi sırasında hata oluştu.',
      });
    }
  });

  // 3️⃣ B: Cüzdan Bakiyesi ile Aktivasyon Kupon Kodu (Voucher) Üretme
  app.post('/api/v1/p2p/create-voucher', (req, res) => {
    const { creator_user_id, package_id = 'PKG_BRONZ_BASLANGIC' } = req.body || {};
    const creator =
      members.find(
        (m) => m.user_id === creator_user_id || String(m.id) === String(creator_user_id)
      ) || members[0];
    if (!creator) {
      res.status(404).json({ status: 'error', message: 'Kupon üretecek bayi bulunamadı.' });
      return;
    }

    const normalizedPkg = normalizePackageId(package_id) || 'PKG_BRONZ_BASLANGIC';
    const pkgDef = PACKAGES[normalizedPkg];
    const cost = getPackagePriceForRegion(pkgDef.defaultPrice, resolveMemberRegion(creator.country_code));
    const creatorUsd = getMemberRegionalUsdBalance(creator);

    if (creatorUsd < cost) {
      res.status(400).json({
        status: 'error',
        message: `Kupon üretmek için çekilebilir bakiyeniz yetersiz ($${creatorUsd.toFixed(2)} < $${cost.toFixed(2)}).`,
      });
      return;
    }

    debitMemberRegionalUsd(creator, cost);
    const shortK = Math.round(cost / 1000);
    const randDigits = Math.floor(1000 + Math.random() * 9000);
    const voucherCode = `AKN-VCH-${shortK}K-${randDigits}`;

    const newVoucher: ActivationVoucherRecord = {
      id: nextVoucherId++,
      voucher_code: voucherCode,
      creator_user_id: creator.id,
      creator_external_id: creator.user_id,
      creator_user_name: creator.full_name,
      package_id: normalizedPkg,
      package_name: `${pkgDef.name} (${cost.toLocaleString('tr-TR')} $)`,
      amount: cost,
      session_credits: pkgDef.sessionCredits,
      status: 'ACTIVE_UNUSED',
      created_at: new Date().toISOString(),
    };
    activationVouchers.unshift(newVoucher);

    p2pTransfers.unshift({
      id: nextP2PTransferId++,
      tx_code: `P2P-MINT-${9000 + nextP2PTransferId}`,
      from_user_id: creator.id,
      from_external_id: creator.user_id,
      from_user_name: creator.full_name,
      to_user_id: creator.id,
      to_external_id: creator.user_id,
      to_user_name: 'Kupon Havuzu (Tek Kullanımlık Kod)',
      amount: cost,
      transfer_type: 'VOUCHER_MINT',
      package_id: normalizedPkg,
      voucher_code: voucherCode,
      note: `${pkgDef.name} için ${voucherCode} aktivasyon kuponu üretildi.`,
      status: 'COMPLETED',
      created_at: new Date().toISOString(),
    });

    res.json({
      status: 'success',
      message: `🎟️ "${voucherCode}" Aktivasyon Kupon Kodu (${pkgDef.name} · ${cost.toLocaleString('tr-TR')} $ · +${pkgDef.sessionCredits} Kredi) başarıyla üretildi! Alt ekibinizdeki herhangi bir üyeye bu kodu vererek kartsız/havalesiz anında paket tanımlayabilirsiniz.`,
      voucher: newVoucher,
      state: buildStateResponse(),
    });
  });

  // 3️⃣ C: Aktivasyon Kupon Kodunu (Voucher) Kullanarak Paket ve Aktiflik Tanımlama
  app.post('/api/v1/p2p/redeem-voucher', async (req, res) => {
    try {
      const { voucher_code, redeemer_user_id } = req.body || {};
      const cleanCode = String(voucher_code || '').trim().toUpperCase();
      const voucher = activationVouchers.find(
        (v) => v.voucher_code.toUpperCase() === cleanCode
      );

      if (!voucher) {
        res.status(404).json({
          status: 'error',
          message: `"${cleanCode}" kodlu bir Aktivasyon Kuponu bulunamadı.`,
        });
        return;
      }
      if (voucher.status === 'REDEEMED') {
        res.status(400).json({
          status: 'error',
          message: `Bu Aktivasyon Kuponu (${voucher.voucher_code}) daha önce ${voucher.redeemed_by_user_name} tarafından kullanılmış.`,
        });
        return;
      }

      const redeemer =
        members.find(
          (m) => m.user_id === redeemer_user_id || String(m.id) === String(redeemer_user_id)
        ) || members[members.length - 1];
      if (!redeemer) {
        res.status(404).json({ status: 'error', message: 'Kuponu kullanacak üye bulunamadı.' });
        return;
      }

      voucher.status = 'REDEEMED';
      voucher.redeemed_by_user_id = redeemer.id;
      voucher.redeemed_by_external_id = redeemer.user_id;
      voucher.redeemed_by_user_name = redeemer.full_name;
      voucher.redeemed_at = new Date().toISOString();

      const voucherOrderId = `ORD-VCH-${voucher.voucher_code}`;
      const tx = await runInAtomicTransaction(() =>
        processOrderCommission({
          user_id: redeemer.user_id,
          order_id: voucherOrderId,
          order_amount: voucher.amount,
          package_id: voucher.package_id,
          order_type: 'ACTIVITY_RENEWAL',
          timestamp: new Date().toISOString(),
        })
      );

      enqueueNotification({
        member: redeemer,
        channel: 'WHATSAPP',
        trigger_type: 'P2P_VOUCHER_RECEIVED',
        order_amount: voucher.amount,
        message: `Tebrikler Sayın ${redeemer.full_name}! "${voucher.voucher_code}" Aktivasyon Kupon Kodu ile ${voucher.package_name} (+${voucher.session_credits} Seans Kredisi) hesabınıza tanımlandı ve 30 günlük aktifliğiniz başlatıldı!`,
      });

      res.json({
        status: 'success',
        message: `✅ "${voucher.voucher_code}" Aktivasyon Kuponu ${redeemer.full_name} için kullanıldı! +${voucher.session_credits} Seans Kredisi yüklendi, +30 gün aktiflik açıldı ve ${voucher.amount.toLocaleString('tr-TR')} $ sipariş komisyonu üst hatta dağıtıldı.`,
        voucher,
        transaction: tx,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Kupon aktivasyonu sırasında hata oluştu.',
      });
    }
  });

  // 4️⃣ "İlk 30 Gün Hoş Geldin Duble Bonusu" & Esnek Fast-Start İkramiyesi Tetikleme
  app.post('/api/v1/admin/rewards/trigger-welcome-double-bonus', requireAdminJwt, (req, res) => {
    const targetMember = members.find(
      (m) => m.user_id === req.body?.user_id || String(m.id) === String(req.body?.user_id)
    );
    if (!targetMember) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }
    if (targetMember.fast_start_awarded) {
      res.status(409).json({
        status: 'error',
        code: 'FAST_START_ALREADY_AWARDED',
        message: 'Bu üyeye Hızlı Başlangıç / 30 gün bonusu daha önce tanımlanmış.',
      });
      return;
    }
    const windowDays = v2ArchitectureConfig.fast_start_window_days || 30;
    const joinedMs = targetMember.joined_at ? new Date(targetMember.joined_at).getTime() : NaN;
    const daysSinceJoin = (Date.now() - joinedMs) / 86400000;
    if (!Number.isFinite(daysSinceJoin) || daysSinceJoin > windowDays) {
      res.status(422).json({
        status: 'error',
        code: 'FAST_START_WINDOW_EXPIRED',
        message: `Bu bonus üyelik tarihinden itibaren ${windowDays} gün içinde tanımlanabilir.`,
      });
      return;
    }
    targetMember.fast_start_awarded = true;

    const isDoubleActive = v2ArchitectureConfig.welcome_30d_double_bonus_enabled !== false;
    const baseFastStart = 2500;
    const awardAmount = isDoubleActive ? baseFastStart * 2 : baseFastStart; // 5.000 $ Duble Bonus veya 2.500 $ Standart

    creditMemberWallet(targetMember, 'FAST_ROI_BONUS', awardAmount, true);

    const newReward: UserRewardLogRecord = {
      id: nextRewardLogId++,
      user_id: targetMember.id,
      external_user_id: targetMember.user_id,
      user_full_name: targetMember.full_name,
      career_level: targetMember.career_level,
      career_title: targetMember.career_title,
      reward_type: 'FAST_START',
      reward_description: isDoubleActive
        ? `İlk ${windowDays} Gün Hoş Geldin DUBLE Bonusu (2.500 $ × 2 = 5.000 $ Nakit İkramiye + %15 Fast-ROI Amortisman)`
        : `İlk ${windowDays} Gün Hızlı Başlangıç (Fast-Start) İkramiyesi (2.500 $)`,
      cash_value: awardAmount,
      is_delivered: true,
      earned_at: new Date().toISOString(),
    };
    userRewardsLog.unshift(newReward);

    enqueueNotification({
      member: targetMember,
      channel: 'WHATSAPP',
      trigger_type: 'WELCOME_30D_DOUBLE_BONUS',
      commission_amount: awardAmount,
      message: `Tebrikler Sayın ${targetMember.full_name}! İlk ${windowDays} gün içinde 3 aktif direkt referans hedefini tamamlayarak ${awardAmount.toLocaleString('tr-TR')} $ "${isDoubleActive ? 'İlk 30 Gün Hoş Geldin Duble Bonusu (2X)' : 'Hızlı Başlangıç İkramiyesi'}" kazandınız!`,
    });

    res.json({
      status: 'success',
      message: `🚀 ${targetMember.full_name} hesabına ${awardAmount.toLocaleString('tr-TR')} $ (${isDoubleActive ? 'İlk 30 Gün Hoş Geldin Duble Bonusu — 2X' : '14 Gün Hızlı Başlangıç Bonusu'}) tanımlandı ve WhatsApp bildirimi gönderildi!`,
      reward: newReward,
      state: buildStateResponse(),
    });
  });

  // 5️⃣ Anlık WhatsApp Business API & Push Story Paylaşım Bildirimi Gönder
  app.post('/api/v1/notifications/send-whatsapp-story', (req, res) => {
    const targetMember =
      members.find(
        (m) => m.user_id === req.body?.user_id || String(m.id) === String(req.body?.user_id)
      ) || members[0];
    if (!targetMember) {
      res.status(404).json({ status: 'error', message: 'Üye bulunamadı.' });
      return;
    }

    const orderAmount = Number(req.body?.order_amount) || 50000;
    const commissionAmount = Number(req.body?.commission_amount) || Math.round(orderAmount * 0.2);
    const buyerName = String(req.body?.buyer_name || 'Platin Klinik Bayi');

    const msg = `Tebrikler Sayın ${targetMember.full_name}! Ekibinizden ${orderAmount.toLocaleString(
      'tr-TR'
    )} $'lik yeni paket satışı gerçekleşti. Hesabınıza ${commissionAmount.toLocaleString(
      'tr-TR'
    )} $ Sponsor Primi tanımlandı.`;

    const notif = enqueueNotification({
      member: targetMember,
      channel: 'WHATSAPP',
      trigger_type: 'SPONSOR_COMMISSION_EARNED',
      order_amount: orderAmount,
      commission_amount: commissionAmount,
      buyer_name: buyerName,
      message: msg,
    });

    res.json({
      status: 'success',
      message: `📲 WhatsApp Business API & Push Bildirimi (${targetMember.phone}) gönderildi: "${msg}"`,
      notification: notif,
      state: buildStateResponse(),
    });
  });

  // ============================================================================
  // %20 VERGİ İADESİ (FATURA YÜKLEME & YÖNETİCİ ONAYI) VE CÜZDAN İLE ALIŞVERİŞ / YENİ BAYİ EKLEME ENDPOINT'LERİ
  // ============================================================================

  // Bayi Cihazdan Fatura Yükleyerek %20 Vergi İadesi Talebi Oluşturma Endpoint'i
  app.post('/api/v1/tax-refunds/upload-invoice', requireWithdrawalMember, async (req, res) => {
    try {
      const {
        withdrawal_id,
        invoice_no,
        tax_office_and_id,
        invoice_file_name,
        invoice_file_type,
        invoice_file_size,
        invoice_data_url,
      } = req.body || {};

      if (!invoice_data_url || !invoice_file_name) {
        res.status(400).json({
          status: 'error',
          message: 'Lütfen cihazınızdan geçerli bir fatura dosyası (PDF veya Görsel) seçerek yükleyiniz.',
        });
        return;
      }

      const member = members.find((m) => m.user_id === res.locals.memberUserId);
      if (!member) {
        res.status(404).json({ status: 'error', message: 'Bayi bulunamadı.' });
        return;
      }

      const linkedWithdrawal = withdrawal_id
        ? withdrawalRequests.find(
            (w) => String(w.id) === String(withdrawal_id) || String((w as any).db_id) === String(withdrawal_id)
          )
        : withdrawalRequests.find(
            (w) =>
              (w.user_id === member.id || w.external_user_id === member.user_id) &&
              w.tax_refund_status !== 'PENDING_ADMIN_APPROVAL' &&
              w.tax_refund_status !== 'APPROVED_CREDITED'
          );

      if (!linkedWithdrawal) {
        throw new Error('Vergi iadesi için geçerli bir çekim talebi seçilmelidir.');
      }
      if (linkedWithdrawal.user_id !== member.id && linkedWithdrawal.external_user_id !== member.user_id) {
        throw new Error('Çekim talebi seçilen bayiyle eşleşmiyor.');
      }
      if (linkedWithdrawal.status === 'REJECTED') {
        throw new Error('Reddedilmiş çekim için vergi iadesi talep edilemez.');
      }
      if (linkedWithdrawal.tax_refund_status === 'PENDING_ADMIN_APPROVAL' || linkedWithdrawal.tax_refund_status === 'APPROVED_CREDITED') {
        throw new Error('Bu çekim için vergi iadesi talebi zaten mevcut.');
      }

      const grossAmt = roundCurrency(linkedWithdrawal.gross_amount ?? linkedWithdrawal.amount);
      const taxAmt = roundCurrency(linkedWithdrawal.tax_deduction ?? grossAmt * WITHDRAWAL_TAX_RATE);
      const netAmt = roundCurrency(grossAmt - taxAmt);

      const invId = nextTaxRefundId++;
      const nowIso = new Date().toISOString();

      const newInvoice: TaxRefundInvoiceRecord = {
        id: invId,
        refund_code: `TAX-REF-${1000 + invId}`,
        withdrawal_id: linkedWithdrawal ? linkedWithdrawal.id : `WD-MAN-${invId}`,
        user_id: member.id,
        external_user_id: member.user_id,
        user_full_name: member.full_name,
        career_title: member.career_title,
        career_level: member.career_level,
        gross_withdrawal_amount: grossAmt,
        tax_deducted_amount: taxAmt,
        net_withdrawal_amount: netAmt,
        invoice_no: String(invoice_no || `FAT-${Date.now().toString().slice(-6)}`).trim(),
        tax_office_and_id: String(tax_office_and_id || member.city || 'Türkiye').trim(),
        invoice_file_name: String(invoice_file_name),
        invoice_file_type: String(invoice_file_type || 'application/octet-stream'),
        invoice_file_size: Number(invoice_file_size) || 0,
        invoice_data_url: String(invoice_data_url),
        iban: linkedWithdrawal?.bank_details?.iban || member.bank_details.iban || '',
        bank_name:
          linkedWithdrawal?.bank_details?.bank_name || member.bank_details.bank_name || 'Banka Hesabı',
        holder_name: member.full_name,
        status: 'PENDING_ADMIN_APPROVAL',
        requested_at: nowIso,
        processed_at: null,
        admin_note: 'Bayi tarafından cihazdan fatura yüklendi; Yönetici Vergi İadesi Panelinde onay bekliyor.',
      };

      taxRefundInvoices.unshift(newInvoice);

      if (linkedWithdrawal) {
        linkedWithdrawal.tax_refund_status = 'PENDING_ADMIN_APPROVAL';
        linkedWithdrawal.tax_refund_invoice_id = newInvoice.id;
        linkedWithdrawal.invoice_no = newInvoice.invoice_no;
        linkedWithdrawal.invoice_file_name = newInvoice.invoice_file_name;
        linkedWithdrawal.invoice_file_type = newInvoice.invoice_file_type;
        linkedWithdrawal.invoice_data_url = newInvoice.invoice_data_url;
      }

      res.status(201).json({
        status: 'success',
        message: `🧾 Faturanız (${newInvoice.invoice_file_name} · Fatura No: ${newInvoice.invoice_no}) başarıyla yüklendi ve Yönetici Vergi İadesi Paneline iletildi! Yönetici onayladığında +${taxAmt.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} $ (%20 Vergi İadesi) hesabınıza aktarılacaktır.`,
        invoice: newInvoice,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Fatura yüklenirken hata oluştu.',
      });
    }
  });

  // Yönetici Paneli: Vergi İadesi Faturasını Onaylama / Reddetme ve %20 Vergi İadesini Bayi Hesabına Aktarma
  app.post('/api/v1/admin/tax-refunds/:id/decision', requireAdminJwt, async (req, res) => {
    try {
      const invId = Number(req.params.id);
      const { decision, admin_note } = req.body || {};
      if (decision !== 'APPROVED' && decision !== 'REJECTED') {
        throw new Error('Vergi iadesi kararı APPROVED veya REJECTED olmalıdır.');
      }

      const result = await runInAtomicTransaction(() => {
        const inv = taxRefundInvoices.find((item) => item.id === invId);
        if (!inv) {
          throw new Error('Vergi iadesi fatura kaydı bulunamadı.');
        }
        if (inv.status !== 'PENDING_ADMIN_APPROVAL') {
          throw new Error('Bu vergi iadesi faturası daha önce işlenmiş.');
        }

        const member = members.find(
          (m) => m.id === inv.user_id || m.user_id === inv.external_user_id
        );
        const linkedWithdrawal = withdrawalRequests.find(
          (w) => String(w.id) === String(inv.withdrawal_id) || w.tax_refund_invoice_id === inv.id
        );
        if (decision === 'APPROVED' && !member) {
          throw new Error('Vergi iadesi alıcısı olan bayi bulunamadı.');
        }
        if (decision === 'APPROVED' && !linkedWithdrawal) {
          throw new Error('Vergi iadesi onayı için ilişkili çekim kaydı bulunmalıdır.');
        }
        if (decision === 'APPROVED' && linkedWithdrawal?.status === 'REJECTED') {
          throw new Error('Reddedilmiş çekim için vergi iadesi onaylanamaz.');
        }
        if (decision === 'APPROVED' && linkedWithdrawal && linkedWithdrawal.status !== 'APPROVED') {
          throw new Error('Bağlı çekim onaylanmadan vergi iadesi aktarılamaz.');
        }
        const nowIso = new Date().toISOString();

        if (decision === 'APPROVED') {
          inv.status = 'APPROVED_CREDITED';
          inv.processed_at = nowIso;
          inv.admin_note =
            admin_note ||
            `Yönetici tarafından fatura onaylandı; +$${inv.tax_deducted_amount.toFixed(2)} (%20 Vergi İadesi) Sistem Fonundan bayi hesabına aktarıldı.`;

          if (linkedWithdrawal) {
            linkedWithdrawal.tax_refund_status = 'APPROVED_CREDITED';
            linkedWithdrawal.admin_note = inv.admin_note;
          }

          // Sistem fonundan $ karşılığını düş ve bayinin bölgesel USD cüzdanına aktar
          systemCareerFundBalance = Math.max(
            0,
            roundCurrency(systemCareerFundBalance - usdToTry(inv.tax_deducted_amount))
          );
          systemWallet.system_pool_balance = Math.max(
            0,
            roundCurrency(systemWallet.system_pool_balance - usdToTry(inv.tax_deducted_amount))
          );
          systemWallet.updated_at = nowIso;
          if (members[0]) {
            members[0].wallets.system_fund_balance = systemCareerFundBalance;
          }

          if (member) {
            creditMemberRegionalUsd(member, inv.tax_deducted_amount);
            commissionLogs.unshift({
              id: nextCommissionLogId++,
              order_id: inv.refund_code,
              source_user_id: 1,
              source_external_id: 'SYSTEM_TAX_REFUND',
              source_user_name: `Vergi İadesi Onayı (Fatura: ${inv.invoice_no})`,
              target_user_id: member.id,
              target_external_id: member.user_id,
              target_user_name: member.full_name,
              type: 'SYSTEM_POOL',
              commission_type: 'CAREER_POOL',
              depth_level: member.career_level,
              amount: inv.tax_deducted_amount,
              status: 'RELEASED',
              clawback_status: 'RELEASED_TO_BALANCE',
              released_at: nowIso,
              transfer_reason_code: 'PAID',
              created_at: nowIso,
            });
          }
        } else {
          inv.status = 'REJECTED';
          inv.processed_at = nowIso;
          inv.admin_note =
            admin_note || 'Fatura bilgileri eksik/hatalı olduğundan vergi iadesi talebi reddedildi.';
          if (linkedWithdrawal) {
            linkedWithdrawal.tax_refund_status = 'REJECTED';
          }
        }

        return { inv, member };
      });

      res.json({
        status: 'success',
        message:
          decision === 'APPROVED'
            ? `✅ ${result.inv.user_full_name} bayisinin faturası (${result.inv.invoice_no}) onaylandı! Kesilen +${result.inv.tax_deducted_amount.toLocaleString('tr-TR', { minimumFractionDigits: 2 })} $ (%20 Vergi İadesi) Sistem Fonundan bayinin hesabına/cüzdanına anında aktarıldı.`
            : `❌ ${result.inv.user_full_name} bayisinin vergi iadesi faturası reddedildi.`,
        invoice: result.inv,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(400).json({
        status: 'error',
        message: err?.message || 'Vergi iadesi kararı uygulanamadı.',
      });
    }
  });

  app.post('/api/v1/wallet/purchase-package', requireWalletMember, async (req, res) => {
    try {
      const {
        payer_user_id,
        buyer_user_id,
        request_id,
        order_id,
        package_id,
        order_type = 'STANDARD_ORDER',
        note = 'Cüzdan Bakiyesi ile Paket Satın Alımı',
      } = req.body || {};
      const payerId = String(payer_user_id || '').trim();
      const buyerId = String(buyer_user_id || payerId).trim();
      const requestId = String(request_id || '').trim();
      const orderId = String(order_id || '').trim();
      if (!requestId || !orderId) {
        res.status(400).json({ status: 'error', code: 'REQUEST_ID_REQUIRED', message: 'Tekil cüzdan işlem kimliği zorunludur.' });
        return;
      }
      const payer = members.find((m) => m.user_id === payerId);
      const buyer = members.find((m) => m.user_id === buyerId);
      if (!payer || !buyer) {
        res.status(404).json({ status: 'error', code: 'MEMBER_NOT_FOUND', message: 'Ödeyen veya paketin tanımlanacağı bayi bulunamadı.' });
        return;
      }
      const isActivationPurchase = order_type === 'ACTIVATION';
      if (isActivationPurchase && payer.user_id !== buyer.user_id) {
        res.status(403).json({ status: 'error', code: 'ACTIVATION_SELF_PAYMENT_REQUIRED', message: 'Aktiflik yenileme bedeli yalnızca üyenin kendi bölgesel cüzdanından ödenebilir.' });
        return;
      }
      const normalizedPkg = isActivationPurchase ? null : normalizePackageId(String(package_id || ''));
      if (!isActivationPurchase && !normalizedPkg) {
        res.status(400).json({ status: 'error', code: 'INVALID_PACKAGE', message: 'Geçerli bir paket seçiniz.' });
        return;
      }
      const packageId = normalizedPkg ?? 'ACTIVATION';
      const pkgDef = normalizedPkg ? PACKAGES[normalizedPkg] : null;
      const productName = pkgDef ? pkgDef.name : '30 Günlük Süre Uzatma Paketi';
      const sessionCredits = pkgDef ? pkgDef.sessionCredits : 0;
      const cost = roundCurrency(
        normalizedPkg
          ? getPackagePriceForRegion(PACKAGES[normalizedPkg].defaultPrice, resolveMemberRegion(buyer.country_code))
          : getActivationOrderAmount(buyer.user_id)
      );
      const activityOrderType = isActivationPurchase
        ? 'ACTIVATION'
        : order_type === 'ACTIVITY_RENEWAL'
          ? 'ACTIVITY_RENEWAL'
          : 'STANDARD_ORDER';

      const result = await runInAtomicTransaction(() => {
        if (walletTransactions.some((entry) => entry.request_id === requestId)) {
          const error: any = new Error('Bu cüzdan isteği daha önce işlendi.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_WALLET_REQUEST';
          throw error;
        }
        const balanceBefore = getMemberRegionalUsdBalance(payer);
        const approvedContracts = new Set(['DISTANCE_SALES', 'PRE_INFORMATION', 'MLM_TERMS', 'KVKK']);
        userContractApprovals.forEach((approval) => {
          if (
            approval.order_id === orderId &&
            approval.user_id === buyer.user_id &&
            Math.round(Number(approval.order_amount) * 100) === Math.round(cost * 100) &&
            Boolean(approval.product_summary)
          ) approvedContracts.delete(approval.contract_type);
        });
        if (approvedContracts.size) {
          const error: any = new Error('Sipariş için zorunlu sözleşme onayları kaydedilmemiş.');
          error.statusCode = 400;
          error.code = 'CONTRACT_APPROVALS_MISSING';
          throw error;
        }
        if (balanceBefore < cost) {
          const error: any = new Error(`Çekilebilir cüzdan bakiyeniz yetersiz. Mevcut: $${balanceBefore.toFixed(2)}; gereken: $${cost.toFixed(2)}.`);
          error.statusCode = 422;
          error.code = 'INSUFFICIENT_WALLET_BALANCE';
          throw error;
        }
        if (payer.is_locked || buyer.is_locked) {
          const error: any = new Error('Kilitli bayi hesabı cüzdan alışverişi yapamaz.');
          error.statusCode = 403;
          error.code = 'MEMBER_LOCKED';
          throw error;
        }
        const nowIso = new Date().toISOString();
        const tx = processOrderCommission({
          user_id: buyer.user_id,
          order_id: orderId,
          order_amount: cost,
          package_id: packageId,
          order_type: activityOrderType,
          payment_method: 'WALLET_BALANCE',
          timestamp: nowIso,
        });
        debitMemberRegionalUsd(payer, cost);

        const walletTransaction: WalletTransactionRecord = {
          id: nextWalletTransactionId++,
          transaction_id: `WLT-${randomBytes(10).toString('hex').toUpperCase()}`,
          user_id: payer.id,
          external_user_id: payer.user_id,
          user_full_name: payer.full_name,
          transaction_type: activityOrderType === 'STANDARD_ORDER' ? 'CREDIT_PURCHASE_WALLET' : 'PACKAGE_PURCHASE_WALLET',
          request_id: requestId,
          direction: 'DEBIT',
          amount: cost,
          balance_before: balanceBefore,
          balance_after: getMemberRegionalUsdBalance(payer),
          order_id: orderId,
          related_user_id: buyer.user_id,
          package_id: packageId,
          description: pkgDef
            ? `${note} · ${productName} · +${sessionCredits} seans kredisi`
            : `${note} · ${productName} · $${cost.toFixed(2)} · aktiflik +${ACTIVITY_PERIOD_DAYS} gün`,
          status: 'COMPLETED',
          created_at: nowIso,
        };
        walletTransactions.unshift(walletTransaction);

        const p2pRecord: P2PTransferRecord = {
          id: nextP2PTransferId++,
          tx_code: `WLT-BUY-${randomBytes(5).toString('hex').toUpperCase()}`,
          from_user_id: payer.id,
          from_external_id: payer.user_id,
          from_user_name: payer.full_name,
          to_user_id: buyer.id,
          to_external_id: buyer.user_id,
          to_user_name: buyer.full_name,
          amount: cost,
          transfer_type: 'DIRECT_PACKAGE_ACTIVATION',
          package_id: packageId,
          voucher_code: null,
          note: pkgDef
            ? `${note} (${productName} · +${sessionCredits} Seans Kredisi)`
            : `${note} (${productName} · $${cost.toFixed(2)})`,
          status: 'COMPLETED',
          created_at: nowIso,
        };
        p2pTransfers.unshift(p2pRecord);
        return { tx, p2pRecord, walletTransaction, buyer };
      });

      res.status(201).json({
        status: 'success',
        message: pkgDef
          ? `${payer.full_name} cüzdanından ${cost.toLocaleString('tr-TR')} $ düşüldü; ${result.buyer.full_name} hesabına ${productName} tanımlandı (+${result.tx.session_credits_added} seans kredisi).`
          : `${payer.full_name} cüzdanından ${cost.toLocaleString('tr-TR')} $ düşüldü; ${result.buyer.full_name} hesabının aktifliği ${ACTIVITY_PERIOD_DAYS} gün uzatıldı (${productName}).`,
        transaction: result.tx,
        wallet_transaction: result.walletTransaction,
        transfer: result.p2pRecord,
        buyer: result.buyer,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({
        status: 'error',
        code: err?.code || 'WALLET_PURCHASE_FAILED',
        message: err?.message || 'Cüzdan ile paket/kredi alımı sırasında hata oluştu.',
      });
    }
  });

  // Bayi Cüzdan Bakiyesi ile Yeni Alt Bayi Ekleme ve Paket Ödemesini Gerçekleştirme Endpoint'i
  app.post('/api/v1/wallet/register-subdealer', requireWalletMember, async (req, res) => {
    try {
      const {
        payer_user_id,
        request_id,
        order_id,
        full_name,
        email,
        phone,
        city = 'İstanbul',
        country_code,
        initial_package_id = 'PKG_MINI_DENEME',
        password,
        assigned_leg,
      } = req.body || {};

      if (!full_name || String(full_name).trim().length < 2) {
        res.status(400).json({
          status: 'error',
          message: 'Yeni eklenecek bayinin Adı Soyadı zorunludur.',
        });
        return;
      }
      const normalizedCountryCode = String(country_code || 'TR').trim().toUpperCase();
      if (normalizedCountryCode !== 'TR') {
        res.status(400).json({
          status: 'error',
          code: 'DOMESTIC_ONLY_CHANNEL',
          message: 'Bakiye ile alt bayi kaydı yalnızca yurt içi (TR) üyeler için açıktır.',
        });
        return;
      }
      if (typeof password !== 'string' || password.length < 8) {
        res.status(400).json({ status: 'error', code: 'WEAK_MEMBER_PASSWORD', message: 'Yeni bayi şifresi en az 8 karakter olmalıdır.' });
        return;
      }

      const payerId = String(payer_user_id || '').trim();
      const requestId = String(request_id || '').trim();
      const orderId = String(order_id || '').trim();
      if (!requestId || !orderId) {
        res.status(400).json({ status: 'error', code: 'REQUEST_ID_REQUIRED', message: 'Tekil cüzdan işlem ve sipariş kimlikleri zorunludur.' });
        return;
      }
      const sponsor = members.find((m) => m.user_id === payerId);
      if (!sponsor) {
        res.status(404).json({ status: 'error', code: 'PAYER_NOT_FOUND', message: 'Ödeyen sponsor bayi bulunamadı.' });
        return;
      }

      const normalizedPkg = normalizePackageId(String(initial_package_id || ''));
      if (!normalizedPkg) {
        res.status(400).json({ status: 'error', code: 'INVALID_PACKAGE', message: 'Geçerli bir başlangıç paketi seçiniz.' });
        return;
      }
      const pkgDef = PACKAGES[normalizedPkg];
      const cost = roundCurrency(pkgDef.defaultPrice);

      const result = await runInAtomicTransaction(() => {
        if (walletTransactions.some((entry) => entry.request_id === requestId)) {
          const error: any = new Error('Bu cüzdan isteği daha önce işlendi.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_WALLET_REQUEST';
          throw error;
        }
        if (processedOrderIds.has(orderId) || ordersLog.some((entry) => entry.order_id === orderId)) {
          const error: any = new Error('Bu sipariş kimliği daha önce işlendi.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_ORDER_ID';
          throw error;
        }
        const balanceBefore = getMemberRegionalUsdBalance(sponsor);
        const approvedContracts = new Set(['DISTANCE_SALES', 'PRE_INFORMATION', 'MLM_TERMS', 'KVKK']);
        userContractApprovals.forEach((approval) => {
          if (
            approval.order_id === orderId &&
            approval.user_id === sponsor.user_id &&
            Math.round(Number(approval.order_amount) * 100) === Math.round(cost * 100) &&
            Boolean(approval.product_summary)
          ) approvedContracts.delete(approval.contract_type);
        });
        if (approvedContracts.size) {
          const error: any = new Error('Yeni bayi siparişi için zorunlu sözleşme onayları kaydedilmemiş.');
          error.statusCode = 400;
          error.code = 'CONTRACT_APPROVALS_MISSING';
          throw error;
        }
        if (balanceBefore < cost) {
          const error: any = new Error(`Sponsorun çekilebilir cüzdan bakiyesi yetersiz. Mevcut: $${balanceBefore.toFixed(2)}; gereken: $${cost.toFixed(2)}.`);
          error.statusCode = 422;
          error.code = 'INSUFFICIENT_WALLET_BALANCE';
          throw error;
        }
        if (sponsor.is_locked) {
          const error: any = new Error('Kilitli sponsor hesabı cüzdanla bayi kaydı ödeyemez.');
          error.statusCode = 403;
          error.code = 'MEMBER_LOCKED';
          throw error;
        }
        if (email && members.some((m) => m.email.toLowerCase() === String(email).trim().toLowerCase())) {
          const error: any = new Error('Bu e-posta adresiyle kayıtlı bir bayi zaten var.');
          error.statusCode = 409;
          error.code = 'DUPLICATE_EMAIL';
          throw error;
        }

        const nextLineId = members.length + 1;
        const randSuffix = Math.random().toString(36).substring(2, 8).toUpperCase();
        const newUserId = `USR-${randSuffix}`;
        const nowIso = new Date().toISOString();

        let finalLeg: 'LEFT' | 'RIGHT' = 'LEFT';
        if (assigned_leg === 'LEFT' || assigned_leg === 'RIGHT') {
          finalLeg = assigned_leg;
        } else if (sponsor) {
          const leftCount = members.filter(
            (m) => m.sponsor_id === sponsor.user_id && (m as any).assigned_leg === 'LEFT'
          ).length;
          const rightCount = members.filter(
            (m) => m.sponsor_id === sponsor.user_id && (m as any).assigned_leg === 'RIGHT'
          ).length;
          finalLeg = leftCount <= rightCount ? 'LEFT' : 'RIGHT';
        }

        const newMember: MonolineMember = {
          id: nextLineId,
          user_id: newUserId,
          global_line_id: nextLineId,
          ref_code: `AURA-BAYI-${Math.floor(1000 + Math.random() * 9000)}`,
          full_name: String(full_name).trim(),
          email:
            email && String(email).trim()
              ? String(email).trim()
              : `${String(full_name)
                  .toLowerCase()
                  .replace(/[^a-z0-9]/g, '.')
                  .replace(/\.+/g, '.')}@akngroupfrekans.com`,
          phone: phone ? String(phone).trim() : '',
          city: String(city || 'Türkiye').trim(),
          country_code: normalizedCountryCode,
          joined_at: nowIso,
          sponsor_id: sponsor.user_id,
          sponsor_db_id: sponsor.id,
          highest_package_id: normalizedPkg,
          session_credits: 0,
          personal_volume: 0,
          group_volume: 0,
          active_direct_referrals: 0,
          career_level: 1,
          career_title: 'Emmâre',
          manual_career_override: null,
          unlocked_depth: 1,
          wallets: {
            sponsor_wallet: 0,
            monoline_wallet: 0,
            career_pool_wallet: 0,
            total_earnings: 0,

            system_fund_balance: 0,
            total_withdrawn: 0,
          },
          bank_details: {
            iban_holder_name: String(full_name).trim(),
            bank_name: 'Ziraat Bankası',
            iban: `TR${Math.floor(10 + Math.random() * 89)} 0001 0004 8271 9283 10${nextLineId}`,
            trc20_address: '',
            preferred_method: 'IBAN',
          },
          two_factor: {
            enabled: false,
            secret_key: `JBSWY3DPEHPK3P${nextLineId + 20}`,
            verified_at: null,
            backup_codes: [`NF-${9000 + nextLineId}-A1`],
          },
          is_active: true,
          is_locked: false,
          activity_expires_at: createFutureExpiryIso(),
          welcome_bonus_granted: false,
          welcome_bonus_credits: 0,
          tc_identity_no: `${Math.floor(10000000000 + Math.random() * 89999999999)}`,
          has_tax_company: false,
          last_login_ip: `176.240.${Math.floor(10 + Math.random() * 200)}.${nextLineId}`,
          device_fingerprint: `DEV-FP-${nextLineId}`,
          kvkk_approved_at: nowIso,
          contract_version: 'v2.2',
          daily_withdrawal_limit: DAILY_WITHDRAWAL_LIMITS_BY_CAREER[1],
          fast_start_awarded: false,
          assigned_leg: finalLeg,
          left_leg_volume: 0,
          right_leg_volume: 0,
        };

        members.push(newMember);

        const tx = processOrderCommission({
          user_id: newUserId,
          order_id: orderId,
          order_amount: cost,
          package_id: normalizedPkg,
          payment_method: 'WALLET_BALANCE',
          timestamp: nowIso,
        });
        debitMemberRegionalUsd(sponsor, cost);
        memberCredentials.set(newMember.user_id, hashMemberPassword(password));
        const walletTransaction: WalletTransactionRecord = {
          id: nextWalletTransactionId++,
          transaction_id: `WLT-${randomBytes(10).toString('hex').toUpperCase()}`,
          user_id: sponsor.id,
          external_user_id: sponsor.user_id,
          user_full_name: sponsor.full_name,
          transaction_type: 'MEMBER_REGISTRATION_WALLET',
          request_id: requestId,
          direction: 'DEBIT',
          amount: cost,
          balance_before: balanceBefore,
          balance_after: getMemberRegionalUsdBalance(sponsor),
          order_id: orderId,
          related_user_id: newMember.user_id,
          package_id: normalizedPkg,
          description: `Yeni bayi kaydı · ${newMember.full_name} · ${pkgDef.name}`,
          status: 'COMPLETED',
          created_at: nowIso,
        };
        walletTransactions.unshift(walletTransaction);

        const p2pRecord: P2PTransferRecord = {
          id: nextP2PTransferId++,
          tx_code: `WLT-NEW-${9000 + nextP2PTransferId}`,
          from_user_id: sponsor.id,
          from_external_id: sponsor.user_id,
          from_user_name: sponsor.full_name,
          to_user_id: newMember.id,
          to_external_id: newMember.user_id,
          to_user_name: newMember.full_name,
          amount: cost,
          transfer_type: 'DIRECT_PACKAGE_ACTIVATION',
          package_id: normalizedPkg,
          voucher_code: null,
          note: `Yeni Alt Bayi (${newMember.full_name}) Kaydı & ${pkgDef.name} Ödemesi Cüzdan Bakiyesinden Gerçekleştirildi`,
          status: 'COMPLETED',
          created_at: nowIso,
        };
        p2pTransfers.unshift(p2pRecord);

        return { newMember, tx, p2pRecord, walletTransaction };
      });

      res.status(201).json({
        status: 'success',
        message: `🎉 Yeni Alt Bayiniz "${result.newMember.full_name}" (#${result.newMember.global_line_id} · Kod: ${result.newMember.ref_code}) ödemesi (${cost.toLocaleString('tr-TR')} $) kendi cüzdan bakiyenizden karşılanarak kaydedildi! Yeni bayiye ${result.newMember.session_credits} Seans Kredisi yüklendi ve sponsorluk komisyonunuz hesaplandı.`,
        member: result.newMember,
        transaction: result.tx,
        wallet_transaction: result.walletTransaction,
        transfer: result.p2pRecord,
        state: buildStateResponse(),
      });
    } catch (err: any) {
      res.status(err?.statusCode || 400).json({
        status: 'error',
        code: err?.code || 'MEMBER_REGISTRATION_FAILED',
        message: err?.message || 'Cüzdan ile yeni bayi kaydı sırasında hata oluştu.',
      });
    }
  });

  // ============================================================================
  // BANKA DENETİMİ, SANAL POS ADAPTER VE YASAL UYUM (user_contract_approvals)
  // ============================================================================
  interface UserContractApprovalRow {
    id: number;
    user_id: string;
    user_name: string;
    order_id: string;
    contract_type: 'DISTANCE_SALES' | 'PRE_INFORMATION' | 'MLM_TERMS' | 'KVKK';
    version: string;
    order_amount?: number;
    product_summary?: string;
    ip_address: string;
    approved_at: string;
  }

  const userContractApprovals: UserContractApprovalRow[] = [];
  let nextContractApprovalId = 1;

  interface PaymentLogRecord {
    id: number;
    merchant_oid: string;
    stage: 'INITIATE' | '3DS_CALLBACK';
    provider: string;
    user_id: string;
    request: Record<string, unknown>;
    response_status: 'SUCCESS' | 'FAILED';
    response_code: string | null;
    response_message: string | null;
    transaction_id?: string | null;
    ip_address: string;
    timestamp: string;
  }

  const paymentLogs: PaymentLogRecord[] = [];
  let nextPaymentLogId = 1;
  const finalizedMerchantOids = new Set<string>();
  const completedPayments = new Map<string, {
    transaction_id: string;
    order_id: string;
    user_id: string;
    amount: number;
    consumed: boolean;
  }>();

  const getRequestIp = (req: express.Request): string =>
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    'unknown';

  const appendPaymentLog = (entry: Omit<PaymentLogRecord, 'id' | 'timestamp'>) => {
    paymentLogs.push({ id: nextPaymentLogId++, timestamp: new Date().toISOString(), ...entry });
  };

  const paymentErrorCode = (err: unknown): string =>
    err instanceof PaymentProviderError ? err.code : 'PROVIDER_ERROR';

  const paymentProviderName = (): string => process.env.PAYMENT_PROVIDER || 'SANDBOX_TEST_POS';
  const sandboxPaymentsEnabled = () =>
    process.env.NODE_ENV !== 'production' ||
    (process.env.ALLOW_SANDBOX_PAYMENTS === 'true' &&
      process.env.ALLOW_SANDBOX_SETTLEMENT === 'true');

  app.get('/api/v1/payments/regional-prices', (req, res) => {
    const userId = String(req.query.user_id || '').trim();
    const requestedIds = String(req.query.package_ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    if (!userId || requestedIds.length === 0) {
      res.status(400).json({ status: 'error', message: 'Kullanıcı ve paket bilgileri zorunludur.' });
      return;
    }
    const prices: Record<string, number> = {};
    for (const rawId of requestedIds) {
      const packageId = normalizePackageId(rawId);
      if (packageId) prices[rawId] = getPackageOrderAmount(userId, packageId);
    }
    const member = members.find((m) => m.user_id === userId);
    res.json({ status: 'success', region: resolveMemberRegion(member?.country_code), prices });
  });

  app.post('/api/v1/payments/vpos/initiate', async (req, res) => {
    if (!sandboxPaymentsEnabled()) {
      res.status(503).json({ status: 'error', message: 'Sandbox POS üretim ortamında kapalıdır.' });
      return;
    }
    const body = req.body || {};
    const amount = Number(body.amount);
    const userId = String(body.user_id || '').trim();
    const orderId = String(body.order_id || '').trim();
    const merchantOid = `AURA-${Date.now().toString(36).toUpperCase()}-${randomBytes(8).toString('hex').toUpperCase()}`;
    const ip = getRequestIp(req);
    const card = body.card_details || {};
    const requestLog = {
      order_id: orderId,
      amount,
      card_last4: String(card.cardNumber || '').replace(/\D/g, '').slice(-4),
    };

    try {
      if (!userId || !orderId) {
        throw new PaymentProviderError('Kullanıcı ve sipariş bilgileri zorunludur.', 'INVALID_PAYMENT_CONTEXT');
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new PaymentProviderError('Tutar pozitif bir sayı olmalıdır.', 'INVALID_AMOUNT');
      }
      const expectedTotal = getPackageItemsTotal(userId, body.package_items);
      if (expectedTotal === null || Math.round(expectedTotal * 100) !== Math.round(amount * 100)) {
        throw new PaymentProviderError(
          'Ödeme tutarı sepetteki paketlerin bölgesel sunucu fiyatıyla eşleşmiyor.',
          'PACKAGE_AMOUNT_MISMATCH'
        );
      }
      const result = await createPaymentProvider().initiate({
        merchantOid,
        orderId,
        userId,
        amount,
        card,
      });
      appendPaymentLog({
        merchant_oid: merchantOid,
        stage: 'INITIATE',
        provider: result.provider,
        user_id: userId,
        request: requestLog,
        response_status: 'SUCCESS',
        response_code: null,
        response_message: '3D Secure doğrulaması bekleniyor',
        ip_address: ip,
      });
      res.json({
        status: 'success',
        merchant_oid: result.merchantOid,
        order_id: orderId,
        user_id: userId,
        requires_3ds: true,
        masked_card: result.maskedCard,
        provider: result.provider,
      });
    } catch (err: any) {
      const code = paymentErrorCode(err);
      appendPaymentLog({
        merchant_oid: merchantOid,
        stage: 'INITIATE',
        provider: paymentProviderName(),
        user_id: userId,
        request: requestLog,
        response_status: 'FAILED',
        response_code: code,
        response_message: err?.message || 'Sanal POS başlatılamadı.',
        ip_address: ip,
      });
      res.status(400).json({
        status: 'error',
        merchant_oid: merchantOid,
        error_code: code,
        message: err?.message || 'Sanal POS başlatılamadı.',
      });
    }
  });

  app.post('/api/v1/payments/vpos/callback', async (req, res) => {
    if (!sandboxPaymentsEnabled()) {
      res.status(503).json({ status: 'error', message: 'Sandbox 3DS üretim ortamında kapalıdır.' });
      return;
    }
    const body = req.body || {};
    const merchantOid = String(body.merchant_oid || '').trim();
    const userId = String(body.user_id || '').trim();
    const ip = getRequestIp(req);
    const provider = paymentProviderName();

    if (!merchantOid || finalizedMerchantOids.has(merchantOid)) {
      appendPaymentLog({
        merchant_oid: merchantOid,
        stage: '3DS_CALLBACK',
        provider,
        user_id: userId,
        request: {},
        response_status: 'FAILED',
        response_code: 'DUPLICATE_OR_MISSING_OID',
        response_message: 'Geçersiz veya daha önce sonuçlanmış işlem.',
        ip_address: ip,
      });
      res.status(409).json({
        status: 'error',
        merchant_oid: merchantOid,
        error_code: 'DUPLICATE_OR_MISSING_OID',
        message: 'Geçersiz veya daha önce sonuçlanmış işlem.',
      });
      return;
    }

    try {
      const result = await createPaymentProvider().complete3ds(
        merchantOid,
        String(body.sms_code || ''),
        userId
      );
      finalizedMerchantOids.add(merchantOid);
      if (result.success) {
        completedPayments.set(merchantOid, {
          transaction_id: result.transactionId,
          order_id: result.orderId,
          user_id: result.userId,
          amount: result.amount,
          consumed: false,
        });
      }
      appendPaymentLog({
        merchant_oid: merchantOid,
        stage: '3DS_CALLBACK',
        provider: result.provider,
        user_id: userId,
        request: { amount: result.amount, masked_card: result.maskedCard },
        response_status: result.success ? 'SUCCESS' : 'FAILED',
        response_code: result.errorCode,
        response_message: result.errorMessage || 'İşlem onaylandı',
        transaction_id: result.transactionId,
        ip_address: ip,
      });
      if (!result.success) {
        res.status(402).json({
          status: 'error',
          merchant_oid: merchantOid,
          error_code: result.errorCode,
          message: result.errorMessage,
        });
        return;
      }
      res.json({
        status: 'success',
        merchant_oid: merchantOid,
        transaction_id: result.transactionId,
        order_id: result.orderId,
        user_id: result.userId,
        charged_amount: result.amount,
        masked_card: result.maskedCard,
        provider: result.provider,
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      const code = paymentErrorCode(err);
      appendPaymentLog({
        merchant_oid: merchantOid,
        stage: '3DS_CALLBACK',
        provider,
        user_id: userId,
        request: {},
        response_status: 'FAILED',
        response_code: code,
        response_message: err?.message || '3D Secure doğrulaması başarısız.',
        ip_address: ip,
      });
      res.status(400).json({
        status: 'error',
        merchant_oid: merchantOid,
        error_code: code,
        message: err?.message || '3D Secure doğrulaması başarısız.',
      });
    }
  });

  app.get('/api/v1/payments/vpos/logs', requireAdminJwt, (_req, res) => {
    res.json({ status: 'success', logs: paymentLogs.slice(-500) });
  });

  app.post('/api/v1/compliance/contract-approvals', (req, res) => {
    const {
      user_id = 'USR-1001',
      user_name = 'AuraBio Bayi',
      order_id = '',
      order_amount,
      product_summary = '',
      version = 'v2.2',
      contracts = ['PRE_INFORMATION', 'DISTANCE_SALES', 'KVKK', 'MLM_TERMS'],
    } = req.body || {};

    const clientIp =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.socket.remoteAddress ||
      '176.240.10.1';
    const nowIso = new Date().toISOString();

    const createdRows: UserContractApprovalRow[] = [];
    const contractList = Array.isArray(contracts)
      ? contracts
      : ['PRE_INFORMATION', 'DISTANCE_SALES', 'KVKK', 'MLM_TERMS'];

    for (const cType of contractList) {
      const row: UserContractApprovalRow = {
        id: nextContractApprovalId++,
        user_id: String(user_id),
        user_name: String(user_name),
        order_id: String(order_id),
        contract_type: cType as UserContractApprovalRow['contract_type'],
        version: String(version),
        order_amount: Number.isFinite(Number(order_amount)) ? Number(order_amount) : undefined,
        product_summary: String(product_summary),
        ip_address: clientIp,
        approved_at: nowIso,
      };
      userContractApprovals.unshift(row);
      createdRows.push(row);
    }

    const member = members.find((m) => m.user_id === user_id || String(m.id) === String(user_id));
    if (member) {
      member.kvkk_approved_at = nowIso;
      member.contract_version = String(version);
      member.last_login_ip = clientIp;
    }

    res.status(201).json({
      status: 'success',
      message: `${createdRows.length} adet yasal sözleşme onayı (user_contract_approvals · Versiyon ${version} · IP: ${clientIp}) kayıt altına alındı.`,
      approvals: createdRows,
    });
  });

  app.get('/api/v1/compliance/contract-approvals', requireAdminJwt, (_req, res) => {
    res.json({
      status: 'success',
      approvals: userContractApprovals.slice(0, 200),
    });
  });

  app.post('/api/v1/simulation/full-career-journey', requireAdminJwt, (_req, res) => {
    // Live production mode: Maintain clean state
    resetToCleanSlate(true);
    res.json({
      status: 'success',
      message: 'Canlı üretim ortamı: Sistem temiz ve gerçek bayi siparişlerine hazır.',
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/reset', requireAdminJwt, (_req, res) => {
    resetToCleanSlate(true);
    res.json({
      status: 'success',
      message:
        'Sistem tamamen sıfırlandı. Tüm simülasyon verileri, demo kayıtlar, finansal cüzdanlar ve havuzlar temizlendi. Sistem sıfırdan canlı üretime hazır.',
      state: buildStateResponse(),
    });
  });

  app.post('/api/v1/admin/reset-metrics', (_req, res) => {
    transactions = [];
    ordersLog = [];
    commissionLogs = [];
    withdrawalRequests = [];
    poolDistributions = [];
    systemCareerFundBalance = 0;
    systemCareerFundCumulative = 0;
    systemWallet.system_pool_balance = 0;
    systemWallet.unclaimed_pool_balance = 0;
    members.forEach((m) => {
      m.wallets.wallet_domestic_usd = 0;
      m.wallets.wallet_international_usd = 0;
      m.wallets.sponsor_wallet = 0;
      m.wallets.monoline_wallet = 0;
      m.wallets.career_pool_wallet = 0;
      m.wallets.infinity_wallet = 0;
      m.wallets.matching_wallet = 0;
      m.wallets.total_earnings = 0;
      m.wallets.total_withdrawn = 0;
      m.wallets.pending_domestic_usd = 0;
      m.wallets.pending_international_usd = 0;
      m.personal_volume = 0;
      m.group_volume = 0;
      if (m.user_id !== 'USR-ADMIN') {
        m.session_credits = 0;
      }
    });
    res.json({
      status: 'success',
      message: 'Tüm havuz, satış hacmi ve komisyon sayaçları başarıyla sıfırlandı.',
      state: buildStateResponse(),
    });
  });

  app.get('/api/v1/admin/export-data', requireAdminJwt, (_req, res) => {
    res.json({
      status: 'success',
      timestamp: new Date().toISOString(),
      version: '2.2.0',
      data: {
        members,
        transactions,
        commissionLogs,
        ordersLog,
        systemWallet,
        distributionParams,
        careerTiers,
        withdrawalRequests,

        v2ArchitectureConfig,
        taxRefundInvoices,
        userRewardsLog,
        notificationOutbox,
        fomoCountdownAlerts,
        p2pTransfers,
        activationVouchers,
        fraudAlerts,
        cronLogs,
        poolDistributions,
        systemCareerFundBalance,
        systemCareerFundCumulative,
        webhookLogs: webhookLogs.slice(0, 100),
        usdTryRate,
        usdTryRateUpdatedAt,
        usdTryRateUpdatedBy,
        adminAuditLogs,
      },
    });
  });

  app.post('/api/v1/admin/restore-data', requireAdminJwt, (req, res) => {
    try {
      const payload = req.body?.data || req.body;
      if (!payload) {
        res.status(400).json({ status: 'error', message: 'Geçersiz veri paketi.' });
        return;
      }
      if (Array.isArray(payload.members) && payload.members.length > 0) {
        members = payload.members;
      }
      if (Array.isArray(payload.transactions)) {
        transactions = payload.transactions;
      }
      if (Array.isArray(payload.commissionLogs)) {
        commissionLogs = payload.commissionLogs;
      }
      if (Array.isArray(payload.ordersLog)) {
        ordersLog = payload.ordersLog;
      }
      if (payload.systemWallet) {
        systemWallet = payload.systemWallet;
      }
      if (payload.distributionParams) {
        distributionParams = {
          ...payload.distributionParams,
          system_fund_percent: SYSTEM_FUND_PERCENT,
          direct_sponsor_percent: DIRECT_SPONSOR_PERCENT,
          monoline_total_percent: 25,
          depth_percentages: [...MONOLINE_DEPTH_PERCENTAGES],
        };
      }
      if (payload.careerTiers) {
        careerTiers = payload.careerTiers;
      }
      if (payload.v2ArchitectureConfig) {
        v2ArchitectureConfig = { ...v2ArchitectureConfig, ...payload.v2ArchitectureConfig };
      }
      if (typeof payload.usdTryRate === 'number' && payload.usdTryRate > 0) {
        usdTryRate = roundCurrency(payload.usdTryRate);
        usdTryRateUpdatedAt = payload.usdTryRateUpdatedAt ?? null;
        usdTryRateUpdatedBy = payload.usdTryRateUpdatedBy ?? null;
      }
      if (Array.isArray(payload.adminAuditLogs)) {
        adminAuditLogs = payload.adminAuditLogs;
        nextAdminAuditLogId = adminAuditLogs.reduce((max, log) => Math.max(max, log.id), 0) + 1;
      }
      if (Array.isArray(payload.taxRefundInvoices)) {
        taxRefundInvoices = payload.taxRefundInvoices;
      }
      if (Array.isArray(payload.userRewardsLog)) {
        userRewardsLog = payload.userRewardsLog;
      }
      if (Array.isArray(payload.notificationOutbox)) {
        notificationOutbox = payload.notificationOutbox;
      }
      if (Array.isArray(payload.fomoCountdownAlerts)) {
        fomoCountdownAlerts = payload.fomoCountdownAlerts;
      }
      if (Array.isArray(payload.p2pTransfers)) {
        p2pTransfers = payload.p2pTransfers;
      }
      if (Array.isArray(payload.activationVouchers)) {
        activationVouchers = payload.activationVouchers;
      }
      if (Array.isArray(payload.fraudAlerts)) {
        fraudAlerts = payload.fraudAlerts;
      }
      if (Array.isArray(payload.cronLogs)) {
        cronLogs = payload.cronLogs;
      }
      if (Array.isArray(payload.poolDistributions)) {
        poolDistributions = payload.poolDistributions;
      }
      if (typeof payload.systemCareerFundBalance === 'number') {
        systemCareerFundBalance = payload.systemCareerFundBalance;
      }
      if (typeof payload.systemCareerFundCumulative === 'number') {
        systemCareerFundCumulative = payload.systemCareerFundCumulative;
      }
      if (Array.isArray(payload.withdrawalRequests)) {
        withdrawalRequests = payload.withdrawalRequests;
      }
      recalculateAllCareers('RESTORE_DATA');
      res.json({
        status: 'success',
        message: 'Tüm veriler başarıyla yüklendi ve sisteme anında entegre edildi.',
        state: buildStateResponse(),
      });
    } catch (e: any) {
      res.status(500).json({ status: 'error', message: e?.message || 'Veri geri yüklenirken hata oluştu.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Background Cron Job: Süresi dolan hesapları ve 14 günü dolan PENDING_14D komisyonları her 30 saniyede bir otomatik kontrol et
  setInterval(() => {
    checkAndExpireAccountsCron('ACTIVITY_EXPIRY_CRON');
    releaseMaturedCommissions();
  }, 30000);

  if (usdTryRateUpdatedAt === null) {
    console.warn(
      `WARNING: usdTryRate is not explicitly set. Falling back to default rate: ${DEFAULT_USD_TRY_RATE}. Set the rate from the admin panel before going live.`
    );
  }

  const PORT = Number(process.env.PORT || 3000);
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Monoline & Commission Engine running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
