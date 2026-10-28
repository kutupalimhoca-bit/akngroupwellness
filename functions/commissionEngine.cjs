var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/engines/commissionEngine.ts
var commissionEngine_exports = {};
__export(commissionEngine_exports, {
  CAREER_REWARDS: () => CAREER_REWARDS,
  CAREER_RULES: () => CAREER_RULES,
  COMMISSION_RULES: () => COMMISSION_RULES,
  INFINITY_PERCENT_BY_CAREER: () => INFINITY_PERCENT_BY_CAREER,
  MATCHING_PERCENT_BY_CAREER: () => MATCHING_PERCENT_BY_CAREER,
  calculateCommissions: () => calculateCommissions,
  checkCareerEligibility: () => checkCareerEligibility,
  checkCareerTierEligibility: () => checkCareerTierEligibility,
  getSponsorAncestors: () => getSponsorAncestors,
  roundCommissionCurrency: () => roundCommissionCurrency
});
module.exports = __toCommonJS(commissionEngine_exports);
var COMMISSION_RULES = {
  directSponsorRate: 0.2,
  monolineDepthRates: [0.07, 0.05, 0.04, 0.03, 0.02, 0.02, 0.02],
  systemPoolRate: 0.05,
  fastStartRate: 0.15,
  infinityCapPercent: 10,
  clawbackDays: 14,
  compressionMode: "FULL_COMPRESSION",
  enforceCareerDepthLock: true
};
var CAREER_RULES = [
  { level: 1, title: "Emm\xE2re", personal: 0, directs: 0, group: 0, maxLegPercent: 100, withdrawalLimit: 5e3, requirements: [] },
  { level: 2, title: "Levv\xE2me", personal: 1e3, directs: 10, group: 2e3, maxLegPercent: 100, withdrawalLimit: 1e4, requirements: [] },
  { level: 3, title: "M\xFClhime", personal: 3e3, directs: 20, group: 5e3, maxLegPercent: 100, withdrawalLimit: 2e4, requirements: [] },
  { level: 4, title: "Mutmainne", personal: 7500, directs: 50, group: 1e4, maxLegPercent: 50, withdrawalLimit: 35e3, requirements: [[2, 1]] },
  { level: 5, title: "R\xE2ziye", personal: 15e3, directs: 100, group: 5e4, maxLegPercent: 50, withdrawalLimit: 5e4, requirements: [[3, 2]] },
  { level: 6, title: "Marziyye", personal: 25e3, directs: 500, group: 35e4, maxLegPercent: 50, withdrawalLimit: 75e3, requirements: [[4, 2], [3, 1]] },
  { level: 7, title: "K\xE2mile", personal: 5e4, directs: 1e3, group: 1e6, maxLegPercent: 50, withdrawalLimit: 1e5, requirements: [[5, 2], [4, 2]] }
];
var CAREER_REWARDS = {
  2: { title: "Levv\xE2me", description: "2. Kariyer (Levv\xE2me) G\xFCm\xFC\u015F Liderlik Rozeti & Ba\u015Flang\u0131\xE7 Nakit \xD6d\xFCl\xFC", cash_value: 1500 },
  3: { title: "M\xFClhime", description: "3. Kariyer (M\xFClhime) Alt\u0131n Yaka Rozeti & Tek Seferlik Kariyer Nakit \xD6d\xFCl\xFC", cash_value: 4e3 },
  4: { title: "Mutmainne", description: "4. Kariyer (Mutmainne) \xD6zel Tasar\u0131m Kol Saati + Nakit Kariyer \xD6d\xFCl\xFC", cash_value: 1e4 },
  5: { title: "R\xE2ziye", description: "5. Kariyer (R\xE2ziye) Amiral Gemisi Ak\u0131ll\u0131 Telefon / Tablet + Liderlik \xD6d\xFCl\xFC", cash_value: 25e3 },
  6: { title: "Marziyye", description: "6. Kariyer (Mardiyye) VIP Liderlik Tatili + Kurumsal Ofis Deste\u011Fi", cash_value: 5e4 },
  7: { title: "K\xE2mile", description: "7. Kariyer (S\xE2fiye) L\xFCks Ara\xE7 Katk\u0131 Fonu & Elmas Liderlik \xD6d\xFCl\xFC", cash_value: 125e3 }
};
var INFINITY_PERCENT_BY_CAREER = [0, 0, 0, 0, 2, 4, 7, 10];
var MATCHING_PERCENT_BY_CAREER = [0, 0, 0, 10, 15, 20, 25, 25];
function roundCommissionCurrency(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
function checkCareerEligibility(member, depth, options = {}) {
  const isActive = member?.is_active === true && member?.is_locked !== true;
  const careerLevel = Number(
    options.useActiveCareer === false ? member?.career_level ?? 1 : member?.active_career_level ?? 1
  );
  const hasDepth = options.enforceCareerDepthLock === false || careerLevel >= depth;
  return { eligible: isActive && hasDepth, isActive, careerLevel, hasDepth };
}
function checkCareerTierEligibility(input) {
  const { tier, legs } = input;
  const personalOk = input.activityValid && (tier.level === 1 || input.personalVolume >= tier.personal);
  const directsOk = input.activeDirects >= tier.directs;
  const maxSingleLeg = tier.group > 0 ? tier.group * tier.maxLegPercent / 100 : Infinity;
  const cappedGroup = tier.maxLegPercent < 100 && legs.length > 0 ? legs.reduce((sum, leg) => sum + Math.min(leg.volume, maxSingleLeg), 0) : input.groupVolume;
  const groupOk = cappedGroup >= tier.group;
  const usedLegs = /* @__PURE__ */ new Set();
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
    eligible: tier.enforceStrictOrganizationRules === false ? personalOk && directsOk : strictEligible,
    strictEligible
  };
}
function calculateCommissions(input) {
  const amount = roundCommissionCurrency(input.amount);
  const mode = input.compressionMode || "FULL_COMPRESSION";
  const enforceCareerDepthLock = input.enforceCareerDepthLock !== false;
  const useActiveCareer = input.useActiveCareer !== false;
  const sponsorAmount = roundCommissionCurrency(amount * COMMISSION_RULES.directSponsorRate);
  const sponsorEligible = checkCareerEligibility(input.sponsor, 1, { enforceCareerDepthLock: false }).isActive;
  const depthPayouts = [];
  let candidateCursor = 0;
  let unclaimedAmount = sponsorEligible ? 0 : sponsorAmount;
  for (let index = 0; index < COMMISSION_RULES.monolineDepthRates.length; index++) {
    const depth = index + 1;
    const rate = COMMISSION_RULES.monolineDepthRates[index];
    const rawAmount = roundCommissionCurrency(amount * rate);
    let payoutAmount = rawAmount;
    let recipient = null;
    const skippedMembers = [];
    if (mode === "FUND_SWEEP") {
      recipient = input.uplineCandidates[index] || null;
    } else {
      while (candidateCursor < input.uplineCandidates.length) {
        const candidate = input.uplineCandidates[candidateCursor++];
        const eligibility = checkCareerEligibility(candidate, depth, {
          enforceCareerDepthLock,
          useActiveCareer
        });
        if (eligibility.eligible) {
          recipient = candidate;
          break;
        }
        skippedMembers.push(candidate);
      }
      if (mode === "HYBRID_50_50" && skippedMembers.length && recipient) {
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
  const infinityPayouts = [];
  let paidInfinityPercent = 0;
  const infinityCap = Math.min(
    COMMISSION_RULES.infinityCapPercent,
    input.maxInfinityCapPercent ?? COMMISSION_RULES.infinityCapPercent
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
  const matchingPayouts = [];
  if (input.enableMatching !== false) {
    const earningsByMember = /* @__PURE__ */ new Map();
    depthPayouts.forEach((payout) => {
      if (!payout.recipient || payout.amount <= 0 || !checkCareerEligibility(payout.recipient, payout.depth, { enforceCareerDepthLock, useActiveCareer }).eligible) return;
      const id = String(payout.recipient.user_id ?? "");
      const previous = earningsByMember.get(id);
      earningsByMember.set(id, {
        member: payout.recipient,
        amount: roundCommissionCurrency((previous?.amount || 0) + payout.amount)
      });
    });
    earningsByMember.forEach(({ member, amount: earnedAmount }) => {
      const ancestorIndex = input.uplineCandidates.findIndex(
        (ancestor) => String(ancestor.user_id) === String(member.user_id)
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
    unclaimedAmount
  };
}
function getSponsorAncestors(member, byUserId, byDocId = /* @__PURE__ */ new Map(), byDbId = /* @__PURE__ */ new Map()) {
  const ancestors = [];
  const visited = /* @__PURE__ */ new Set([String(member?.user_id ?? "")]);
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CAREER_REWARDS,
  CAREER_RULES,
  COMMISSION_RULES,
  INFINITY_PERCENT_BY_CAREER,
  MATCHING_PERCENT_BY_CAREER,
  calculateCommissions,
  checkCareerEligibility,
  checkCareerTierEligibility,
  getSponsorAncestors,
  roundCommissionCurrency
});
