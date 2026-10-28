const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const { randomBytes } = require("crypto");
const {
  CAREER_RULES,
  CAREER_REWARDS,
  COMMISSION_RULES,
  calculateCommissions,
  checkCareerEligibility,
  checkCareerTierEligibility
} = require("./commissionEngine.cjs");

const PACKAGE_PRICES = {
  PKG_MINI_DENEME: 101,
  PKG_BRONZ_BASLANGIC: 201,
  PKG_GUMUS_STANDART: 302,
  PKG_GUMUS_PLUS: 402,
  PKG_ALTIN_DANISMAN: 503,
  PKG_ALTIN_PRO: 603,
  PKG_PLATIN_KLINIK: 1005,
  PKG_SAFIR_KURUMSAL: 1206,
  PKG_ZUMRUT_MASTER: 1407,
  PKG_YAKUT_ELIT: 1608,
  PKG_TITANYUM_ENTEGRE: 1809,
  PKG_ELMAS_BOLGE: 2010,
  PKG_MASTER_FRANCHISE: 4021,
  PKG_ENTERPRISE_MEGA: 6031,
  PAKET_A: 101,
  PAKET_B: 302,
  PAKET_C: 603,
  PAKET_D: 1005,
  "pkg-5k": 101,
  "pkg-10k": 201,
  "pkg-15k": 302,
  "pkg-20k": 402,
  "pkg-25k": 503,
  "pkg-30k": 603,
  "pkg-50k": 1005,
  "pkg-60k": 1206,
  "pkg-70k": 1407,
  "pkg-80k": 1608,
  "pkg-90k": 1809,
  "pkg-100k": 2010,
  "pkg-200k": 4021,
  "pkg-300k": 6031
};
const PACKAGE_CREDITS = {
  PKG_MINI_DENEME: 32, PKG_BRONZ_BASLANGIC: 70, PKG_GUMUS_STANDART: 115, PKG_GUMUS_PLUS: 160,
  PKG_ALTIN_DANISMAN: 215, PKG_ALTIN_PRO: 270, PKG_PLATIN_KLINIK: 500, PKG_SAFIR_KURUMSAL: 650,
  PKG_ZUMRUT_MASTER: 800, PKG_YAKUT_ELIT: 950, PKG_TITANYUM_ENTEGRE: 1100, PKG_ELMAS_BOLGE: 1300,
  PKG_MASTER_FRANCHISE: 3000, PKG_ENTERPRISE_MEGA: 5000,
  PAKET_A: 32, PAKET_B: 115, PAKET_C: 270, PAKET_D: 500,
  "pkg-5k": 32, "pkg-10k": 70, "pkg-15k": 115, "pkg-20k": 160, "pkg-25k": 215,
  "pkg-30k": 270, "pkg-50k": 500, "pkg-60k": 650, "pkg-70k": 800, "pkg-80k": 950,
  "pkg-90k": 1100, "pkg-100k": 1300, "pkg-200k": 3000, "pkg-300k": 5000
};

const INTERNATIONAL_PACKAGE_MULTIPLIER = 3;
const resolveMemberRegion = (countryCode) => {
  const normalized = String(countryCode || "").trim().toUpperCase();
  return !normalized || normalized === "TR" ? "DOMESTIC" : "INTERNATIONAL";
};
const regionWalletKey = (region) => (region === "INTERNATIONAL" ? "wallet_international_usd" : "wallet_domestic_usd");
const regionPendingKey = (region) => (region === "INTERNATIONAL" ? "pending_international_usd" : "pending_domestic_usd");
const ACTIVITY_PERIOD_DAYS = 30;

const COMMISSION_CONFIG = {
  DIRECT_SPONSOR_RATE: COMMISSION_RULES.directSponsorRate,
  FAST_ROI_RATE: COMMISSION_RULES.fastStartRate,
  CLAWBACK_DAYS: COMMISSION_RULES.clawbackDays,
  COMPRESSION_MODE: COMMISSION_RULES.compressionMode,
  ENFORCE_CAREER_DEPTH_LOCK: COMMISSION_RULES.enforceCareerDepthLock
};
const roundCurrency = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const careerLevelOf = (member) => Number(member.active_career_level ?? 1);

function recalculateCareerProfiles(users, recentOrderTotals, nowMs) {
  const byUserId = new Map(users.map((member) => [String(member.user_id), member]));
  const byDocId = new Map(users.filter((member) => member.__doc_id !== undefined).map((member) => [String(member.__doc_id), member]));
  const byDbId = new Map(users.filter((member) => member.id !== undefined).map((member) => [String(member.id), member]));
  const children = new Map(users.map((member) => [member.user_id, []]));

  for (const member of users) {
    const parent = byUserId.get(String(member.sponsor_id)) || byDocId.get(String(member.sponsor_id)) || byDbId.get(String(member.sponsor_db_id));
    if (parent && parent.user_id !== member.user_id) children.get(parent.user_id).push(member);
  }

  for (const member of users) {
    const recentVolume = recentOrderTotals.get(member.user_id) || 0;
    const rollingPersonal = member.is_active === true
      ? Math.max(Number(member.personal_volume || 0), recentVolume)
      : recentVolume;
    member.personal_volume_30d = roundCurrency(rollingPersonal);
    member.rolling_30d_personal_volume = roundCurrency(rollingPersonal);
    const visited = new Set([member.user_id]);
    const queue = [...(children.get(member.user_id) || [])];
    queue.forEach((child) => visited.add(child.user_id));
    let groupVolume = 0;
    while (queue.length) {
      const current = queue.shift();
      groupVolume = roundCurrency(groupVolume + Number(current.personal_volume_30d ?? current.personal_volume ?? 0));
      for (const child of children.get(current.user_id) || []) {
        if (visited.has(child.user_id)) continue;
        visited.add(child.user_id);
        queue.push(child);
      }
    }
    member.rolling_30d_pgv = groupVolume;
    member.group_volume_30d = groupVolume;
  }

  const evaluateLevel = (member) => {
    const directMembers = children.get(member.user_id) || [];
    const activeDirects = directMembers.filter((child) => child.is_active === true).length;
    const legs = directMembers.map((root) => {
      const visited = new Set([root.user_id]);
      const queue = [root];
      let volume = 0;
      let maxCareer = careerLevelOf(root);
      while (queue.length) {
        const current = queue.shift();
        volume = roundCurrency(volume + Number(current.personal_volume_30d || 0));
        maxCareer = Math.max(maxCareer, careerLevelOf(current));
        for (const child of children.get(current.user_id) || []) {
          if (visited.has(child.user_id)) continue;
          visited.add(child.user_id);
          queue.push(child);
        }
      }
      return { rootId: root.user_id, volume, maxCareer };
    }).sort((a, b) => b.volume - a.volume);

    const groupVolume = Math.max(
      roundCurrency(legs.reduce((sum, leg) => sum + leg.volume, 0)),
      Number(member.group_volume_30d || 0)
    );
    const personalVolume = Math.max(
      Number(member.personal_volume || 0),
      Number(member.personal_volume_30d || 0)
    );
    const expiresAt = member.activity_expires_at?.toDate
      ? member.activity_expires_at.toDate().getTime()
      : new Date(member.activity_expires_at || 0).getTime();
    const activityValid = member.is_active === true && expiresAt > nowMs;
    let targetLevel = 1;
    let chainAlive = true;

    for (const tier of CAREER_RULES) {
      const eligibility = checkCareerTierEligibility({
        tier,
        personalVolume,
        activeDirects,
        groupVolume,
        activityValid,
        legs: legs.map((leg) => ({ id: leg.rootId, volume: leg.volume, maxCareerLevel: leg.maxCareer }))
      });
      if (chainAlive && eligibility.eligible) {
        targetLevel = tier.level;
      } else if (chainAlive) {
        chainAlive = false;
      }
    }

    const manual = Number(member.manual_career_override);
    return Number.isInteger(manual) && manual >= 1 && manual <= 7 ? manual : targetLevel;
  };

  const reverseOrdered = [...users].sort((a, b) => Number(b.global_line_id || 0) - Number(a.global_line_id || 0));
  for (let pass = 0; pass < 7; pass++) {
    for (const member of reverseOrdered) {
      const oldMax = Number(member.max_career_level || member.career_level || 1);
      const nextMax = Math.max(oldMax, evaluateLevel(member));
      const activeLevel = member.is_active === true ? nextMax : 1;
      const tier = CAREER_RULES[nextMax - 1] || CAREER_RULES[0];
      const activeTier = CAREER_RULES[activeLevel - 1] || CAREER_RULES[0];
      member.max_career_level = nextMax;
      member.max_career_title = tier.title;
      member.career_level = nextMax;
      member.career_title = tier.title;
      member.active_career_level = activeLevel;
      member.active_career_title = activeTier.title;
      member.unlocked_depth = member.is_active === true ? activeLevel : 0;
      member.active_direct_referrals = (children.get(member.user_id) || []).filter((child) => child.is_active === true).length;
      member.active_direct_referrals_30d = member.active_direct_referrals;
      member.monoline_position = member.global_line_id;
      member.daily_withdrawal_limit = activeTier.withdrawalLimit;
      member.pool_leadership_points = member.is_active === true && !member.is_locked
        ? Math.max(10, activeLevel * activeLevel * 10 + Math.floor(Number(member.rolling_30d_pgv || 0) / 5000) + member.active_direct_referrals * 5)
        : 0;
    }
  }
  return users;
}

async function loadSponsorAncestors(transaction, buyerDoc, amount) {
  const buyerData = buyerDoc.data() || {};
  const buyer = { ...buyerData, __doc_id: buyerDoc.id, user_id: buyerData.user_id || buyerDoc.id };
  const ancestors = [];
  const visited = new Set([String(buyer.user_id), String(buyerDoc.id)]);
  let cursor = buyer;

  while (cursor) {
    let parentDoc = null;
    if (cursor.sponsor_id !== undefined && cursor.sponsor_id !== null && cursor.sponsor_id !== "") {
      const sponsorId = String(cursor.sponsor_id);
      const directDoc = await transaction.get(db.collection("users").doc(sponsorId));
      if (directDoc.exists) {
        parentDoc = directDoc;
      } else {
        const querySnapshot = await transaction.get(
          db.collection("users").where("user_id", "==", sponsorId).limit(1)
        );
        parentDoc = querySnapshot.docs[0] || null;
      }
    }
    if (!parentDoc && cursor.sponsor_db_id !== undefined && cursor.sponsor_db_id !== null) {
      const sponsorDbId = String(cursor.sponsor_db_id);
      const directDoc = await transaction.get(db.collection("users").doc(sponsorDbId));
      if (directDoc.exists) {
        parentDoc = directDoc;
      } else {
        const querySnapshot = await transaction.get(
          db.collection("users").where("id", "==", cursor.sponsor_db_id).limit(1)
        );
        parentDoc = querySnapshot.docs[0] || null;
      }
    }

    if (!parentDoc || visited.has(String(parentDoc.id))) break;
    const parentData = parentDoc.data() || {};
    const parent = { ...parentData, __doc_id: parentDoc.id, user_id: parentData.user_id || parentDoc.id };
    if (visited.has(String(parent.user_id))) break;
    visited.add(String(parent.user_id));
    visited.add(String(parentDoc.id));
    ancestors.push(parent);
    cursor = parent;
    const plan = calculateCommissions({
      amount,
      sponsor: ancestors[0],
      uplineCandidates: ancestors,
      compressionMode: COMMISSION_CONFIG.COMPRESSION_MODE,
      enforceCareerDepthLock: COMMISSION_CONFIG.ENFORCE_CAREER_DEPTH_LOCK,
      useActiveCareer: true
    });
    const allDepthsAssigned = plan.depthPayouts.every((payout) => payout.recipient);
    const allMatchingParentsLoaded = plan.depthPayouts
      .filter((payout) => payout.recipient && checkCareerEligibility(payout.recipient, payout.depth).eligible)
      .every((payout) => ancestors[ancestors.indexOf(payout.recipient) + 1]);
    const infinityComplete = plan.infinityPercentPaid >= COMMISSION_RULES.infinityCapPercent;
    if (allDepthsAssigned && allMatchingParentsLoaded && infinityComplete) break;
  }
  return { buyer, ancestors };
}

/**
 * Webhook HTTP Endpoint (Sanal POS veya Dış Sistem Tetiklemesi)
 * POST /api/v1/integrations/order-commission
 */
exports.recalculateCareerProfilesCron = functions
  .region("europe-west1")
  .pubsub.schedule("20 0 * * *")
  .timeZone("Europe/Istanbul")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();
    const nowMs = now.toMillis();
    const cutoff = new Date(nowMs - 30 * 86400000);
    const [usersSnapshot, timestampOrders, isoOrders] = await Promise.all([
      db.collection("users").get(),
      db.collection("orders_log").where("created_at", ">=", admin.firestore.Timestamp.fromDate(cutoff)).get(),
      db.collection("orders_log").where("created_at", ">=", cutoff.toISOString()).get()
    ]);
    const users = usersSnapshot.docs.map((doc) => {
      const data = doc.data() || {};
      return { ...data, __doc_id: doc.id, user_id: data.user_id || doc.id };
    });
    const recentOrderTotals = new Map();
    const orderDocs = new Map([...timestampOrders.docs, ...isoOrders.docs].map((doc) => [doc.id, doc]));
    orderDocs.forEach((doc) => {
      const order = doc.data() || {};
      const createdAt = order.created_at?.toDate
        ? order.created_at.toDate().getTime()
        : new Date(order.created_at || 0).getTime();
      const status = String(order.status || "COMPLETED").toUpperCase();
      if (
        !order.user_id || !Number.isFinite(createdAt) || createdAt < cutoff.getTime() || createdAt > nowMs ||
        ["CANCELLED", "CANCELED", "REFUNDED", "FAILED"].includes(status)
      ) return;
      const userId = String(order.user_id);
      recentOrderTotals.set(userId, roundCurrency(
        (recentOrderTotals.get(userId) || 0) + Number(order.order_amount ?? order.amount ?? 0)
      ));
    });

    const previousMaxCareer = new Map(users.map((member) => [
      String(member.user_id), Number(member.max_career_level || member.career_level || 1)
    ]));
    const sourceProfiles = new Map(users.map((member) => [member.__doc_id, {
      personal_volume: Number(member.personal_volume || 0),
      group_volume_30d: Number(member.group_volume_30d || 0),
      activity_expires_at: member.activity_expires_at,
      is_active: member.is_active === true,
      max_career_level: Number(member.max_career_level || member.career_level || 1),
      active_career_level: Number(member.active_career_level || 1)
    }]));
    const careerProfileFields = [
      "personal_volume_30d", "rolling_30d_personal_volume", "rolling_30d_pgv", "group_volume_30d",
      "max_career_level", "max_career_title", "career_level", "career_title",
      "active_career_level", "active_career_title", "active_direct_referrals",
      "active_direct_referrals_30d", "unlocked_depth", "monoline_position",
      "daily_withdrawal_limit", "pool_leadership_points"
    ];
    const previousProfiles = new Map(users.map((member) => [
      member.__doc_id,
      Object.fromEntries(careerProfileFields.map((field) => [field, member[field]]))
    ]));
    recalculateCareerProfiles(users, recentOrderTotals, nowMs);

    let updatedProfiles = 0;
    let createdRankUpRewards = 0;
    for (const member of users) {
      const prior = previousProfiles.get(member.__doc_id) || {};
      const updates = {};
      careerProfileFields.forEach((field) => {
        if (member[field] !== undefined && member[field] !== prior[field]) updates[field] = member[field];
      });
      const oldLevel = previousMaxCareer.get(String(member.user_id)) || 1;
      const newLevel = Number(member.max_career_level || 1);
      const rewardEntries = [];
      for (let level = Math.max(2, oldLevel + 1); level <= newLevel; level++) {
        const reward = CAREER_REWARDS[level];
        if (!reward) continue;
        const id = `${encodeURIComponent(String(member.user_id))}-RANK-${level}`;
        rewardEntries.push({
          ref: db.collection("user_rewards_log").doc(id),
          data: {
            id: Number.parseInt(randomBytes(6).toString("hex"), 16),
            user_id: member.id ?? member.__doc_id,
            external_user_id: member.user_id,
            user_full_name: member.full_name || "",
            career_level: level,
            career_title: CAREER_RULES[level - 1]?.title || reward.title,
            reward_type: "RANK_UP_GIFT",
            reward_description: reward.description,
            cash_value: reward.cash_value,
            is_delivered: false,
            earned_at: admin.firestore.FieldValue.serverTimestamp()
          }
        });
      }
      if (!Object.keys(updates).length && !rewardEntries.length) continue;
      const memberRef = db.collection("users").doc(member.__doc_id);
      const createdRewards = await db.runTransaction(async (transaction) => {
        const currentMemberDoc = await transaction.get(memberRef);
        if (!currentMemberDoc.exists) return 0;
        const currentMember = currentMemberDoc.data() || {};
        const source = sourceProfiles.get(member.__doc_id);
        const currentActivityExpiry = currentMember.activity_expires_at?.toDate
          ? currentMember.activity_expires_at.toDate().getTime()
          : new Date(currentMember.activity_expires_at || 0).getTime();
        const snapshotActivityExpiry = source.activity_expires_at?.toDate
          ? source.activity_expires_at.toDate().getTime()
          : new Date(source.activity_expires_at || 0).getTime();
        if (
          Number(currentMember.personal_volume || 0) !== source.personal_volume ||
          Number(currentMember.group_volume_30d || 0) !== source.group_volume_30d ||
          Number(currentMember.max_career_level || currentMember.career_level || 1) !== source.max_career_level ||
          Number(currentMember.active_career_level || 1) !== source.active_career_level ||
          currentActivityExpiry !== snapshotActivityExpiry ||
          (currentMember.is_active === true) !== source.is_active
        ) return 0;
        const rewardSnapshots = await Promise.all(rewardEntries.map(({ ref }) => transaction.get(ref)));
        const newRewards = rewardEntries.filter((_, index) => !rewardSnapshots[index].exists);
        if (Object.keys(updates).length) {
          transaction.set(memberRef, {
            ...updates,
            updated_at: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        newRewards.forEach(({ ref, data }) => transaction.set(ref, data));
        return newRewards.length;
      });
      updatedProfiles += Number(Object.keys(updates).length > 0);
      createdRankUpRewards += createdRewards;
    }
    console.log(`Kariyer profilleri yenilendi: ${users.length} kullanıcı, ${updatedProfiles} profil ve ${createdRankUpRewards} rank-up ödülü güncellendi.`);
    return null;
  });

exports.handleOrderCommission = functions
  .region("europe-west1")
  .https.onRequest(async (req, res) => {
    // CORS başlıkları
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.status(204).send("");
    }

    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method Not Allowed. Sadece POST istekleri kabul edilir." });
    }
    if (!sandboxPaymentsEnabled()) {
      return res.status(503).json({ success: false, error: "Sandbox settlement bu ortamda kapalıdır." });
    }

    const {
      user_id,
      order_id,
      order_amount,
      package_id = "PKG_MINI_DENEME",
      order_type = "STANDARD_ORDER",
      payment_method,
      merchant_oid,
      transaction_id,
      client_ip,
      device_fingerprint
    } = req.body || {};

    if (!user_id || order_amount === undefined || order_amount === null) {
      return res.status(400).json({
        success: false,
        error: "Zorunlu alanlar eksik: 'user_id' ve 'order_amount' zorunludur."
      });
    }

    const normalizedOrderId = String(order_id || `ORD-${Date.now()}`).trim();
    const amount = Number(order_amount);
    const isActivationOrder = order_type === "ACTIVATION";

    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: "Geçersiz sipariş tutarı: 'order_amount' sıfırdan büyük bir sayı olmalıdır."
      });
    }
    if (!isActivationOrder && !PACKAGE_PRICES[package_id]) {
      return res.status(400).json({ success: false, error: "Geçersiz paket kimliği." });
    }
    if (payment_method !== "CREDIT_CARD_3D" && payment_method !== "CARD_3D") {
      return res.status(402).json({ success: false, error: "Doğrulanmış 3D Sanal POS ödemesi gereklidir." });
    }

    try {
      // 1. Idempotency (Yinelenen Sipariş Engeli) Kontrolü
      const orderRef = db.collection("orders_log").doc(normalizedOrderId);
      const existingDoc = await orderRef.get();
      if (existingDoc.exists) {
        return res.status(200).json({
          status: "ALREADY_PROCESSED",
          message: `Sipariş #${normalizedOrderId} daha önce başarıyla işlenmiş.`
        });
      }

      // 2. Tüm okumaları tamamla, ardından tek transaction içinde kariyer ve ödemeleri yaz.
      const transactionResult = await db.runTransaction(async (transaction) => {
        const recheckDoc = await transaction.get(orderRef);
        if (recheckDoc.exists) return { alreadyProcessed: true };

        const paymentRef = db.collection("payment_transactions").doc(String(merchant_oid || ""));
        const buyerRef = db.collection("users").doc(user_id);
        const approvalQuery = db.collection("user_contract_approvals").where("order_id", "==", normalizedOrderId);
        const nowMs = admin.firestore.Timestamp.now().toMillis();

        const [paymentDoc, approvalDocs, buyerDoc] = await Promise.all([
          transaction.get(paymentRef),
          transaction.get(approvalQuery),
          transaction.get(buyerRef)
        ]);

        const requiredContracts = new Set(["DISTANCE_SALES", "PRE_INFORMATION", "KVKK", "MLM_TERMS"]);
        approvalDocs.forEach((approvalDoc) => {
          const approval = approvalDoc.data();
          if (
            approval.user_id === user_id &&
            Math.round(Number(approval.order_amount) * 100) === Math.round(amount * 100) &&
            approval.product_summary
          ) requiredContracts.delete(approval.contract_type);
        });
        if (requiredContracts.size) throw new Error("Sipariş için gerekli sözleşme onayları kayıtlı değil.");

        const payment = paymentDoc.exists ? paymentDoc.data() : null;
        if (
          !payment || payment.status !== "SUCCEEDED" || payment.consumed || payment.transaction_id !== transaction_id ||
          payment.order_id !== normalizedOrderId || payment.user_id !== user_id ||
          Math.round(Number(payment.amount) * 100) !== Math.round(amount * 100)
        ) throw new Error("Sipariş, tamamlanmış Sanal POS işlemiyle eşleşmiyor.");
        if (!buyerDoc.exists) throw new Error(`Kullanıcı (${user_id}) Firestore veritabanında bulunamadı!`);

        const buyerData = buyerDoc.data() || {};
        const buyerRegion = resolveMemberRegion(buyerData.country_code);
        const expectedBaseAmount = isActivationOrder ? 100 : PACKAGE_PRICES[package_id];
        const expectedAmountCents = expectedBaseAmount * (buyerRegion === "INTERNATIONAL" ? INTERNATIONAL_PACKAGE_MULTIPLIER : 1) * 100;
        if (Math.round(expectedAmountCents) !== Math.round(amount * 100)) {
          throw Object.assign(new Error("Paket tutarı sunucu fiyatıyla eşleşmiyor."), { code: "PACKAGE_AMOUNT_MISMATCH" });
        }

        const serverTimestamp = admin.firestore.FieldValue.serverTimestamp();
        const releaseAt = admin.firestore.Timestamp.fromDate(
          new Date(nowMs + COMMISSION_CONFIG.CLAWBACK_DAYS * 86400000)
        );
        const toMillis = (value) => {
          if (value && typeof value.toDate === "function") return value.toDate().getTime();
          if (value instanceof Date) return value.getTime();
          if (typeof value === "number") return value;
          if (value) return new Date(value).getTime();
          return NaN;
        };
        const { buyer: buyerMember, ancestors: buyerAncestors } = await loadSponsorAncestors(transaction, buyerDoc, amount);
        const sponsor = buyerAncestors[0] || null;
        // Kişisel hacim ve aktivite süresi sadece sunucu saatiyle hesaplanır; mevcut gelecek bitişe 30 gün eklenir.
        const sessionCreditsAdded = isActivationOrder ? 0 : PACKAGE_CREDITS[package_id];
        if (!isActivationOrder && !sessionCreditsAdded) throw new Error("Paket için seans kredisi tanımı bulunamadı.");
        const currentPv = Number(buyerData.personal_volume || 0);
        buyerMember.personal_volume = roundCurrency(currentPv + amount);
        buyerMember.session_credits = Number(buyerData.session_credits || 0) + sessionCreditsAdded;
        const currentExpiryMs = toMillis(buyerData.activity_expires_at);
        const expiryBaseMs = Number.isFinite(currentExpiryMs) ? Math.max(nowMs, currentExpiryMs) : nowMs;
        const activityExpiresAt = new Date(
          expiryBaseMs + ACTIVITY_PERIOD_DAYS * 86400000
        ).toISOString();
        buyerMember.activity_expires_at = activityExpiresAt;
        buyerMember.is_active = true;

        const compressionMode = COMMISSION_CONFIG.COMPRESSION_MODE;
        const commissionPlan = calculateCommissions({
          amount,
          sponsor,
          uplineCandidates: buyerAncestors,
          compressionMode,
          enforceCareerDepthLock: COMMISSION_CONFIG.ENFORCE_CAREER_DEPTH_LOCK,
          useActiveCareer: true
        });
        const directMembers = new Map();
        let fastStartAward = null;
        if (sponsor && !sponsor.fast_start_awarded) {
          const directQueries = [];
          if (sponsor.user_id) {
            directQueries.push(db.collection("users").where("sponsor_id", "==", sponsor.user_id));
          }
          if (sponsor.id !== undefined) {
            directQueries.push(db.collection("users").where("sponsor_db_id", "==", sponsor.id));
          }
          const directSnapshots = await Promise.all(directQueries.map((query) => transaction.get(query)));
          directSnapshots.forEach((snapshot) => snapshot.docs.forEach((doc) => {
            const data = doc.data() || {};
            directMembers.set(doc.id, { ...data, __doc_id: doc.id, user_id: data.user_id || doc.id });
          }));
          directMembers.set(buyerMember.__doc_id, buyerMember);
          const qualifyingDirects = [...directMembers.values()]
            .filter((member) => member.sponsor_id === sponsor.user_id || String(member.sponsor_db_id) === String(sponsor.id ?? sponsor.__doc_id))
            .map((member) => member.user_id === buyerMember.user_id ? buyerMember : member)
            .filter((member) => member.is_active === true && Number(member.personal_volume || 0) >= 5000)
            .sort((a, b) => Number(a.global_line_id || 0) - Number(b.global_line_id || 0));
          const joinedAtMs = toMillis(sponsor.joined_at);
          const withinWindow = !Number.isFinite(joinedAtMs) || nowMs - joinedAtMs <= 30 * 86400000;
          if (qualifyingDirects.length >= 3 && withinWindow) {
            const sponsorPackageFloor = Math.max(5000, Number(sponsor.personal_volume || 5000));
            const firstThreeSum = qualifyingDirects.slice(0, 3)
              .reduce((sum, member) => sum + Number(member.personal_volume || 5000), 0);
            const amortizedVolume = Math.min(sponsorPackageFloor * 3, firstThreeSum);
            const bonusAmount = roundCurrency(amortizedVolume * COMMISSION_CONFIG.FAST_ROI_RATE);
            sponsor.fast_start_awarded = true;
            fastStartAward = {
              member: sponsor,
              amount: bonusAmount,
              ref: db.collection("user_rewards_log").doc(`${encodeURIComponent(String(sponsor.user_id))}-FAST-START`),
              data: {
                id: Number.parseInt(randomBytes(6).toString("hex"), 16),
                user_id: sponsor.id ?? sponsor.__doc_id,
                external_user_id: sponsor.user_id,
                user_full_name: sponsor.full_name || "",
                career_level: Number(sponsor.career_level || 1),
                career_title: sponsor.career_title || CAREER_RULES[0].title,
                reward_type: "FAST_START",
                reward_description: `\"3 Getir Bedavaya Getir\" (Fast-ROI +%15 Amortisman Bonusu · 3 × ${sponsorPackageFloor.toLocaleString("tr-TR")} $ = ${amortizedVolume.toLocaleString("tr-TR")} $ × %15 = +${bonusAmount.toLocaleString("tr-TR")} $)`,
                cash_value: bonusAmount,
                is_delivered: true,
                earned_at: serverTimestamp
              }
            };
          }
        }
        const fastStartSnapshot = fastStartAward ? await transaction.get(fastStartAward.ref) : null;
        const newRewards = [];
        if (fastStartAward && fastStartSnapshot && !fastStartSnapshot.exists) {
          newRewards.push({ ref: fastStartAward.ref, data: fastStartAward.data });
        }

        const commissionLogs = [];
        const walletCredits = new Map();
        const monolinePayouts = [];
        let unclaimedAmount = commissionPlan.unclaimedAmount;
        const addWalletCredit = (member, walletFields, creditAmount, region = buyerRegion) => {
          const walletId = member.__doc_id;
          const prior = walletCredits.get(walletId) || { ref: db.collection("wallets").doc(walletId), values: {} };
          for (const field of Array.isArray(walletFields) ? walletFields : [walletFields]) {
            prior.values[field] = roundCurrency((prior.values[field] || 0) + creditAmount);
          }
          prior.values.total_earnings = roundCurrency((prior.values.total_earnings || 0) + creditAmount);
          const pendingKey = regionPendingKey(region);
          prior.values[pendingKey] = roundCurrency((prior.values[pendingKey] || 0) + creditAmount);
          walletCredits.set(walletId, prior);
        };
        const addCommissionLog = (
          sourceUserId,
          targetUserId,
          commissionType,
          creditAmount,
          ratePercent,
          depthLevel,
          region = buyerRegion,
          commissionOrderId = normalizedOrderId
        ) => {
          if (creditAmount <= 0) return;
          commissionLogs.push({
            order_id: commissionOrderId,
            source_user_id: sourceUserId,
            target_user_id: targetUserId,
            commission_type: commissionType,
            region,
            currency: "USD",
            ...(depthLevel === null ? {} : { depth_level: depthLevel }),
            amount: creditAmount,
            rate_percent: ratePercent,
            status: "PENDING_14D",
            release_at: releaseAt,
            created_at: serverTimestamp
          });
        };

        if (fastStartAward && fastStartSnapshot && !fastStartSnapshot.exists) {
          const bonusRegion = resolveMemberRegion(fastStartAward.member.country_code);
          addWalletCredit(fastStartAward.member, ["sponsor_wallet", "fast_roi_wallet"], fastStartAward.amount, bonusRegion);
          addCommissionLog(
            fastStartAward.member.__doc_id,
            fastStartAward.member.__doc_id,
            "FAST_ROI_BONUS",
            fastStartAward.amount,
            COMMISSION_CONFIG.FAST_ROI_RATE * 100,
            null,
            bonusRegion,
            `FAST-ROI-${fastStartAward.member.user_id}`
          );
        }

        const directSponsorAmount = commissionPlan.sponsorAmount;
        let directSponsorPaid = 0;
        if (directSponsorAmount > 0 && sponsor && commissionPlan.sponsorEligible) {
          directSponsorPaid = directSponsorAmount;
          addWalletCredit(sponsor, "sponsor_wallet", directSponsorPaid);
          addCommissionLog(user_id, sponsor.__doc_id, "SPONSOR", directSponsorPaid, COMMISSION_CONFIG.DIRECT_SPONSOR_RATE * 100, null);
        } else if (directSponsorAmount > 0) {
          commissionLogs.push({
            order_id: normalizedOrderId,
            source_user_id: user_id,
            target_user_id: sponsor?.__doc_id || null,
            commission_type: "SPONSOR",
            region: buyerRegion,
            currency: "USD",
            amount: directSponsorAmount,
            rate_percent: COMMISSION_CONFIG.DIRECT_SPONSOR_RATE * 100,
            status: sponsor ? "POOL_TRANSFER_INACTIVE" : "POOL_TRANSFER_NO_SPONSOR",
            release_at: serverTimestamp,
            created_at: serverTimestamp
          });
        }

        for (const payout of commissionPlan.depthPayouts) {
          const { depth, rate, amount: depthAmount, recipient: target } = payout;
          const ratePercent = rate * 100;
          if (!target) {
            commissionLogs.push({
              order_id: normalizedOrderId,
              source_user_id: user_id,
              target_user_id: null,
              commission_type: "MONOLINE_DEPTH",
              region: buyerRegion,
              currency: "USD",
              depth_level: depth,
              amount: depthAmount,
              rate_percent: ratePercent,
              status: "POOL_TRANSFER_NO_UPLINE",
              release_at: serverTimestamp,
              created_at: serverTimestamp
            });
            monolinePayouts.push({
              depth,
              rate_percent: ratePercent,
              calculated_amount: depthAmount,
              recipient_user_id: null,
              recipient_name: null,
              status: "TRANSFERRED_TO_POOL_NO_UPLINE"
            });
            continue;
          }
          const eligibility = checkCareerEligibility(target, depth, {
            enforceCareerDepthLock: COMMISSION_CONFIG.ENFORCE_CAREER_DEPTH_LOCK,
            useActiveCareer: true
          });
          if (!eligibility.eligible) {
            commissionLogs.push({
              order_id: normalizedOrderId,
              source_user_id: user_id,
              target_user_id: target.__doc_id,
              commission_type: "MONOLINE_DEPTH",
              region: buyerRegion,
              currency: "USD",
              depth_level: depth,
              amount: depthAmount,
              rate_percent: ratePercent,
              status: !eligibility.isActive ? "POOL_TRANSFER_INACTIVE" : "POOL_TRANSFER_CAREER_LOCK",
              release_at: serverTimestamp,
              created_at: serverTimestamp
            });
            monolinePayouts.push({
              depth,
              rate_percent: ratePercent,
              calculated_amount: depthAmount,
              recipient_user_id: target.user_id,
              recipient_name: target.full_name || null,
              status: !eligibility.isActive ? "TRANSFERRED_TO_POOL_INACTIVE" : "TRANSFERRED_TO_POOL_CAREER_LOCK"
            });
            continue;
          }
          addWalletCredit(target, "monoline_wallet", depthAmount);
          addCommissionLog(user_id, target.__doc_id, "MONOLINE_DEPTH", depthAmount, ratePercent, depth);
          monolinePayouts.push({
            depth,
            rate_percent: ratePercent,
            calculated_amount: depthAmount,
            recipient_user_id: target.user_id,
            recipient_name: target.full_name || null,
            recipient_global_line_id: target.global_line_id,
            recipient_career_level: eligibility.careerLevel,
            recipient_max_career_level: Number(target.max_career_level || target.career_level || 1),
            recipient_unlocked_depth: Number(target.unlocked_depth || eligibility.careerLevel),
            status: "PAID_TO_MEMBER"
          });
        }

        commissionPlan.infinityPayouts.forEach((payout) => {
          const recipient = payout.recipient;
          addWalletCredit(recipient, ["infinity_wallet", "monoline_wallet"], payout.amount);
          addCommissionLog(
            user_id,
            recipient.__doc_id,
            "UNILEVEL_INFINITY",
            payout.amount,
            payout.percent,
            payout.generation
          );
        });

        commissionPlan.matchingPayouts.forEach((payout) => {
          const recipient = payout.recipient;
          const region = resolveMemberRegion(recipient.country_code);
          addWalletCredit(
            recipient,
            ["matching_wallet", "career_pool_wallet"],
            payout.amount,
            region
          );
          addCommissionLog(
            payout.source.__doc_id,
            recipient.__doc_id,
            "MATCHING_BONUS",
            payout.amount,
            payout.percent,
            1,
            region
          );
        });

        const buyerUpdates = {
          session_credits: buyerMember.session_credits,
          personal_volume: buyerMember.personal_volume,
          last_order_amount: amount,
          last_order_at: serverTimestamp,
          activity_expires_at: activityExpiresAt,
          is_active: true,
          updated_at: serverTimestamp
        };
        const systemFundAmount = commissionPlan.baseSystemFund;
        const systemPoolInflow = roundCurrency(systemFundAmount + unclaimedAmount);
        const systemWalletRef = db.collection("wallets").doc("SYSTEM_MASTER_FUND");
        const logRefs = commissionLogs.map((log) => ({ ref: db.collection("commission_logs").doc(), data: log }));
        const writeCount = 3 + walletCredits.size + 1 + logRefs.length + newRewards.length + (fastStartAward ? 1 : 0);
        if (writeCount > 500) {
          throw Object.assign(
            new Error(`Sipariş transaction'ı ${writeCount} yazım gerektiriyor; Firestore transaction sınırı 500 yazımdır. Sipariş güvenli şekilde işlenmedi.`),
            { code: "COMMISSION_TRANSACTION_LIMIT" }
          );
        }

        // Bu noktadan sonra transaction içinde hiçbir get/query yapılmaz.
        transaction.update(paymentRef, {
          consumed: true,
          consumed_order_id: normalizedOrderId,
          consumed_at: serverTimestamp
        });
        transaction.set(orderRef, {
          order_id: normalizedOrderId,
          user_id,
          order_amount: amount,
          package_id,
          order_type,
          payment_method,
          merchant_oid,
          transaction_id,
          client_ip: client_ip || null,
          device_fingerprint: device_fingerprint || null,
          status: "COMPLETED",
          created_at: serverTimestamp
        });
        transaction.update(buyerRef, buyerUpdates);
        if (fastStartAward) {
          transaction.update(db.collection("users").doc(fastStartAward.member.__doc_id), {
            fast_start_awarded: true,
            updated_at: serverTimestamp
          });
        }
        walletCredits.forEach((credit) => {
          const walletUpdate = { updated_at: serverTimestamp };
          Object.entries(credit.values).forEach(([field, value]) => {
            walletUpdate[field] = admin.firestore.FieldValue.increment(value);
          });
          transaction.set(credit.ref, walletUpdate, { merge: true });
        });
        transaction.set(systemWalletRef, {
          system_pool_balance: admin.firestore.FieldValue.increment(systemPoolInflow),
          unclaimed_pool_balance: admin.firestore.FieldValue.increment(unclaimedAmount),
          total_fund_inflow: admin.firestore.FieldValue.increment(systemPoolInflow),
          updated_at: serverTimestamp
        }, { merge: true });
        logRefs.forEach(({ ref, data }) => transaction.set(ref, data));
        newRewards.forEach(({ ref, data }) => transaction.set(ref, data));

        return {
          alreadyProcessed: false,
          commissionLogsCount: commissionLogs.length,
          sessionCreditsAdded,
          activityExtended: true,
          directSponsorPaid,
          directSponsorId: sponsor?.user_id || null,
          monolinePayouts,
          systemFundAmount,
          careerUpgrades: [],
          clawbackStatus: "PENDING_14D"
        };
      });

      if (transactionResult.alreadyProcessed) {
        return res.status(200).json({
          status: "ALREADY_PROCESSED",
          message: "Sipariş daha önce işlenmiş."
        });
      }

      return res.status(200).json({
        success: true,
        order_id: normalizedOrderId,
        message: "Sipariş işlendi ve komisyonlar V2.2 kurallarına göre aktarıldı.",
        logs_count: transactionResult.commissionLogsCount,
        transaction: {
          transaction_id,
          order_id: normalizedOrderId,
          buyer_user_id: user_id,
          package_id,
          session_credits_added: transactionResult.sessionCreditsAdded,
          order_amount: amount,
          timestamp: new Date().toISOString(),
          activity_extended: transactionResult.activityExtended,
          clawback_status: transactionResult.clawbackStatus,
          system_fund_base_amount: transactionResult.systemFundAmount,
          direct_sponsor: {
            sponsor_user_id: transactionResult.directSponsorId,
            rate_percent: COMMISSION_CONFIG.DIRECT_SPONSOR_RATE * 100,
            amount_paid: transactionResult.directSponsorPaid
          },
          monoline_upline_payouts: transactionResult.monolinePayouts,
          career_upgrades_triggered: transactionResult.careerUpgrades
        }
      });
    } catch (error) {
      console.error("Commission Processing Error:", error);
      return res.status(error.code === "PACKAGE_AMOUNT_MISMATCH" ? 400 : 500).json({
        success: false,
        error: error.message || "Bilinmeyen bir hata oluştu."
      });
    }
  });

const SANDBOX_CARDS = {
  "4543450000000001": { scenario: "SUCCESS", code: null, message: null },
  "4543450000000002": { scenario: "INSUFFICIENT_FUNDS", code: "51", message: "Kart bakiyesi yetersiz." },
  "4543450000000003": { scenario: "LIMIT_EXCEEDED", code: "61", message: "Kart limiti yetersiz." },
  "4543450000000004": { scenario: "THREE_D_FAILED", code: "3D-FAIL", message: "3D Secure doğrulaması başarısız oldu." }
};
const sandboxSmsCode = () => process.env.SANDBOX_3DS_SMS_CODE || "123456";
const sandboxPaymentsEnabled = () =>
  process.env.PAYMENT_ENVIRONMENT === "sandbox" &&
  process.env.PAYMENT_PROVIDER === "SANDBOX_TEST_POS" &&
  process.env.ALLOW_SANDBOX_PAYMENTS === "true" &&
  process.env.ALLOW_SANDBOX_SETTLEMENT === "true";
const requestIp = (req) => (req.get("x-forwarded-for") || req.ip || "unknown").split(",")[0].trim();
const logPayment = (record) => db.collection("payment_logs").add({
  ...record,
  timestamp: admin.firestore.FieldValue.serverTimestamp()
});

exports.initiateVpos = functions.region("europe-west1").https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ status: "error", message: "Yalnızca POST kabul edilir." });
  if (!sandboxPaymentsEnabled()) return res.status(503).json({ status: "error", message: "Sandbox POS bu ortamda kapalıdır." });
  const provider = process.env.PAYMENT_PROVIDER || "SANDBOX_TEST_POS";
  const body = req.body || {};
  const merchantOid = `AURA-${Date.now().toString(36).toUpperCase()}-${randomBytes(8).toString("hex").toUpperCase()}`;
  const userId = String(body.user_id || "").trim();
  const orderId = String(body.order_id || "").trim();
  const amount = Number(body.amount);
  const card = body.card_details || {};
  const digits = String(card.cardNumber || "").replaceAll(" ", "").replaceAll("-", "");
  const scenario = SANDBOX_CARDS[digits];
  const request = { order_id: orderId, amount, card_last4: digits.slice(-4) };
  try {
    if (provider !== "SANDBOX_TEST_POS") throw Object.assign(new Error("Seçili sağlayıcı henüz bağlanmadı."), { code: "PROVIDER_NOT_CONNECTED" });
    if (!userId || !orderId || !Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error("Kullanıcı, sipariş ve pozitif tutar zorunludur."), { code: "INVALID_PAYMENT_CONTEXT" });
    if (!card.cardHolder || String(card.cardHolder).trim().length < 3) throw Object.assign(new Error("Kart üzerindeki ad soyad zorunludur."), { code: "INVALID_CARD_HOLDER" });
    if (digits.length !== 16) throw Object.assign(new Error("Kart numarası 16 haneli olmalıdır."), { code: "INVALID_CARD_NUMBER" });
    const expiry = String(card.cardExpiry || "").split("/");
    const expiryDigitsValid = expiry.length === 2 && expiry.every((part) => part.length === 2 && part.split("").every((digit) => digit >= "0" && digit <= "9"));
    if (!expiryDigitsValid || Number(expiry[0]) < 1 || Number(expiry[0]) > 12) throw Object.assign(new Error("Son kullanma tarihi AA/YY formatında olmalıdır."), { code: "INVALID_CARD_EXPIRY" });
    const cvv = String(card.cardCvv || "");
    if ((cvv.length !== 3 && cvv.length !== 4) || !cvv.split("").every((digit) => digit >= "0" && digit <= "9")) throw Object.assign(new Error("CVV 3 veya 4 haneli olmalıdır."), { code: "INVALID_CARD_CVV" });
    if (!scenario) throw Object.assign(new Error("Sandbox ortamında yalnızca test kartları kabul edilir."), { code: "SANDBOX_CARD_NOT_ALLOWED" });
    const maskedCard = `${digits.slice(0, 4)} **** **** ${digits.slice(-4)}`;
    await db.collection("payment_transactions").doc(merchantOid).create({ merchant_oid: merchantOid, order_id: orderId, user_id: userId, amount, scenario: scenario.scenario, masked_card: maskedCard, provider, status: "PENDING_3DS", expires_at: Date.now() + 600000, consumed: false });
    await logPayment({ merchant_oid: merchantOid, stage: "INITIATE", provider, user_id: userId, request, response_status: "SUCCESS", response_code: null, response_message: "3D Secure doğrulaması bekleniyor", ip_address: requestIp(req) });
    return res.json({ status: "success", merchant_oid: merchantOid, order_id: orderId, user_id: userId, requires_3ds: true, masked_card: maskedCard, provider });
  } catch (error) {
    const code = error.code || "PROVIDER_ERROR";
    const message = error.message || "Sanal POS başlatılamadı.";
    await logPayment({ merchant_oid: merchantOid, stage: "INITIATE", provider, user_id: userId || "UNKNOWN", request, response_status: "FAILED", response_code: code, response_message: message, ip_address: requestIp(req) });
    return res.status(400).json({ status: "error", merchant_oid: merchantOid, error_code: code, message });
  }
});

exports.vposCallback = functions.region("europe-west1").https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ status: "error", message: "Yalnızca POST kabul edilir." });
  if (!sandboxPaymentsEnabled()) return res.status(503).json({ status: "error", message: "Sandbox 3DS bu ortamda kapalıdır." });
  const body = req.body || {};
  const merchantOid = String(body.merchant_oid || "").trim();
  const userId = String(body.user_id || "").trim();
  if (!merchantOid || !userId) return res.status(400).json({ status: "error", message: "İşlem ve kullanıcı kimliği zorunludur." });
  const provider = process.env.PAYMENT_PROVIDER || "SANDBOX_TEST_POS";
  const paymentRef = db.collection("payment_transactions").doc(merchantOid);
  try {
    const result = await db.runTransaction(async (transaction) => {
      const paymentDoc = await transaction.get(paymentRef);
      const payment = paymentDoc.exists ? paymentDoc.data() : null;
      if (!payment || payment.status !== "PENDING_3DS" || payment.expires_at < Date.now() || payment.user_id !== userId) throw Object.assign(new Error("Ödeme oturumu geçersiz veya kullanıcıyla eşleşmiyor."), { code: "PAYMENT_SESSION_INVALID" });
      if (String(body.sms_code || "").trim() !== sandboxSmsCode()) throw Object.assign(new Error("SMS onay kodu hatalı."), { code: "3D-SMS-INVALID" });
      const card = Object.values(SANDBOX_CARDS).find((entry) => entry.scenario === payment.scenario);
      const success = payment.scenario === "SUCCESS";
      const transactionId = `SIM-POS-${Date.now()}-${randomBytes(6).toString("hex").toUpperCase()}`;
      const responseMessage = success ? "İşlem onaylandı" : card.message;
      transaction.update(paymentRef, {
        status: success ? "SUCCEEDED" : "DECLINED",
        transaction_id: transactionId,
        response_code: success ? null : card.code,
        response_message: responseMessage,
        completed_at: admin.firestore.FieldValue.serverTimestamp()
      });
      return { payment, success, transactionId, errorCode: success ? null : card.code, errorMessage: responseMessage };
    });
    await logPayment({ merchant_oid: merchantOid, stage: "3DS_CALLBACK", provider, user_id: userId, request: { amount: result.payment.amount, masked_card: result.payment.masked_card }, response_status: result.success ? "SUCCESS" : "FAILED", response_code: result.errorCode, response_message: result.errorMessage, transaction_id: result.transactionId, ip_address: requestIp(req) });
    if (!result.success) return res.status(402).json({ status: "error", merchant_oid: merchantOid, error_code: result.errorCode, message: result.errorMessage });
    return res.json({ status: "success", merchant_oid: merchantOid, order_id: result.payment.order_id, user_id: userId, transaction_id: result.transactionId, charged_amount: result.payment.amount, masked_card: result.payment.masked_card, provider, timestamp: new Date().toISOString() });
  } catch (error) {
    const code = error.code || "PROVIDER_ERROR";
    const message = error.message || "3D Secure doğrulaması başarısız.";
    await logPayment({ merchant_oid: merchantOid, stage: "3DS_CALLBACK", provider, user_id: userId || "UNKNOWN", request: {}, response_status: "FAILED", response_code: code, response_message: message, ip_address: requestIp(req) });
    return res.status(code === "3D-SMS-INVALID" ? 400 : 409).json({ status: "error", merchant_oid: merchantOid, error_code: code, message });
  }
});

/**
 * 4. Gece Çalışacak Otomatik Cron Görevi (Scheduled Cloud Function)
 * 14 günlük cayma süresi dolan komisyonları bölgesel pending_*_usd alanından wallet_*_usd (çekilebilir bakiye) alanına aktarır.
 * Her gece 00:05'te çalışır (Europe/Istanbul saat dilimi).
 */
exports.recordContractApprovals = functions.region("europe-west1").https.onRequest(async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ status: "error", message: "Yalnızca POST kabul edilir." });
  const body = req.body || {};
  const userId = String(body.user_id || "").trim();
  const orderId = String(body.order_id || "").trim();
  const contracts = Array.isArray(body.contracts) ? body.contracts : [];
  const allowed = new Set(["DISTANCE_SALES", "PRE_INFORMATION", "MLM_TERMS", "KVKK"]);
  if (!userId || !orderId || contracts.length === 0 || contracts.some((type) => !allowed.has(type))) {
    return res.status(400).json({ status: "error", message: "Kullanıcı, sipariş ve geçerli sözleşme türleri zorunludur." });
  }
  const approvedAt = new Date().toISOString();
  const serverApprovedAt = admin.firestore.FieldValue.serverTimestamp();
  const ip = requestIp(req);
  try {
    const approvals = await Promise.all(contracts.map(async (contractType) => {
      const approval = {
        user_id: userId,
        user_name: String(body.user_name || ""),
        order_id: orderId,
        contract_type: contractType,
        version: String(body.version || "v2.2"),
        order_amount: Number.isFinite(Number(body.order_amount)) ? Number(body.order_amount) : null,
        product_summary: String(body.product_summary || ""),
        ip_address: ip,
        approved_at: serverApprovedAt
      };
      const ref = await db.collection("user_contract_approvals").add(approval);
      return { id: ref.id, ...approval, approved_at: approvedAt };
    }));
    return res.status(201).json({ status: "success", approvals });
  } catch (error) {
    console.error("Contract approval logging failed:", error);
    return res.status(500).json({ status: "error", message: "Sözleşme onayları kaydedilemedi." });
  }
});

exports.releasePendingCommissionsCron = functions
  .region("europe-west1")
  .pubsub.schedule("5 0 * * *")
  .timeZone("Europe/Istanbul")
  .onRun(async (context) => {
    const now = admin.firestore.Timestamp.now();

    const pendingQuery = await db
      .collection("commission_logs")
      .where("status", "==", "PENDING_14D")
      .where("release_at", "<=", now)
      .get();

    if (pendingQuery.empty) {
      console.log("Serbest bırakılacak bekleyen komisyon bulunamadı (0 kayıt).");
      return null;
    }

    const releaseResults = await Promise.all(pendingQuery.docs.map((commissionDoc) =>
      db.runTransaction(async (transaction) => {
        const currentLog = await transaction.get(commissionDoc.ref);
        if (!currentLog.exists) return false;
        const data = currentLog.data() || {};
        const releaseAt = data.release_at?.toDate ? data.release_at.toDate().getTime() : NaN;
        const amount = Number(data.amount);
        if (data.status !== "PENDING_14D" || !Number.isFinite(releaseAt) || releaseAt > now.toMillis() || !data.target_user_id || amount <= 0) {
          return false;
        }

        const region = data.region === "INTERNATIONAL" ? "INTERNATIONAL" : "DOMESTIC";
        const walletRef = db.collection("wallets").doc(data.target_user_id);
        const walletDoc = await transaction.get(walletRef);
        const wallet = walletDoc.exists ? walletDoc.data() || {} : {};
        const pendingKey = regionPendingKey(region);
        const pendingBalance = Number(wallet[pendingKey] || 0);
        if (pendingBalance + 0.005 < amount) return false;

        transaction.set(walletRef, {
          [pendingKey]: admin.firestore.FieldValue.increment(-amount),
          [regionWalletKey(region)]: admin.firestore.FieldValue.increment(amount),
          updated_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        transaction.update(commissionDoc.ref, {
          status: "RELEASED",
          released_at: admin.firestore.FieldValue.serverTimestamp()
        });
        return true;
      })
    ));
    const releasedCount = releaseResults.filter(Boolean).length;
    console.log(`14 Günlük cayma süresi dolan ${releasedCount} adet komisyon serbest bırakıldı.`);
    return null;
  });
