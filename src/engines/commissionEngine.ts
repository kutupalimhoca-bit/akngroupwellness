import { resolveMemberRegion } from '../utils/walletRegion';

export const INTERNATIONAL_CAREER_MULTIPLIER = 3;

export const COMMISSION_RULES = {
  directSponsorRate: 0.2,
  monolineDepthRates: [0.07, 0.05, 0.04, 0.03, 0.02, 0.02, 0.02],
  systemPoolRate: 0.05,
  infinityCapPercent: 10,
  clawbackDays: 14,
  compressionMode: 'FULL_COMPRESSION',
  enforceCareerDepthLock: true,
} as const;

export const CAREER_RULES = [
  { level: 1, title: 'Emmâre', personal: 0, directs: 0, group: 0, maxLegPercent: 100, withdrawalLimit: 5000, requirements: [] as Array<[number, number]> },
  { level: 2, title: 'Levvâme', personal: 1000, directs: 10, group: 2000, maxLegPercent: 100, withdrawalLimit: 10000, requirements: [] as Array<[number, number]> },
  { level: 3, title: 'Mülhime', personal: 3000, directs: 20, group: 5000, maxLegPercent: 100, withdrawalLimit: 20000, requirements: [] as Array<[number, number]> },
  { level: 4, title: 'Mutmainne', personal: 7500, directs: 50, group: 10000, maxLegPercent: 50, withdrawalLimit: 35000, requirements: [[2, 1]] as Array<[number, number]> },
  { level: 5, title: 'Râziye', personal: 15000, directs: 100, group: 50000, maxLegPercent: 50, withdrawalLimit: 50000, requirements: [[3, 2]] as Array<[number, number]> },
  { level: 6, title: 'Marziyye', personal: 25000, directs: 500, group: 350000, maxLegPercent: 50, withdrawalLimit: 75000, requirements: [[4, 2], [3, 1]] as Array<[number, number]> },
  { level: 7, title: 'Kâmile', personal: 50000, directs: 1000, group: 1000000, maxLegPercent: 50, withdrawalLimit: 100000, requirements: [[5, 2], [4, 2]] as Array<[number, number]> },
] as const;

export const CAREER_REWARDS = {
  2: { title: 'Levvâme', description: '2. Kariyer (Levvâme) Gümüş Liderlik Rozeti & Başlangıç Nakit Ödülü', cash_value: 1500 },
  3: { title: 'Mülhime', description: '3. Kariyer (Mülhime) Altın Yaka Rozeti & Tek Seferlik Kariyer Nakit Ödülü', cash_value: 4000 },
  4: { title: 'Mutmainne', description: '4. Kariyer (Mutmainne) Özel Tasarım Kol Saati + Nakit Kariyer Ödülü', cash_value: 10000 },
  5: { title: 'Râziye', description: '5. Kariyer (Râziye) Amiral Gemisi Akıllı Telefon / Tablet + Liderlik Ödülü', cash_value: 25000 },
  6: { title: 'Marziyye', description: '6. Kariyer (Mardiyye) VIP Liderlik Tatili + Kurumsal Ofis Desteği', cash_value: 50000 },
  7: { title: 'Kâmile', description: '7. Kariyer (Sâfiye) Lüks Araç Katkı Fonu & Elmas Liderlik Ödülü', cash_value: 125000 },
} as const;

export const INFINITY_PERCENT_BY_CAREER = [0, 0, 0, 0, 2, 4, 7, 10] as const;
export const MATCHING_PERCENT_BY_CAREER = [0, 0, 0, 10, 15, 20, 25, 25] as const;

export type CompressionMode = 'FULL_COMPRESSION' | 'HYBRID_50_50' | 'FUND_SWEEP';
export type CommissionMember = {
  user_id?: string;
  is_active?: boolean;
  is_locked?: boolean;
  active_career_level?: number;
  career_level?: number;
  global_line_id?: number;
  full_name?: string;
  id?: string | number;
  __doc_id?: string;
  sponsor_id?: string | number | null;
  sponsor_db_id?: string | number | null;
};

export function roundCommissionCurrency(value: number): number {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function checkCareerEligibility(
  member: CommissionMember | null | undefined,
  depth: number,
  options: { enforceCareerDepthLock?: boolean; useActiveCareer?: boolean } = {},
) {
  const isActive = member?.is_active === true && member?.is_locked !== true;
  const careerLevel = Number(
    options.useActiveCareer === false
      ? member?.career_level ?? 1
      : member?.active_career_level ?? 1,
  );
  const hasDepth = options.enforceCareerDepthLock === false || careerLevel >= depth;
  return { eligible: isActive && hasDepth, isActive, careerLevel, hasDepth };
}

export function checkCareerTierEligibility(input: {
  tier: {
    level: number;
    personal: number;
    directs: number;
    group: number;
    maxLegPercent: number;
    requirements: ReadonlyArray<readonly [number, number]>;
    enforceStrictOrganizationRules?: boolean;
  };
  countryCode?: string | null;
  personalVolume: number;
  activeDirects: number;
  groupVolume: number;
  activityValid: boolean;
  legs: ReadonlyArray<{ id: string; volume: number; maxCareerLevel: number }>;
}) {
  const { legs } = input;
  const multiplier = resolveMemberRegion(input.countryCode) === 'INTERNATIONAL' ? INTERNATIONAL_CAREER_MULTIPLIER : 1;
  const tier = {
    ...input.tier,
    personal: input.tier.personal * multiplier,
    directs: input.tier.directs * multiplier,
    group: input.tier.group * multiplier,
  };
  const personalOk = input.activityValid && (tier.level === 1 || input.personalVolume >= tier.personal);
  const directsOk = input.activeDirects >= tier.directs;
  const maxSingleLeg = tier.group > 0 ? (tier.group * tier.maxLegPercent) / 100 : Infinity;
  const cappedGroup = tier.maxLegPercent < 100 && legs.length > 0
    ? legs.reduce((sum, leg) => sum + Math.min(leg.volume, maxSingleLeg), 0)
    : input.groupVolume;
  const groupOk = cappedGroup >= tier.group;
  const usedLegs = new Set<string>();
  let downlineOk = true;
  const downlineMatches = tier.requirements.map(([requiredCareer, requiredCount]) => {
    let matched = 0;
    for (const leg of legs) {
      if (usedLegs.has(leg.id) || leg.maxCareerLevel < requiredCareer) continue;
      usedLegs.add(leg.id);
      matched++;
      if (matched >= requiredCount) break;
    }
    if (matched < requiredCount) downlineOk = false;
    return { requiredCareer, requiredCount, matched };
  });
  const strictEligible = personalOk && directsOk && groupOk && downlineOk;
  return {
    personalOk,
    directsOk,
    groupOk,
    downlineOk,
    downlineMatches,
    cappedGroup,
    thresholds: { personal: tier.personal, directs: tier.directs, group: tier.group },
    eligible: tier.enforceStrictOrganizationRules === false
      ? personalOk && directsOk
      : strictEligible,
    strictEligible,
  };
}

export function calculateCommissions(input: {
  amount: number;
  sponsor?: CommissionMember | null;
  uplineCandidates: CommissionMember[];
  compressionMode?: CompressionMode;
  enforceCareerDepthLock?: boolean;
  useActiveCareer?: boolean;
  enableInfinity?: boolean;
  maxInfinityCapPercent?: number;
  enableMatching?: boolean;
}) {
  const amount = roundCommissionCurrency(input.amount);
  const mode = input.compressionMode || 'FULL_COMPRESSION';
  const enforceCareerDepthLock = input.enforceCareerDepthLock !== false;
  const useActiveCareer = input.useActiveCareer !== false;
  const sponsorAmount = roundCommissionCurrency(amount * COMMISSION_RULES.directSponsorRate);
  const sponsorEligible = checkCareerEligibility(input.sponsor, 1, { enforceCareerDepthLock: false }).isActive;
  const depthPayouts: Array<{
    depth: number;
    rate: number;
    rawAmount: number;
    amount: number;
    recipient: CommissionMember | null;
    skippedMembers: CommissionMember[];
  }> = [];
  let candidateCursor = 0;
  let unclaimedAmount = sponsorEligible ? 0 : sponsorAmount;

  for (let index = 0; index < COMMISSION_RULES.monolineDepthRates.length; index++) {
    const depth = index + 1;
    const rate = COMMISSION_RULES.monolineDepthRates[index];
    const rawAmount = roundCommissionCurrency(amount * rate);
    let payoutAmount = rawAmount;
    let recipient: CommissionMember | null = null;
    const skippedMembers: CommissionMember[] = [];

    if (mode === 'FUND_SWEEP') {
      recipient = input.uplineCandidates[index] || null;
    } else {
      while (candidateCursor < input.uplineCandidates.length) {
        const candidate = input.uplineCandidates[candidateCursor++];
        const eligibility = checkCareerEligibility(candidate, depth, {
          enforceCareerDepthLock,
          useActiveCareer,
        });
        if (eligibility.eligible) {
          recipient = candidate;
          break;
        }
        skippedMembers.push(candidate);
      }
      if (mode === 'HYBRID_50_50' && skippedMembers.length && recipient) {
        const poolAmount = roundCommissionCurrency(rawAmount * 0.5);
        payoutAmount = roundCommissionCurrency(rawAmount - poolAmount);
        unclaimedAmount = roundCommissionCurrency(unclaimedAmount + poolAmount);
      }
    }

    if (!recipient || !checkCareerEligibility(recipient, depth, { enforceCareerDepthLock, useActiveCareer }).eligible) {
      unclaimedAmount = roundCommissionCurrency(unclaimedAmount + payoutAmount);
    }
    depthPayouts.push({ depth, rate, rawAmount, amount: payoutAmount, recipient, skippedMembers });
  }

  const infinityPayouts: Array<{ recipient: CommissionMember; generation: number; percent: number; amount: number }> = [];
  let paidInfinityPercent = 0;
  const infinityCap = Math.min(
    COMMISSION_RULES.infinityCapPercent,
    input.maxInfinityCapPercent ?? COMMISSION_RULES.infinityCapPercent,
  );
  if (input.enableInfinity !== false) {
    input.uplineCandidates.forEach((ancestor, index) => {
      if (paidInfinityPercent >= infinityCap) return;
      const eligibility = checkCareerEligibility(ancestor, 1, { enforceCareerDepthLock: false, useActiveCareer });
      if (!eligibility.isActive) return;
      const memberPercent = Number(INFINITY_PERCENT_BY_CAREER[eligibility.careerLevel] || 0);
      const percent = roundCommissionCurrency(Math.min(infinityCap, memberPercent) - paidInfinityPercent);
      if (percent <= 0) return;
      const commissionAmount = roundCommissionCurrency(amount * percent / 100);
      if (commissionAmount <= 0) return;
      infinityPayouts.push({ recipient: ancestor, generation: index + 1, percent, amount: commissionAmount });
      paidInfinityPercent = roundCommissionCurrency(paidInfinityPercent + percent);
    });
  }

  const matchingPayouts: Array<{ recipient: CommissionMember; source: CommissionMember; sourceAmount: number; percent: number; amount: number }> = [];
  if (input.enableMatching !== false) {
    const earningsByMember = new Map<string, { member: CommissionMember; amount: number }>();
    depthPayouts.forEach((payout) => {
      if (
        !payout.recipient ||
        payout.amount <= 0 ||
        !checkCareerEligibility(payout.recipient, payout.depth, { enforceCareerDepthLock, useActiveCareer }).eligible
      ) return;
      const id = String(payout.recipient.user_id ?? '');
      const previous = earningsByMember.get(id);
      earningsByMember.set(id, {
        member: payout.recipient,
        amount: roundCommissionCurrency((previous?.amount || 0) + payout.amount),
      });
    });
    earningsByMember.forEach(({ member, amount: earnedAmount }) => {
      const ancestorIndex = input.uplineCandidates.findIndex(
        (ancestor) => String(ancestor.user_id) === String(member.user_id),
      );
      const sponsor = input.uplineCandidates[ancestorIndex + 1];
      if (!sponsor || earnedAmount <= 0) return;
      const eligibility = checkCareerEligibility(sponsor, 1, { enforceCareerDepthLock: false, useActiveCareer });
      if (!eligibility.isActive) return;
      const percent = Number(MATCHING_PERCENT_BY_CAREER[eligibility.careerLevel] || 0);
      const commissionAmount = roundCommissionCurrency(earnedAmount * percent / 100);
      if (percent <= 0 || commissionAmount <= 0) return;
      matchingPayouts.push({ recipient: sponsor, source: member, sourceAmount: earnedAmount, percent, amount: commissionAmount });
    });
  }

  return {
    sponsorAmount,
    sponsorEligible,
    baseSystemFund: roundCommissionCurrency(amount * COMMISSION_RULES.systemPoolRate),
    depthPayouts,
    infinityPayouts,
    matchingPayouts,
    infinityPercentPaid: paidInfinityPercent,
    unclaimedAmount,
  };
}

export function getSponsorAncestors(
  member: CommissionMember | null | undefined,
  byUserId: Map<string, CommissionMember>,
  byDocId: Map<string, CommissionMember> = new Map(),
  byDbId: Map<string, CommissionMember> = new Map(),
) {
  const ancestors: CommissionMember[] = [];
  const visited = new Set<string>([String(member?.user_id ?? '')]);
  let cursor = member;
  while (cursor) {
    const sponsorId = cursor.sponsor_id;
    const parent = byUserId.get(String(sponsorId)) || byDocId.get(String(sponsorId)) || byDbId.get(String(cursor.sponsor_db_id));
    if (!parent || visited.has(String(parent.user_id))) break;
    visited.add(String(parent.user_id));
    ancestors.push(parent);
    cursor = parent;
  }
  return ancestors;
}
