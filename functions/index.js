const functions = require("firebase-functions");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const { randomBytes } = require("crypto");

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

// V2.2 Komisyon Oranları ve Seviye Tanımları
const COMMISSION_CONFIG = {
  DIRECT_SPONSOR_RATE: 0.20,
  FAST_ROI_RATE: 0.15,
  MONOLINE_DEPTH_RATES: [0.07, 0.05, 0.04, 0.03, 0.02, 0.02, 0.02],
  UNILEVEL_INFINITY_CAP: 0.10,
  SYSTEM_POOL_RATE: 0.05,
  CLAWBACK_DAYS: 14,
  COMPRESSION_MODE: "FULL_COMPRESSION",
  ENFORCE_CAREER_DEPTH_LOCK: true
};
const CAREER_RULES = [
  { level: 1, title: "Emmâre", personal: 0, directs: 0, group: 0, maxLegPercent: 100, withdrawalLimit: 5000, requirements: [] },
  { level: 2, title: "Levvâme", personal: 1000, directs: 10, group: 2000, maxLegPercent: 100, withdrawalLimit: 10000, requirements: [] },
  { level: 3, title: "Mülhime", personal: 3000, directs: 20, group: 5000, maxLegPercent: 100, withdrawalLimit: 20000, requirements: [] },
  { level: 4, title: "Mutmainne", personal: 7500, directs: 50, group: 10000, maxLegPercent: 50, withdrawalLimit: 35000, requirements: [[2, 1]] },
  { level: 5, title: "Râziye", personal: 15000, directs: 100, group: 50000, maxLegPercent: 50, withdrawalLimit: 50000, requirements: [[3, 2]] },
  { level: 6, title: "Marziyye", personal: 25000, directs: 500, group: 350000, maxLegPercent: 50, withdrawalLimit: 75000, requirements: [[4, 2], [3, 1]] },
  { level: 7, title: "Kâmile", personal: 50000, directs: 1000, group: 1000000, maxLegPercent: 50, withdrawalLimit: 100000, requirements: [[5, 2], [4, 2]] }
];
const CAREER_REWARDS = {
  2: { title: "Levvâme", description: "2. Kariyer (Levvâme) Gümüş Liderlik Rozeti & Başlangıç Nakit Ödülü", cash_value: 1500 },
  3: { title: "Mülhime", description: "3. Kariyer (Mülhime) Altın Yaka Rozeti & Tek Seferlik Kariyer Nakit Ödülü", cash_value: 4000 },
  4: { title: "Mutmainne", description: "4. Kariyer (Mutmainne) Özel Tasarım Kol Saati + Nakit Kariyer Ödülü", cash_value: 10000 },
  5: { title: "Râziye", description: "5. Kariyer (Râziye) Amiral Gemisi Akıllı Telefon / Tablet + Liderlik Ödülü", cash_value: 25000 },
  6: { title: "Marziyye", description: "6. Kariyer (Mardiyye) VIP Liderlik Tatili + Kurumsal Ofis Desteği", cash_value: 50000 },
  7: { title: "Kâmile", description: "7. Kariyer (Sâfiye) Lüks Araç Katkı Fonu & Elmas Liderlik Ödülü", cash_value: 125000 }
};
const INFINITY_PERCENT_BY_CAREER = [0, 0, 0, 0, 2, 4, 7, 10];
const MATCHING_PERCENT_BY_CAREER = [0, 0, 0, 10, 15, 20, 25, 25];
const roundCurrency = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const careerLevelOf = (member) => Number(member.active_career_level ?? member.career_level ?? 1);
const careerTitleOf = (member) => member.active_career_title ?? member.career_title ?? CAREER_RULES[0].title;

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
      const personalOk = activityValid && (tier.level === 1 || personalVolume >= tier.personal);
      const directsOk = activeDirects >= tier.directs;
      const maxSingleLeg = tier.group > 0 ? (tier.group * tier.maxLegPercent) / 100 : Infinity;
      const cappedGroup = tier.maxLegPercent < 100
        ? legs.reduce((sum, leg) => sum + Math.min(leg.volume, maxSingleLeg), 0)
        : groupVolume;
      const groupOk = cappedGroup >= tier.group;
      const usedLegs = new Set();
      let downlineOk = true;
      for (const [requiredCareer, requiredCount] of tier.requirements) {
        let matched = 0;
        for (const leg of legs) {
          if (usedLegs.has(leg.rootId) || leg.maxCareer < requiredCareer) continue;
          usedLegs.add(leg.rootId);
          matched++;
          if (matched >= requiredCount) break;
        }
        if (matched < requiredCount) downlineOk = false;
      }
      if (chainAlive && (tier.level === 1 || (personalOk && directsOk && groupOk && downlineOk))) {
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

function getCareerAncestors(member, byUserId, byDocId, byDbId) {
  const ancestors = [];
  const visited = new Set([member.user_id]);
  let cursor = member;
  while (cursor) {
    const parent = byUserId.get(String(cursor.sponsor_id)) || byDocId.get(String(cursor.sponsor_id)) || byDbId.get(String(cursor.sponsor_db_id));
    if (!parent || visited.has(parent.user_id)) break;
    visited.add(parent.user_id);
    ancestors.push(parent);
    cursor = parent;
  }
  return ancestors;
}

/**
 * Webhook HTTP Endpoint (Sanal POS veya Dış Sistem Tetiklemesi)
 * POST /api/v1/integrations/order-commission
 */
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
        const usersQuery = db.collection("users");
        const nowMs = admin.firestore.Timestamp.now().toMillis();
        const recentCutoffMs = nowMs - 30 * 86400000;
        const ordersTimestampQuery = db.collection("orders_log").where(
          "created_at", ">=", admin.firestore.Timestamp.fromDate(new Date(recentCutoffMs))
        );
        const ordersIsoQuery = db.collection("orders_log").where(
          "created_at", ">=", new Date(recentCutoffMs).toISOString()
        );

        const [paymentDoc, approvalDocs, buyerDoc, usersSnap, ordersTimestampSnap, ordersIsoSnap] = await Promise.all([
          transaction.get(paymentRef),
          transaction.get(approvalQuery),
          transaction.get(buyerRef),
          transaction.get(usersQuery),
          transaction.get(ordersTimestampQuery),
          transaction.get(ordersIsoQuery)
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
        const users = usersSnap.docs.map((doc) => {
          const data = doc.data() || {};
          return { ...data, __doc_id: doc.id, user_id: data.user_id || doc.id };
        });
        const byUserId = new Map(users.map((member) => [String(member.user_id), member]));
        const byDocId = new Map(users.map((member) => [String(member.__doc_id), member]));
        const byDbId = new Map(users.filter((member) => member.id !== undefined).map((member) => [String(member.id), member]));
        const buyerMember = byDocId.get(user_id) || byUserId.get(String(user_id));
        if (!buyerMember) throw new Error(`Kullanıcı (${user_id}) users koleksiyonunda bulunamadı.`);
        const sponsorId = buyerData.sponsor_id;
        const sponsor = sponsorId ? (byUserId.get(String(sponsorId)) || byDocId.get(String(sponsorId))) : null;

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

        const recentOrderTotals = new Map();
        const recentOrderDocs = new Map();
        [...ordersTimestampSnap.docs, ...ordersIsoSnap.docs].forEach((orderDoc) => recentOrderDocs.set(orderDoc.id, orderDoc));
        recentOrderDocs.forEach((orderDoc) => {
          const order = orderDoc.data() || {};
          const createdAtMs = toMillis(order.created_at);
          const status = String(order.status || "COMPLETED").toUpperCase();
          if (
            !order.user_id || !Number.isFinite(createdAtMs) || createdAtMs < recentCutoffMs || createdAtMs > nowMs ||
            status === "CANCELLED" || status === "CANCELED" || status === "REFUNDED" || status === "FAILED"
          ) return;
          const memberId = String(order.user_id);
          recentOrderTotals.set(memberId, roundCurrency(
            (recentOrderTotals.get(memberId) || 0) + Number(order.order_amount ?? order.amount ?? 0)
          ));
        });
        recentOrderTotals.set(String(user_id), roundCurrency((recentOrderTotals.get(String(user_id)) || 0) + amount));

        const previousMaxCareer = new Map(users.map((member) => [
          String(member.user_id), Number(member.max_career_level || member.career_level || 1)
        ]));
        const careerProfileFields = [
          "personal_volume_30d", "rolling_30d_personal_volume", "rolling_30d_pgv", "group_volume_30d",
          "max_career_level", "max_career_title", "career_level", "career_title",
          "active_career_level", "active_career_title", "active_direct_referrals",
          "active_direct_referrals_30d", "unlocked_depth", "monoline_position",
          "daily_withdrawal_limit", "pool_leadership_points", "fast_start_awarded"
        ];
        const originalCareerProfiles = new Map(users.map((member) => [
          member.__doc_id,
          Object.fromEntries(careerProfileFields.map((field) => [field, member[field]]))
        ]));
        recalculateCareerProfiles(users, recentOrderTotals, nowMs);

        const rewardCandidates = users.filter((member) =>
          Number(member.max_career_level || 1) > (previousMaxCareer.get(String(member.user_id)) || 1)
        );
        const rewardEntries = [];
        rewardCandidates.forEach((member) => {
          const priorLevel = previousMaxCareer.get(String(member.user_id)) || 1;
          const nextLevel = Number(member.max_career_level || 1);
          for (let level = Math.max(2, priorLevel + 1); level <= nextLevel; level++) {
            const rewardDef = CAREER_REWARDS[level];
            if (!rewardDef) continue;
            rewardEntries.push({
              member,
              level,
              ref: db.collection("user_rewards_log").doc(`${encodeURIComponent(String(member.user_id))}-RANK-${level}`),
              rewardDef
            });
          }
        });
        let fastStartAward = null;
        if (sponsor && !sponsor.fast_start_awarded) {
          const qualifyingDirects = users
            .filter((member) => member.sponsor_id === sponsor.user_id || String(member.sponsor_db_id) === String(sponsor.id ?? sponsor.__doc_id))
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
        const [rewardSnapshots, fastStartSnapshot] = await Promise.all([
          Promise.all(rewardEntries.map(({ ref }) => transaction.get(ref))),
          fastStartAward ? transaction.get(fastStartAward.ref) : Promise.resolve(null)
        ]);
        const newRewards = rewardEntries.flatMap((entry, index) => {
          if (rewardSnapshots[index].exists) return [];
          const { member, level, ref, rewardDef } = entry;
          return [{
            ref,
            data: {
              id: Number.parseInt(randomBytes(6).toString("hex"), 16),
              user_id: member.id ?? member.__doc_id,
              external_user_id: member.user_id,
              user_full_name: member.full_name || "",
              career_level: level,
              career_title: CAREER_RULES[level - 1]?.title || rewardDef.title,
              reward_type: "RANK_UP_GIFT",
              reward_description: rewardDef.description,
              cash_value: rewardDef.cash_value,
              is_delivered: false,
              earned_at: serverTimestamp
            }
          }];
        });
        if (fastStartAward && fastStartSnapshot && !fastStartSnapshot.exists) {
          newRewards.push({ ref: fastStartAward.ref, data: fastStartAward.data });
        }

        const commissionLogs = [];
        const walletCredits = new Map();
        const earningsByMonolineMember = new Map();
        const monolinePayouts = [];
        let unclaimedAmount = 0;
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

        // Sponsor: %20 yalnızca aktif ve kilitsiz sponsora; aksi durumda devir havuzuna.
        const directSponsorAmount = roundCurrency(amount * COMMISSION_CONFIG.DIRECT_SPONSOR_RATE);
        let directSponsorPaid = 0;
        if (directSponsorAmount > 0 && sponsor && sponsor.is_active === true && !sponsor.is_locked) {
          directSponsorPaid = directSponsorAmount;
          addWalletCredit(sponsor, "sponsor_wallet", directSponsorPaid);
          addCommissionLog(user_id, sponsor.__doc_id, "SPONSOR", directSponsorPaid, COMMISSION_CONFIG.DIRECT_SPONSOR_RATE * 100, null);
        } else if (directSponsorAmount > 0) {
          unclaimedAmount = roundCurrency(unclaimedAmount + directSponsorAmount);
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

        const buyerLineId = Number(buyerData.global_line_id || Number.MAX_SAFE_INTEGER);
        const uplineCandidates = users
          .filter((member) => Number(member.global_line_id) < buyerLineId)
          .sort((a, b) => Number(b.global_line_id) - Number(a.global_line_id));
        const compressionMode = COMMISSION_CONFIG.COMPRESSION_MODE;
        const useDynamicCompression = compressionMode !== "FUND_SWEEP";
        let candidateCursor = 0;
        for (let depth = 1; depth <= COMMISSION_CONFIG.MONOLINE_DEPTH_RATES.length; depth++) {
          const rate = COMMISSION_CONFIG.MONOLINE_DEPTH_RATES[depth - 1];
          const rawAmount = roundCurrency(amount * rate);
          let depthAmount = rawAmount;
          let target = null;
          let skippedMember = false;

          if (useDynamicCompression) {
            while (candidateCursor < uplineCandidates.length) {
              const candidate = uplineCandidates[candidateCursor++];
              const isActive = candidate.is_active === true && !candidate.is_locked;
              const hasCareerDepth = !COMMISSION_CONFIG.ENFORCE_CAREER_DEPTH_LOCK || careerLevelOf(candidate) >= depth;
              if (isActive && hasCareerDepth) {
                target = candidate;
                break;
              }
              skippedMember = true;
            }
            if (compressionMode === "HYBRID_50_50" && skippedMember && target) {
              const toSystemPool = roundCurrency(rawAmount * 0.5);
              depthAmount = roundCurrency(rawAmount - toSystemPool);
              unclaimedAmount = roundCurrency(unclaimedAmount + toSystemPool);
            }
          } else {
            target = uplineCandidates[depth - 1] || null;
          }

          if (!target) {
            unclaimedAmount = roundCurrency(unclaimedAmount + depthAmount);
            commissionLogs.push({
              order_id: normalizedOrderId,
              source_user_id: user_id,
              target_user_id: null,
              commission_type: "MONOLINE_DEPTH",
              region: buyerRegion,
              currency: "USD",
              depth_level: depth,
              amount: depthAmount,
              rate_percent: rate * 100,
              status: "POOL_TRANSFER_NO_UPLINE",
              release_at: serverTimestamp,
              created_at: serverTimestamp
            });
            monolinePayouts.push({
              depth,
              rate_percent: rate * 100,
              calculated_amount: depthAmount,
              recipient_user_id: null,
              recipient_name: null,
              status: "TRANSFERRED_TO_POOL_NO_UPLINE"
            });
            continue;
          }
          const isActive = target.is_active === true && !target.is_locked;
          const hasCareerDepth = !COMMISSION_CONFIG.ENFORCE_CAREER_DEPTH_LOCK || careerLevelOf(target) >= depth;
          if (!isActive || !hasCareerDepth) {
            unclaimedAmount = roundCurrency(unclaimedAmount + depthAmount);
            commissionLogs.push({
              order_id: normalizedOrderId,
              source_user_id: user_id,
              target_user_id: target.__doc_id,
              commission_type: "MONOLINE_DEPTH",
              region: buyerRegion,
              currency: "USD",
              depth_level: depth,
              amount: depthAmount,
              rate_percent: rate * 100,
              status: !isActive ? "POOL_TRANSFER_INACTIVE" : "POOL_TRANSFER_CAREER_LOCK",
              release_at: serverTimestamp,
              created_at: serverTimestamp
            });
            monolinePayouts.push({
              depth,
              rate_percent: rate * 100,
              calculated_amount: depthAmount,
              recipient_user_id: target.user_id,
              recipient_name: target.full_name || null,
              status: !isActive ? "TRANSFERRED_TO_POOL_INACTIVE" : "TRANSFERRED_TO_POOL_CAREER_LOCK"
            });
            continue;
          }
          addWalletCredit(target, "monoline_wallet", depthAmount);
          addCommissionLog(user_id, target.__doc_id, "MONOLINE_DEPTH", depthAmount, rate * 100, depth);
          earningsByMonolineMember.set(target.user_id, roundCurrency(
            (earningsByMonolineMember.get(target.user_id) || 0) + depthAmount
          ));
          monolinePayouts.push({
            depth,
            rate_percent: rate * 100,
            calculated_amount: depthAmount,
            recipient_user_id: target.user_id,
            recipient_name: target.full_name || null,
            recipient_global_line_id: target.global_line_id,
            recipient_career_level: careerLevelOf(target),
            recipient_max_career_level: Number(target.max_career_level || target.career_level || 1),
            recipient_unlocked_depth: Number(target.unlocked_depth || careerLevelOf(target)),
            status: "PAID_TO_MEMBER"
          });
        }

        const buyerAncestors = getCareerAncestors(buyerMember, byUserId, byDocId, byDbId);
        let highestPaidInfinityPercent = 0;
        const infinityCap = Math.min(10, COMMISSION_CONFIG.UNILEVEL_INFINITY_CAP);
        buyerAncestors.forEach((ancestor, index) => {
          if (highestPaidInfinityPercent >= infinityCap) return;
          if (ancestor.is_active !== true || ancestor.is_locked) return;
          const career = careerLevelOf(ancestor);
          const memberPercent = Number(INFINITY_PERCENT_BY_CAREER[career] || 0);
          const differential = Math.min(infinityCap, memberPercent) - highestPaidInfinityPercent;
          if (differential <= 0) return;
          const infinityAmount = roundCurrency(amount * differential / 100);
          if (infinityAmount <= 0) return;
          addWalletCredit(ancestor, ["infinity_wallet", "monoline_wallet"], infinityAmount);
          addCommissionLog(user_id, ancestor.__doc_id, "UNILEVEL_INFINITY", infinityAmount, differential, index + 1);
          highestPaidInfinityPercent = roundCurrency(highestPaidInfinityPercent + differential);
        });

        // Matching yalnızca monoline derinlik ödemesi alan üyelerin doğrudan sponsoruna uygulanır.
        earningsByMonolineMember.forEach((earnerAmount, earnerUserId) => {
          if (earnerAmount <= 0) return;
          const earner = byUserId.get(String(earnerUserId));
          if (!earner) return;
          const earnerAncestors = getCareerAncestors(earner, byUserId, byDocId, byDbId);
          const matchingSponsor = earnerAncestors[0];
          if (!matchingSponsor || matchingSponsor.is_active !== true || matchingSponsor.is_locked) return;
          const matchingPercent = Number(MATCHING_PERCENT_BY_CAREER[careerLevelOf(matchingSponsor)] || 0);
          if (matchingPercent <= 0) return;
          const matchingAmount = roundCurrency(earnerAmount * matchingPercent / 100);
          if (matchingAmount <= 0) return;
          addWalletCredit(
            matchingSponsor,
            ["matching_wallet", "career_pool_wallet"],
            matchingAmount,
            resolveMemberRegion(matchingSponsor.country_code)
          );
          addCommissionLog(
            earner.__doc_id,
            matchingSponsor.__doc_id,
            "MATCHING_BONUS",
            matchingAmount,
            matchingPercent,
            1,
            resolveMemberRegion(matchingSponsor.country_code)
          );
        });

        const userUpdates = new Map();
        users.forEach((member) => {
          const original = originalCareerProfiles.get(member.__doc_id) || {};
          const profile = {};
          careerProfileFields.forEach((field) => {
            if (member[field] !== undefined && member[field] !== original[field]) profile[field] = member[field];
          });
          if (Object.keys(profile).length) {
            profile.updated_at = serverTimestamp;
            userUpdates.set(member.__doc_id, profile);
          }
        });
        const buyerPatch = userUpdates.get(user_id) || {};
        Object.assign(buyerPatch, {
          session_credits: buyerMember.session_credits,
          personal_volume: buyerMember.personal_volume,
          last_order_amount: amount,
          last_order_at: serverTimestamp,
          activity_expires_at: activityExpiresAt,
          is_active: true,
          updated_at: serverTimestamp
        });
        userUpdates.set(user_id, buyerPatch);
        const careerUpgrades = users.flatMap((member) => {
          const previous = originalCareerProfiles.get(member.__doc_id) || {};
          const previousLevel = Number(previous.active_career_level || previous.career_level || 1);
          if (Number(member.career_level || 1) <= previousLevel) return [];
          return [{
            user_id: member.user_id,
            full_name: member.full_name || "",
            old_level: previousLevel,
            old_title: previous.active_career_title || previous.career_title || CAREER_RULES[0].title,
            new_level: Number(member.career_level),
            new_title: member.career_title || CAREER_RULES[0].title
          }];
        });

        const systemFundAmount = roundCurrency(amount * COMMISSION_CONFIG.SYSTEM_POOL_RATE);
        const systemPoolInflow = roundCurrency(systemFundAmount + unclaimedAmount);
        const systemWalletRef = db.collection("wallets").doc("SYSTEM_MASTER_FUND");
        const logRefs = commissionLogs.map((log) => ({ ref: db.collection("commission_logs").doc(), data: log }));
        const writeCount = 2 + userUpdates.size + walletCredits.size + 1 + logRefs.length + newRewards.length;
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
        userUpdates.forEach((updates, docId) => {
          transaction.update(db.collection("users").doc(docId), updates);
        });
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
          careerUpgrades,
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
