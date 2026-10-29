# AKN Global Group: Monoline MLM ve E-Ticaret Sistem Raporu

Bu doküman mevcut kod tabanındaki davranışı anlatır.

## 1. Sistem Mimarisi

- **Ana sunucu:** `server.ts` Express API'sini, sipariş akışını, cüzdanları ve admin/bayi uçlarını çalıştırır.
- **Ortak motor:** Komisyon ve kariyer kuralları `src/engines/commissionEngine.ts` içinde tanımlıdır (`COMMISSION_RULES`, `INTERNATIONAL_CAREER_MULTIPLIER = 3`). `functions/commissionEngine.cjs` aynı kuralları Cloud Functions tarafına taşır.
- **Bölge ve cüzdan:** `src/utils/walletRegion.ts` ülke kodundan `DOMESTIC` veya `INTERNATIONAL` bölgesini belirler. Cüzdanlar bölgeye göre ayrılır (`wallet_domestic_usd`, `wallet_international_usd`).
- **Hibrit çalışma modeli:** Sipariş komisyonları anlık işlenir. Kariyer yeniden hesabı ve süre kontrolleri periyodik çalışır: `/api/v1/cron/career-trigger` (`NIGHTLY_CRON`) ve 30 saniyede bir çalışan arka plan döngüsü (`server.ts` ~9032).
- **Firebase Admin + ADC:** `initOptionalFirebaseAdmin()` (`server.ts` ~3612) Application Default Credentials ile bağlanmayı dener. ADC yoksa sunucu bellek içi modda çalışır. Doküman modülü ADC gerektirir; yoksa 503 döner.

## 2. Bayilik, Aktiflik ve Stacking

- **Sponsor bağı:** Üye `sponsor_id` ile ağa bağlanır. Yukarı zincir sponsor yürüyüşüyle çıkarılır.
- **Aktiflik süresi:** Paket alımı veya `RENEW_PACKAGE` ile aktiflik 30 gün uzar. Aktif süre varken yapılan ikinci alım, mevcut bitiş tarihine yeni 30 günü ekler; aylık sınır yoktur (`e2e_system_test.js` ~665-676).
- **Pasiflik:** `is_active = false` veya hesap kilitliyse ilgili derinlik payı ödenmez ve `unclaimed_pool_balance` hesabına aktarılır (`server.ts` ~1704).

## 3. Komisyon Havuzu ve Dağıtım

| Kalem | Oran |
|---|---|
| Doğrudan sponsor komisyonu | %20 |
| Monoline derinlik oranları (1-7) | %7, %5, %4, %3, %2, %2, %2 (toplam %25) |
| Sistem havuzu | %5 |

- **Derinlik yetkisi:** Üyenin `active_career_level` değeri ilgili derinlik için yetersizse o pay ödenmez.
- **Dinamik sıkıştırma:** Uygun olmayan üyenin payı, sponsor zincirinde bir üstteki uygun aktif liderlere aktarılır. Mod `dynamic_compression_mode` ile seçilir: `FULL_COMPRESSION` (varsayılan), `HYBRID_50_50` veya `FUND_SWEEP` (`server.ts` ~1415-1561). Atlanan üyeler `compressed_skipped_members` alanında tutulur.

**Dağıtım kuralı:** Sipariş tutarının %50'si doğrudan sponsor (%20), monoline derinlikleri (%25) ve sistem havuzuna (%5) dağıtılır. Derinlik yetkisizliğinden doğan devir tutarları (`unclaimedAmount`) sistem havuzuna eklenir. Kalan %50, açık bir ledger kaydı tutulmadan şirket gelir/marj havuzunda kalır; ürün maliyeti, kargo, KDV ve operasyon giderleri bu paydan karşılanır. Bu tutar bir cüzdana veya komisyon kaydına yazılmaz.

## 4. Kariyer, Derinlik ve 3x Yurt Dışı Çarpanı

- **İki ayrı seviye:**
  - `active_career_level`: Dönemsel hak ediş yetkisi, son 30 günlük performansa göre hesaplanır.
  - `max_career_level`: Üyenin ulaştığı en yüksek seviye; profilde kalır (`server.ts` ~519-637, ~1037-1048).
- **Kalıcı taban (Permanence):** `max_career_level` yalnızca `Math.max` ile yükselir, düşmez (`e2e_system_test.js` ~459-464).
- **3x yurt dışı çarpanı:** Bölge `INTERNATIONAL` ise `personal`, `directs` ve `group` eşikleri `INTERNATIONAL_CAREER_MULTIPLIER` ile çarpılır (`src/engines/commissionEngine.ts` ~89-96). Bu isim `getCareerMultiplier` değildir.
- **Yurt dışı paket fiyatı:** `getPackagePriceForRegion()` yurt dışı paket fiyatını 3x hesaplar. Bayi kaydı ülkeye göre bu fiyatı uygular.

## 5. Finansal Akış, Çekim ve Vergi

- **Olgunlaşma (14 gün):** Komisyonlar `PENDING_14D` olarak yazılır ve süre dolunca bakiyeye aktarılır (`server.ts` ~352, ~1471, ~9032).
- **IBAN doğrulaması:** TR IBAN için `^TR\d{24}$` formatı ve ISO 7064 Mod-97 kontrolü yapılır. Uluslararası IBAN için genel format ve aynı checksum uygulanır (`src/utils/withdrawalPayout.ts` ~7-25).
- **Çekim talebi:** Bakiye düşülerek `PENDING` kaydı oluşturulur. Yurt içi `TR_IBAN`, yurt dışı `SWIFT` veya `SEPA` kanalını kullanır.
- **Çekim reddi (kabul edilen kural):** Reddedilen çekimde brüt tutar tamamen bölgesel cüzdana iade edilir; stopaj uygulanmaz. `getRejectedWithdrawalRefund()` `taxDeduction: 0` döner (`src/utils/withdrawalPayout.ts` ~38-44). Admin reddi `server.ts` ~4325-4349 içinde işlenir. E2E testleri bu davranışı doğrular (`e2e_system_test.js` ~514-563).
- **Vergi iadesi faturası:** %20 stopaj mantığı ayrı bir vergi iadesi faturası akışında geçer (`server.ts` ~7725-7849). Onaylanmış (`APPROVED_CREDITED`) fatura için ikinci kez düşüm yapılmaz. Bekleyen fatura, çekim reddedilince `REJECTED` olur.
- **Uyum ayrımı:** Şahıs bayi için %20 stopaj, vergi mükellefi şirket için %0 stopaj uygulanır (`server.ts` ~6913-6942).

## 6. Test ve Doğrulama

- Kullanıcı bildirimine göre E2E testleri 16/16 geçmektedir.
- Doküman modülü (Firebase Storage + `documents` koleksiyonu) henüz uçtan uca test edilmedi; ADC olmadan yükleme çalışmaz.
- Canlı geçiş öncesinde Firebase Admin ADC, Storage bucket erişimi ve Firestore kuralları doğrulanmalıdır.
