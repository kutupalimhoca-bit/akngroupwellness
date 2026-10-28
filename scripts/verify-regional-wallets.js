// Kullanım: GOOGLE_APPLICATION_CREDENTIALS=<service-account.json> node scripts/verify-regional-wallets.js [--log]
// Salt okunur: Firestore `wallets` koleksiyonundaki bölgesel USD alanlarını raporlar, hiçbir bakiyeye yazmaz.
const admin = require("../functions/node_modules/firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const REGIONAL_KEYS = [
  "wallet_domestic_usd",
  "wallet_international_usd",
  "pending_domestic_usd",
  "pending_international_usd",
];

const num = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const round = (n) => Math.round(n * 100) / 100;

const main = async () => {
  const snapshot = await db.collection("wallets").get();
  const report = { checked: 0, negative: [], invalid: [], totals: {} };
  REGIONAL_KEYS.forEach((key) => (report.totals[key] = 0));

  for (const doc of snapshot.docs) {
    report.checked += 1;
    const data = doc.data();

    for (const key of REGIONAL_KEYS) {
      const raw = data[key];
      if (raw !== undefined && typeof raw !== "number") {
        report.invalid.push({ user_id: doc.id, field: key, value: raw });
      }
      const value = num(raw);
      report.totals[key] += value;
      if (value < 0) report.negative.push({ user_id: doc.id, field: key, value });
    }
  }

  for (const key of REGIONAL_KEYS) report.totals[key] = round(report.totals[key]);

  console.log(JSON.stringify(report, null, 2));

  if (process.argv.includes("--log")) {
    await db.collection("migration_logs").add({
      type: "REGIONAL_WALLET_VERIFY",
      checked: report.checked,
      negativeCount: report.negative.length,
      invalidCount: report.invalid.length,
      totals: report.totals,
      created_at: new Date().toISOString(),
    });
  }

  if (report.negative.length > 0 || report.invalid.length > 0) process.exitCode = 2;
};

main().catch((err) => {
  console.error("Doğrulama başarısız:", err.message);
  process.exit(1);
});
