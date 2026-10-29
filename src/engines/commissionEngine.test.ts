import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAREER_RULES,
  COMMISSION_RULES,
  calculateCommissions,
  checkCareerEligibility,
  checkCareerTierEligibility,
} from './commissionEngine.ts';

test('shared commission rules allocate canonical sponsor, depth, and system rates', () => {
  const result = calculateCommissions({
    amount: 1000,
    sponsor: { user_id: 'sponsor', is_active: true, is_locked: false },
    uplineCandidates: [],
  });

  assert.equal(result.sponsorAmount, 200);
  assert.equal(result.baseSystemFund, 50);
  assert.equal(result.depthPayouts.reduce((sum, payout) => sum + payout.rawAmount, 0), 250);
  assert.equal(result.unclaimedAmount, 250);
  assert.equal(COMMISSION_RULES.clawbackDays, 14);
});

test('full compression skips inactive, locked, and under-depth members using active career', () => {
  const eligible = { user_id: 'eligible', is_active: true, is_locked: false, career_level: 7, active_career_level: 2 };
  const result = calculateCommissions({
    amount: 100,
    sponsor: null,
    uplineCandidates: [
      { user_id: 'inactive', is_active: false, career_level: 7 },
      { user_id: 'locked', is_active: true, is_locked: true, career_level: 7 },
      eligible,
    ],
  });

  assert.equal(result.depthPayouts[0].recipient?.user_id, 'eligible');
  assert.equal(result.depthPayouts[0].skippedMembers.length, 2);
  assert.equal(result.depthPayouts[0].amount, 7);
  assert.equal(result.depthPayouts[1].recipient, null);
  assert.equal(checkCareerEligibility(eligible, 3).eligible, false);
});

test('hybrid compression transfers half only when it must skip an ancestor', () => {
  const result = calculateCommissions({
    amount: 100,
    sponsor: null,
    compressionMode: 'HYBRID_50_50',
    uplineCandidates: [
      { user_id: 'inactive', is_active: false },
      { user_id: 'eligible', is_active: true, active_career_level: 7 },
    ],
  });

  assert.equal(result.depthPayouts[0].recipient?.user_id, 'eligible');
  assert.equal(result.depthPayouts[0].amount, 3.5);
  assert.equal(result.unclaimedAmount, 41.5);
});

test('shared engine calculates Infinity and Matching differentials from active careers', () => {
  const ancestors = [
    { user_id: 'a1', is_active: true, active_career_level: 1 },
    { user_id: 'a2', is_active: true, active_career_level: 3 },
    { user_id: 'a3', is_active: true, active_career_level: 4 },
    { user_id: 'a4', is_active: true, active_career_level: 5 },
  ];
  const result = calculateCommissions({ amount: 100, sponsor: ancestors[0], uplineCandidates: ancestors });

  assert.deepEqual(result.infinityPayouts.map(({ percent }) => percent), [2, 2]);
  assert.deepEqual(result.matchingPayouts.map(({ percent }) => percent), [10, 15, 20]);
  assert.equal(result.matchingPayouts[0].sourceAmount, result.depthPayouts[0].amount);
  assert.equal(checkCareerEligibility({ is_active: true, career_level: 7 }, 2).eligible, false);
});

test('career tier eligibility applies group balance and distinct leg requirements', () => {
  const tier = CAREER_RULES[3];
  const result = checkCareerTierEligibility({
    tier,
    activityValid: true,
    personalVolume: 7500,
    activeDirects: 50,
    groupVolume: 10000,
    legs: [
      { id: 'leg-a', volume: 5000, maxCareerLevel: 2 },
      { id: 'leg-b', volume: 5000, maxCareerLevel: 1 },
    ],
  });

  assert.equal(result.groupOk, true);
  assert.equal(result.downlineOk, true);
  assert.equal(result.eligible, true);
});

test('yurt dışı bayi kariyer eşiklerini 3 katı üzerinden değerlendirilir', () => {
  const tier = CAREER_RULES[3];
  const legs = [
    { id: 'leg-a', volume: 5000, maxCareerLevel: 2 },
    { id: 'leg-b', volume: 5000, maxCareerLevel: 1 },
  ];
  const base = { tier, activityValid: true, legs };

  const domesticEligible = checkCareerTierEligibility({
    ...base,
    countryCode: 'TR',
    personalVolume: 7500,
    activeDirects: 50,
    groupVolume: 10000,
  });
  assert.equal(domesticEligible.eligible, true);

  const internationalSameVolumes = checkCareerTierEligibility({
    ...base,
    countryCode: 'US',
    personalVolume: 7500,
    activeDirects: 50,
    groupVolume: 10000,
  });
  assert.equal(internationalSameVolumes.eligible, false);

  const internationalTripled = checkCareerTierEligibility({
    ...base,
    legs: [
      { id: 'leg-a', volume: 15000, maxCareerLevel: 2 },
      { id: 'leg-b', volume: 15000, maxCareerLevel: 1 },
    ],
    countryCode: 'US',
    personalVolume: 22500,
    activeDirects: 150,
    groupVolume: 30000,
  });
  assert.equal(internationalTripled.eligible, true);
});
