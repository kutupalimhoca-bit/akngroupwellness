# Finansal Akışlarda Tespit Edilen Sorunlar ve Eksiklikler

**Kapsam:** Bu rapor, akıllı muhasebe teknik raporu hazırlanırken incelenen kaynak koda dayanır. Kod değiştirilmedi ve test çalıştırılmadı. Bulguların üretimdeki etkisi, özellikle `server.ts` Express sunucusunun ayrıca yayımlanıp yayımlanmadığına bağlıdır: `firebase.json` bazı yolları Cloud Functions’a yönlendiriyor; tüm Express rotalarının üretimde erişilebilir olduğu doğrulanamadı.

## 1. Yüksek öncelikli bulgular

### 1.1 Bazı finansal API’lerde yetkilendirme kontrolü görünmüyor

`server.ts` içinde aşağıdaki rotalarda kimlik doğrulama middleware’i görünmüyor:

- `/api/v1/integrations/sync-frekans-data` — istek gövdesindeki siparişleri işleyebiliyor; ayrıca `resetBeforeSync` ile sunucudaki finansal state’i sıfırlayabiliyor (`server.ts:5075–5086, 5248–5266`).
- `/api/v1/members/:userId/release-pending` — URL’de verilen üyenin bekleyen komisyonlarını serbest bırakabiliyor (`server.ts:729–735`).
- `/api/v1/integrations/order-refund` — verilen siparişe ait komisyon ve cüzdan kayıtlarını değiştirebiliyor (`server.ts:6844–6877`).
- `/api/v1/p2p/transfer`, `/p2p/create-voucher`, `/p2p/redeem-voucher` — kullanıcı kimliklerini istek gövdesinden alıyor; çağıranın bu hesaplara ait olup olmadığını doğrulamıyor (`server.ts:7446–7728`).
- `/api/v1/admin/reset-metrics` — finansal metrikleri ve cüzdanları sıfırlayabiliyor; rotada admin middleware’i görünmüyor (`server.ts:7021–7053`).
- `/api/v1/settings/depth-lock`, `/api/v1/members/:userId/boost-career`, `/api/v1/members/:userId/sync-credits` — finansal uygunluk veya kullanıcı verilerini değiştirebiliyor; ilgili rotalarda auth kontrolü görünmüyor.

**Olası etki:** Express servisi dışarıya açıksa bu uçlar komisyon, cüzdan, sipariş veya metrik kayıtlarının yetkisiz değiştirilmesine yol açabilir. Bu, gerçek banka transferi veya ödeme iadesi yapıldığı anlamına gelmiyor; bu incelemede söz konusu sağlayıcı çağrıları doğrulanmadı.

### 1.2 `/api/v1/state` hassas verileri auth kontrolü olmadan döndürüyor

`server.ts:3862–3864` içindeki `/api/v1/state`, `buildStateResponse()` sonucunu doğrudan döndürüyor. Response tüm üyeleri, cüzdanları, çekim taleplerini, faturaları ve logları içeriyor (`server.ts:3393–3492`). Üye modelinde IBAN, vergi numarası ve 2FA secret/backup code alanları bulunabiliyor (`src/types/monoline.ts:1082–1167`).

**Olası etki:** Express endpoint’i erişilebilir ise kişisel ve finansal veriler açığa çıkabilir. Admin raporlama ekranları açısından da state’in kullanıcı rolüne göre filtrelenmesi ve hassas alanların maskelenmesi gerekir.

### 1.3 TRY/USD hesaplamaları backend’ler arasında tutarlı değil

- `server.ts:711–718`, yurtiçi komisyon tutarını USD cüzdanına yazmadan önce `usdTryRate` değerine bölüyor.
- `functions/index.js:523–532` benzer kredi tutarını dönüştürmeden pending wallet’a ekliyor; `functions/index.js:551–553` kaydı USD olarak işaretliyor.
- `firebase.json:30–32`, `/api/v1/integrations/order-commission` yolunu Cloud Function’a yönlendiriyor; `server.ts` de aynı endpoint’i ayrıca tanımlıyor.

**Olası etki:** Aynı sipariş, hangi backend tarafından işlendiğine göre farklı USD bakiyesi üretebilir. Paket fiyatlarının USD olarak gösterilmesi ve bölgesel fiyat katsayıları (`src/utils/walletRegion.ts:21–32`) bu birim belirsizliğini gidermiyor.

### 1.4 TRY olarak işaretlenen çekimde brüt/net alanları kurla çevrilmeden kaydediliyor

Çekim sırasında brüt, vergi ve net tutar aynı ham değer üzerinden hesaplanıyor (`server.ts:4212–4218`). Vergi kesintisinin TRY karşılığı ayrıca hesaplanıyor; ancak kaydedilen brüt ve net alanları da `currency: 'TRY'` ile sunulabiliyor (`server.ts:4287–4300`). Admin CSV’sindeki başlıklar TL olsa da değerler kur dönüşümü olmadan yazılıyor (`server.ts:2144–2159`).

**Olası etki:** Rapor veya dışarıdaki süreç bu alanları gerçekten TL kabul ederse brüt/net tutarlar yanlış olur. Çekimden önce başka bir yerde çevrim yapılıp yapılmadığı repo içinde doğrulanamadı.

### 1.5 Şirket vergi durumuna göre oran uygulanmıyor

Çekim oluşturma ve reddetme akışlarında backend `%20` kesinti uyguluyor (`server.ts:4212–4215, 4426–4431`). Üyenin `has_tax_company` alanı oran hesabına katılmıyor. Buna karşılık arayüzde şirketi ve fatura mükellefiyeti olan bayiler için `%0` ifadesi ve hesaplama varsayımları bulunuyor (`src/components/CommissionEngineView.tsx:1985–1991, 2145–2149`).

**Olası etki:** Arayüzün gösterdiği tutar ile backend’in cüzdana uyguladığı kesinti farklılaşabilir. Doğru oran hukuki/finansal ekip tarafından onaylanmalı; bu bulgu yalnızca kod içindeki tutarsızlığı gösteriyor.

### 1.6 Firebase Hosting ödeme akışı ile komisyon kaydı arasında bağlantı eksik olabilir

Hosting konfigürasyonu ödeme callback’lerini ve Cloud Function sipariş/komisyon endpoint’ini yönlendiriyor (`firebase.json:16–70`). Cloud Function ödeme kaydını `SUCCEEDED` yapıyor; sipariş, wallet ve komisyon kayıtları ise ayrı `handleOrderCommission` akışında oluşturuluyor (`functions/index.js:950–980, 803–839`).

İstemci ödeme sonrasında `recordMemberOrder()` ile siparişi yerel kayıt katmanına yazıyor (`src/components/PaymentModal.tsx:306–364`, `src/utils/authManager.ts:1667–1709`). Monoline köprüsü `/api/v1/integrations/sync-frekans-data` kullanıyor (`src/utils/monolineSyncBridge.ts:549–570`), ancak bu yol mevcut Firebase Hosting rewrite listesinde yok.

**Olası etki:** Hosting-only dağıtımında ödeme başarılı görünürken aynı işlem için kalıcı Monoline sipariş/komisyon kaydının oluştuğu garanti edilmiyor. Ayrı Express proxy veya dağıtım varsa sonuç değişebilir; repo bunu doğrulamıyor.

### 1.7 Finans verisi birden fazla kaynakta tutuluyor

`server.ts` finans state’inin önemli bölümünü proses belleğinde tutuyor (`server.ts:149–254`); Cloud Functions Firestore kullanıyor (`functions/index.js:2–10`); istemci Firebase katmanı localStorage tabanlı (`src/lib/firebase.ts:2–5, 82–118`). Bu kaynakların aynı veriyi aynı anda otoritatif ve tutarlı tuttuğu görünmüyor.

**Olası etki:** Sunucu yeniden başlatma, çoklu instance, yerel senkronizasyon veya restore sonrasında bakiye ve işlem raporları farklılaşabilir. `runInAtomicTransaction` yalnızca aynı proses içindeki işlemleri sıraya koyuyor; kalıcı veri tabanı transaction’ı değil (`server.ts:149–155`).

## 2. Orta öncelikli finansal ve raporlama bulguları

### 2.1 İade edilen sipariş bazı toplam göstergelerden çıkarılmıyor

Refund işlemi siparişi `REFUNDED` olarak işaretliyor (`server.ts:6801–6811`). Ancak `total_order_volume` siparişlerin `order_amount` alanlarını durum filtresi olmadan topluyor; bu tutar şirket kârı göstergesinde de kullanılıyor (`server.ts:3393–3397, 3420–3425`).

Ayrıca rolling 30 günlük hacim hesabı, aktif üyede kümülatif `personal_volume` değerini taban olarak kullanabiliyor (`server.ts:474–487`). Refund sırasında rolling hacimden çıkarılan bir sipariş bu nedenle bazı türetilmiş hacim/kariyer değerlerini etkilemeye devam edebilir.

### 2.2 Clawback negatif bakiye oluşturabiliyor; raporlanan kazanç bunu tam göstermiyor

Daha önce serbest bırakılmış komisyon iadesi çekilebilir wallet’tan düşülürken bakiye sıfırda sınırlandırılmıyor (`server.ts:6750–6768`). Buna karşılık bazı komisyon sayaçları sıfırın altına düşürülmüyor; sistem fonunda da eksik tutar negatife yazılmak yerine sıfırda kesilebiliyor (`server.ts:6763–6798`).

**Olası etki:** Gerçek bölgesel wallet negatifken özet kazanç veya fon göstergeleri bu borcu yansıtmayabilir. Ayrı bir tahsilat/mahsuplaşma kaydı görünmüyor.

### 2.3 Komisyon toplamları toplanırsa aynı tutar iki kez sayılabilir

Bonus türlerine göre aynı tutar birden fazla cüzdan alanına ekleniyor: Infinity hem `infinity_wallet` hem `monoline_wallet`; Matching hem `matching_wallet` hem `career_pool_wallet`; Fast-ROI hem `fast_roi_wallet` hem `sponsor_wallet` alanında görünebiliyor (`server.ts:821–844`). Dashboard bu alanların bazılarını ayrı toplamlar olarak sunuyor (`server.ts:3399–3418`).

Bu alanlar alt kategori ve toplam kategori olarak tasarlanmış olabilir. Ancak birbirinden bağımsız tutarlar gibi toplanırlarsa rapor şişer.

### 2.4 Sistem fonu göstergeleri aynı kapsamı temsil etmeyebilir

`system_pool_balance` ve `systemCareerFundBalance` farklı akışlarda farklı kapsamda güncelleniyor. Express’te sipariş sırasında biri temel fonu, diğeri devredilen tutarları içerebiliyor; havuz dağıtımında bazı gösterge alanları güncellenmeyebiliyor (`server.ts:1420–1435, 1935–1941, 6478–6481`). Cloud Function tarafındaki güncelleme de bu alanları aynı şekilde kullanmıyor (`functions/index.js:790–835`).

**Olası etki:** Admin panelindeki fon rakamları ile dağıtılabilir gerçek tutar birbirini tutmayabilir. Önce her alanın iş anlamı ve para birimi tanımlanmalı.

### 2.5 Çekim onayı ve fatura kaydı gerçek dış ödeme/elektronik fatura kanıtı değil

Çekim onay akışı durumu güncelliyor; banka payout API’si çağrısı görünmüyor (`server.ts:4416–4424`). Refund akışı iç komisyon kayıtlarını değiştiriyor; ödeme sağlayıcısı üzerinden para iadesi yapmıyor. Dijital fatura oluşturma istemci tarafındaki yerel veri katmanını kullanıyor (`src/utils/invoiceManager.ts:314–342, 427–547`).

**Olası etki:** “Onaylandı”, “iade edildi” veya “fatura oluşturuldu” durumları gerçek banka settlement’ı, kart iadesi veya resmî e-Fatura işlemiyle aynı kabul edilmemeli.

## 3. Üretim erişilebilirliği notu

`firebase.json` yalnızca belirli API yollarını Cloud Functions’a yönlendiriyor. Bu raporda belirtilen Express uçlarının önemli bir kısmı için rewrite görünmüyor. Ayrı Express sunucusu veya proxy varsa bulgular erişilebilir olabilir; yoksa Firebase Hosting bu Express rotalarını API olarak sunmuyor olabilir. Bu yüzden **öncelikle gerçek üretim deployment’ının hangi API sunucusunu kullandığı doğrulanmalı.**

## 4. Önerilen düzeltme sırası

1. Üretimde kullanılan backend ve veri kaynağını belirleyin; `server.ts`, Cloud Functions ve istemci-local state arasında otoriteyi netleştirin.
2. Finansal API’lere sunucu tarafında rol ve hesap sahipliği doğrulaması ekleyin; özellikle state, refund, sync/reset, release-pending, P2P ve voucher yollarını denetleyin.
3. TRY/USD için tek bir kural belirleyin; işlem tarihindeki kur, kaynak para birimi ve hedef para birimini kayıtla birlikte saklayın.
4. Çekim, vergi, şirket mükellefiyeti ve refund kurallarını finans ekibiyle onaylayıp aynı kuralları arayüz ve backend’de uygulayın.
5. Sipariş–ödeme–komisyon akışını kalıcı ve idempotent hale getirin; ödeme başarılı olmadan pending siparişin komisyon üretmesini engelleyin.
6. İade sonrası hacim, komisyon, sistem fonu ve kâr metriklerinin tamamını aynı iş kuralıyla yeniden hesaplayın.
7. Tüm cüzdan hareketlerini tek, izlenebilir muhasebe hareketi/ledger modeline bağlayın; gerçek banka settlement’ını iç durum değişikliğinden ayrı kaydedin.

## Sonuç

İlk ele alınması gereken konular finansal API yetkilendirmesi, hassas state’in korunması, ödeme–sipariş bağlantısı ve TRY/USD tutarsızlıklarıdır. Muhasebe modülü bu başlıklar çözülmeden mevcut bakiyeleri doğrudan kesin muhasebe kaydı olarak kullanmamalıdır.
