# Akıllı Muhasebe Entegrasyonu İçin Teknik Devir Raporu

**Amaç:** Mevcut sisteme ileride eklenecek akıllı muhasebe modülünü geliştirecek ekibe uygulama yapısını, finansal veri kaynaklarını, mevcut akışları ve entegrasyon öncesinde karara bağlanması gereken konuları aktarmak.

> **Önemli:** Aşağıda “mevcut durum” ile “öneri” ayrı tutulmuştur. Repoda bazı SQL şeması yorumları olsa da bu incelemede çalışan bir SQL veri tabanı veya migration yapısı doğrulanmadı.

## 1. Yönetici özeti

Sistemde sipariş, komisyon, wallet, çekim, fatura ve iade süreçlerini temsil eden çok sayıda model ve ekran bulunuyor; fakat bunlar henüz tek bir muhasebe defterinde birleşmiyor.

Öne çıkan mevcut durum:

- Monoline finans akışlarının önemli bir kısmı `server.ts` içindeki proses belleğinde tutuluyor.
- Benzer sipariş ve komisyon akışları `functions/index.js` içinde ayrıca Firestore’a yazılıyor.
- Frekans/reseller tarafında tarayıcı `localStorage` ve Firestore benzeri istemci katmanı kullanılıyor.
- Sistem komisyon hareketlerini “ledger” olarak gösterebiliyor; ancak standart çift taraflı yevmiye defteri, hesap planı veya dönem kapama modeli görülmedi.
- TRY/USD birimlerinin bazı akışlardaki anlamı tutarlı şekilde belgelenmiyor.
- Çekim onayı gerçek banka transferi başlatmıyor; sipariş iadesi de gerçek ödeme sağlayıcısına para iadesi göndermiyor.
- Mevcut veriyi doğrudan muhasebe defterine yazmadan önce sipariş, komisyon, çekim ve para birimi tutarsızlıkları giderilmeli.

**Önerilen başlangıç:** Önce salt okunur muhasebe raporu ve mutabakat ekranı geliştirin. Mevcut finans akışlarına yeni otomatik muhasebe yazımları eklemeyi, tek veri kaynağı, para birimi kuralları ve idempotency netleştikten sonraya bırakın.

## 2. Mevcut teknik mimari ve veri kaynakları

### A. Express sunucusu — `server.ts`

`package.json` geliştirme ve başlatma komutlarında `server.ts` çalıştırılıyor (`package.json:6–15`). Sunucu tarafında üyeler, wallet’lar, komisyonlar, çekimler ve faturalar modül seviyesindeki dizi/değişkenlerde tutuluyor (`server.ts:149–254`). Örnekler: `members`, `transactions`, `commissionLogs`, `withdrawalRequests` ve `taxRefundInvoices`.

`runInAtomicTransaction` aynı proses içindeki işlemleri sıraya koyan bir Promise kuyruğu; kalıcı veri tabanı transaction’ı değildir (`server.ts:149–155`). Bu nedenle `server.ts` içindeki finans güncellemelerinin proses yeniden başladığında korunmasını sağlayan kalıcı bir katman bu state tanımlarında görünmüyor.

### B. Firebase Cloud Functions — `functions/index.js`

Cloud Functions tarafı `firebase-admin` ve Firestore kullanıyor (`functions/index.js:2–10`). Sipariş, wallet ve komisyon kayıtlarının bir kısmı Firestore transaction’ları ile yazılıyor:

- Sipariş/komisyon akışı: `functions/index.js:247–894`
- Komisyonların bekleyen bakiyeden çekilebilir bakiyeye aktarılması: `functions/index.js:1213–1265`
- Kullanılan koleksiyonlar arasında `users`, `wallets`, `orders_log`, `commission_logs` ve ödeme kayıtları yer alıyor.

`firebase.json:17–67` belirli istek yollarını Cloud Functions’a yönlendiriyor. Bu listedeki yollarla `server.ts` içinde tanımlanan tüm finans endpoint’lerinin aynı üretim hattında çalıştığı varsayılmamalı; deployment mimarisi ayrıca doğrulanmalı.

### C. İstemcideki Firestore benzeri katman

`src/lib/firebase.ts` “Clean Local Document Store” olarak tanımlı. Koleksiyon verileri tarayıcı belleği ve `localStorage` üzerinde tutuluyor (`src/lib/firebase.ts:2–5, 82–118`). Bu katman, gerçek sunucu tarafında kalıcı finans veri tabanı olarak kabul edilmemeli.

### D. Frekans / reseller veri hattı

Frekans üyelikleri, reseller profilleri, bayi siparişleri, legacy komisyonlar ve dijital faturalar Monoline finans kayıtlarından ayrı yardımcılar ve tiplerle yönetiliyor. Başlıca yardımcılar:

- `src/utils/authManager.ts`
- `src/utils/resellerManager.ts`
- `src/utils/dealerOrderManager.ts`
- `src/utils/invoiceManager.ts`
- `src/utils/monolineSyncBridge.ts`

`monolineSyncBridge.ts` Frekans kayıtlarını Monoline’e aktarabiliyor ve bazı Monoline sonuçlarını Frekans tarafına geri yansıtabiliyor (`src/utils/monolineSyncBridge.ts:150–395, 549–570, 621–789`).

**Entegrasyon açısından sonuç:** Sistemde birbiriyle ilişkili ama aynı olmayan birden fazla kayıt kaynağı bulunuyor. Yeni muhasebe modülüne hangi kaynağın otoritatif olduğu tanımlanmadan bu koleksiyonları birleştirmek çift kayıt veya eksik kayıt üretebilir.

## 3. Finansal veri modelleri

Ana Monoline modelleri `src/types/monoline.ts` içindedir.

| Model | Yaklaşık konum | Muhasebe açısından içerik |
|---|---:|---|
| `MonolineMember` | `1099–1167` | Kullanıcı kimliği, sponsor, kariyer, hacim, bölgesel wallet ve banka bilgisi |
| `OrderLogRecord` | `1321–1335` | Sipariş, paket, tutar ve sipariş durumu |
| `CommissionLogRecord` | `1337–1373` | Kaynak/hedef, komisyon tipi, tutar, bölge, release ve refund durumu |
| `WithdrawalRequestRecord` | `1375–1416` | Brüt tutar, kesinti, net tutar, kanal, bölge ve ödeme durumu |
| `TaxRefundInvoiceRecord` | `1418–1443` | Çekime bağlı fatura dosyası, vergi iadesi isteği ve yönetici kararı |
| `WalletTransactionRecord` | `1530–1548` | Debit/credit, bakiye öncesi/sonrası ve bağlı istek/sipariş |
| `P2PTransferRecord` | `1550–1567` | Üyeler arası transfer, paket aktivasyonu veya voucher hareketi |
| `CommissionTransaction` | `1686–1759` | Siparişe bağlı komisyon dağıtım özeti |
| `SystemStateResponse` | `1786–1844` | Admin ve Back-Office ekranlarına gönderilen finansal state |

Bölgesel wallet alanları arasında `wallet_domestic_usd`, `wallet_international_usd`, `pending_domestic_usd` ve `pending_international_usd` bulunuyor (`src/types/monoline.ts:1133–1147`). Model bunları USD olarak adlandırıyor. Buna karşılık `sponsor_wallet`, `monoline_wallet` ve `total_earnings` gibi alanlarda tip tanımından para birimi kesin anlaşılmıyor.

Frekans/reseller tarafında alan adları ve durum enum’ları farklıdır. Örneğin `UserMember` `uid` ve `fullName`; Monoline `MonolineMember` ise `user_id` ve `full_name` kullanıyor. Aynı kavramların bu iki hattaki tipleri otomatik olarak aynı muhasebe varlığı sayılmamalı.

## 4. Finansal akışların özeti

### Sipariş ve komisyon

Yerel Express hattındaki ana sipariş/komisyon endpoint’i `POST /api/v1/integrations/order-commission` üzerinden çalışıyor (`server.ts:4846–5072`). İş akışı kabaca:

1. Sipariş kimliği kontrol edilir.
2. Paket ve ödeme koşulları doğrulanır.
3. Sipariş kaydı oluşturulur.
4. Komisyon hesaplama akışı çalışır.
5. Üye wallet’ları, log’lar ve sistem fonu güncellenir.

Temel oranlar `server.ts:72–80` civarında tanımlı: sponsor `%20`, Monoline derinlik oranları `%7, %5, %4, %3, %2, %2, %2`, sistem fonu `%5`.

Komisyonların pending/available wallet’a aktarılması ve komisyon kayıtları sunucu tarafında farklı alanlarla yürütülüyor (`server.ts:847–862` ve komisyon motoru). Cloud Functions’ta da benzer oranlar bulunuyor (`functions/index.js:66–76`), ancak bu iki akışın veri kaynağı ve transaction sınırları farklı.

`server.ts` tarafındaki yerel komisyon kuyruğu gerçek bir harici kuyruk altyapısı olarak görünmüyor; ilgili worker aynı proses içinde çağrılıyor (`server.ts:4810–4844`).

### 14 günlük bekleme süresi

Express’te pending komisyonları serbest bırakma akışı `server.ts:6553–6627` civarında. Cloud Function tarafında günlük zamanlanmış release akışı `functions/index.js:1213–1265` içinde. Bu iki release mekanizmasının farklı sıklıkta ve farklı state kaynaklarında çalıştığı dikkate alınmalı.

### Çekim ve ödeme

Çekim talebi, kullanılabilir wallet’tan tutarı düşerek `PENDING` talep oluşturuyor. Yönetici onayı veya reddi ilgili kayıt durumunu güncelliyor (`server.ts:4112–4493`).

Mevcut akışta bakiye, aktiflik, limit ve banka bilgisi doğrulamaları bulunuyor; ancak onaylanan talep için bankaya para gönderen bir payout sağlayıcısı çağrısı görünmüyor. İade edilen talep için net tutar kullanıcı wallet’ına geri ekleniyor; bunun ayrı, çift taraflı muhasebe kaydıyla eşleştirildiği görünmüyor. Modelde brüt, kesinti ve net tutar alanları var; ancak bunların her zaman aynı para biriminde tutulduğu kesin değil.

Bu nedenle çekim akışı mevcut haliyle **talep ve yönetici karar akışı** olarak ele alınmalı; gerçek banka mutabakatı olarak değil.

### Refund ve clawback

`POST /api/v1/integrations/order-refund` sipariş komisyonlarını geri alıp ilgili wallet ve hacim alanlarını güncelliyor (`server.ts:6665–6877`). Bu akış pending komisyonları pending wallet’tan, daha önce serbest bırakılmış komisyonları çekilebilir wallet’tan düşebiliyor. Kullanılabilir wallet’ın negatife düşmesine izin veren bir senaryo içeriyor. Gerçek ödeme sağlayıcısında para iadesi yaptığını gösteren bir çağrı görünmüyor.

### Vergi faturası ve dijital satış faturası

Çekime bağlı vergi iadesi faturası yükleme ve yönetici kararı `server.ts:7842–8067` civarında. Bu akış, fatura dosyasını ve iade talebini saklıyor.

Bundan ayrı olarak `src/utils/invoiceManager.ts:20–101, 427–510` satış/paket için dijital fatura verisi oluşturuyor. Kullanılan istemci saklama katmanı `src/lib/firebase.ts` üzerinden localStorage tabanlı olduğundan, bu akış tek başına resmi e-Fatura/e-Arşiv entegrasyonu veya sunucu tarafından garanti edilen numaralandırma olarak kabul edilmemeli.

## 5. Ekranlar ve istemci entegrasyon noktaları

### Admin

`src/components/AdminConsoleView.tsx` finans, çekim, vergi iadesi, sistem fonu dağıtımı ve log ekranları içeriyor:

- Finans & çekim ekranları: yaklaşık `1284–1294, 3147–3367`
- Vergi iadesi/fatura onay ekranı: yaklaşık `2844–3036`
- CSV çekim dışa aktarımı: yaklaşık `790–827`
- JSON export/restore: yaklaşık `995–1157`
- Komisyon ve sipariş detayları: `CommissionEngineView`, `LedgerTransactionsView`

Bu ekranların temel verileri `MonolineMlmPortalModal` üzerinden `SystemStateResponse` ve aksiyon callback’leri olarak taşınıyor.

### Bayi

`src/components/DealerBackOfficeView.tsx` içinde wallet KPI’ları ve bekleyen komisyonlar, cüzdanla paket satın alma, P2P transfer, alt bayi kaydı, çekim talebi, fatura yükleme ve üye komisyon geçmişi bulunuyor. Başlıca yerler yaklaşık `2082–2171, 2633–3219, 3222–3703`.

### Grafik ve ledger ekranları

- `src/components/SalesVolumeD3Chart.tsx` işlem geçmişinden dönemsel satış grafikleri ve istemci tarafı filtreler çıkarıyor.
- `src/components/LedgerTransactionsView.tsx` sipariş başına komisyon dağılımını gösteriyor.
- `src/components/CommissionEngineView.tsx` komisyon motoru, test siparişleri, refund/clawback ve release işlemlerini yönetiyor.

Bunlar kullanışlı finans ekranlarıdır; ancak “ledger” adı, muhasebe standartlarında çift taraflı ve değiştirilemez yevmiye defteri olduğu anlamına gelmiyor.

## 6. Önemli entegrasyon riskleri ve açık kararlar

### Yüksek öncelikli konular

1. **Otoritatif finans kaynağı belirlenmeli.** `server.ts`, `functions/index.js` ve Frekans istemci kayıtları farklı state ve kalıcılık yöntemleri kullanıyor.
2. **Kalıcı muhasebe veri tabanı belirlenmeli.** `server.ts` state’i bellek içinde; proses/instance sınırları arasında ortak finansal transaction garantisi görünmüyor.
3. **Para birimleri netleştirilmeli.** `server.ts:711–727` yurtiçi tutarları USD’ye dönüştürürken TRY kabul ediyor gibi görünüyor; paket/sipariş fiyatları ise bazı akışlarda USD gibi kullanılıyor. `amount`, `amount_usd`, `currency` alanlarının iş kuralları belgelenmeli.
4. **Pending siparişler finansallaşmamalı.** Bridge filtresinde reddedilen/demo kayıtlar dışlanıyor; ancak pending kayıtların da sync’e dahil olma olasılığı var (`monolineSyncBridge.ts:413–487`). Sunucu sync akışı bu siparişleri işleyebiliyor (`server.ts:5248–5260`).
5. **Tekrarlanan bridge çağrıları tam idempotent değil.** Bazı kredi/satış yan etkileri duplicate sipariş kontrolünden önce yapılabiliyor (`monolineSyncBridge.ts:971–1005`).
6. **Refund ve çekim gerçek para transferi değildir.** Muhasebe modülü, iç bakiye değişikliklerini gerçek ödeme sağlayıcısı hareketlerinden ayrı göstermeli.
7. **Güvenlik ve veri kapsamı gözden geçirilmeli.** `GET /api/v1/state` tüm state’i döndürüyor (`server.ts:3862–3864`, response kapsamı `3393–3492` civarı). Bu state’te IBAN, fatura verisi ve başka hassas alanlar bulunabilir. Dağıtım öncesi endpoint erişim kontrolleri ayrıca denetlenmeli.
8. **Vergi hesabı iş kuralı doğrulanmalı.** Withdrawal akışında `%20` kesinti görünürken modelde farklı vergi durumları da tanımlanmış. Bu rapor mevzuat yorumu değildir; gerçek oran ve istisnalar finans/hukuk ekibiyle belirlenmeli.

### Diğer mutabakat konuları

- `WalletTransactionRecord` modeli var; ancak her wallet değişikliğinin bu kayda zorunlu olarak yazıldığı garanti edilmiyor.
- Withdrawal onayı, gerçek transfer işlem kimliği veya banka settlement kaydı üretmiyor.
- Vergi iadesi, satış faturası ve çekim stopajı farklı akışlarda tutuluyor.
- `CommissionTransaction`, `CommissionLogRecord`, `OrderLogRecord`, `MemberOrder` ve `DealerPackageOrder` aynı kavramın eşdeğer tipleri değil.
- UI’daki JSON export/restore finansal verinin kalıcı arşivi veya ledger’ı olarak tasarlanmamış.
- `currency` ile aynı tutarın hangi para biriminde olduğu her modelde açık değil; tarihsel kurun saklanması gerektiği de mevcut modellerde sistematik görünmüyor.

## 7. Önerilen akıllı muhasebe tasarımı

Aşağıdaki tasarım **öneridir; mevcut sistemde zaten bulunduğu anlamına gelmez.**

### A. Önce salt okunur entegrasyon

İlk fazda muhasebe modülü mevcut sipariş, komisyon, wallet, withdrawal ve refund kayıtlarını okusun; kaynak kayıt kimliklerini korusun; eksik veya çelişkili verileri raporlasın ve mevcut finans akışlarına yazma yapmasın. Öncelik, sipariş–komisyon–wallet–çekim kayıtları arasında mutabakat raporu üretmek olmalı.

### B. Muhasebe defteri için ayrı kayıt modeli

Yeni modülde en azından şu kavramlar ayrı modellenmeli:

- **Hesap planı:** kasa/banka, müşteri bakiyesi, bekleyen komisyon, çekilebilir komisyon, vergi, sistem fonu, gelir/gider hesapları.
- **Yevmiye fişi:** kaynak olay, tarih, dönem, durum, idempotency anahtarı ve onay bilgisi.
- **Yevmiye satırı:** hesap, borç/alacak, tutar, para birimi, kur ve kaynak referansı.
- **Mutabakat kaydı:** iç kayıt ile banka/ödeme sağlayıcısı ekstresini eşleştiren kayıt.
- **Dönem/kur snapshot’ı:** işlem anındaki tarih, kur ve para birimi bilgisi.

Her fiş için borç ve alacak toplamları dengeli olmalı. Kayıtlar sonradan sessizce değiştirilmemeli; düzeltme gerekiyorsa ters kayıt veya düzeltme fişi oluşturulmalı.

### C. Kaynak olaylar

Muhasebe girişleri aşağıdaki olaylardan türetilebilir:

- Siparişin ödeme olarak kesinleşmesi
- Komisyonun pending tahakkuku
- Komisyonun 14 gün sonunda serbest bırakılması
- Çekim talebi, onayı, reddi ve banka transferinin gerçekleşmesi
- İade/chargeback ve komisyon clawback’i
- Wallet satın alımı veya P2P transferi
- Vergi kesintisi ve vergi iadesi
- Sistem fonu ve bonus dağıtımı

**Durum değişikliği ile muhasebe kaydı aynı şey değildir.** Örneğin çekim isteğinin `APPROVED` olması, banka transferinin gerçekleştiğini kanıtlamaz; gerçek settlement için banka referans numarası/ödeme sonucu beklenmeli.

### D. Güvenilir entegrasyon yöntemi

- Yeni muhasebe kayıtları istemci hesabından değil, sunucu tarafında oluşturulmalı.
- Her finansal kaynak olayı kalıcı ve benzersiz bir `source_event_id`/idempotency anahtarı taşımalı.
- Kaynak olay ve muhasebe kaydı mümkünse aynı kalıcı transaction veya güvenilir outbox deseniyle yazılmalı.
- Retry durumunda aynı kaynak olay ikinci kez yevmiye üretmemeli.
- Dış ödeme/banka sağlayıcısı bağlantıları, talep/onay/settlement adımlarını ayrı olaylar olarak iletmeli.

### E. Akıllı/AI katmanının sınırı

AI tarafı şüpheli veya çift görünen işlemleri işaretleyebilir; beklenmeyen para birimi/kur farklarını saptayabilir; açıklama ve kategori eşlemesi önerebilir; nakit akışı veya komisyon yükü için tahmin üretebilir; mutabakat farklarını özetleyebilir.

Muhasebe fişini AI’nın doğrudan, denetimsiz biçimde kesinleştirmesi yerine kurallar deterministik olmalı; yapay zekâ önerileri kullanıcı onayı ve audit kaydıyla uygulanmalıdır.

## 8. Önerilen geliştirme aşamaları

### Aşama 1 — Veri kaynağı ve mutabakat

- Hangi backend’in üretim finans kaynağı olduğunu belirleyin.
- ID eşlemesi kurun: `uid` ↔ `user_id`, `id` ↔ `order_id`.
- Sipariş, komisyon, wallet ve withdrawal kayıtlarını salt okunur raporda karşılaştırın.
- Pending siparişlerin komisyon akışına girmesini ve bridge tekrarlarının yan etkilerini inceleyin.
- Her tutar için para birimi ve kur kuralını belgeleyin.

### Aşama 2 — Muhasebe veri modeli

- Hesap planı, fiş/satır, kaynak olay, kur snapshot’ı, dönem ve mutabakat modellerini oluşturun.
- Para alanlarında kayan noktalı `number` yerine kesin ondalık veya minor-unit temsilini değerlendirin.
- Kaynak kayıt kimliği ve idempotency alanını zorunlu kılın.
- Düzeltme ve ters kayıt akışını tanımlayın.

### Aşama 3 — Salt okunur muhasebe ekranı

- Dönem, üyelik/bayi, sipariş, para birimi ve olay türü filtreleri ekleyin.
- Muhasebe fişi önerilerini ve mutabakat farklarını gösterin.
- CSV/Excel dışa aktarımını kaynak kimlikleriyle birlikte üretin.
- Yetkilendirme ve hassas alan maskelemesini uygulayın.

### Aşama 4 — Kontrollü otomatik kayıt

- Önce tek bir olay türünü (ör. kesinleşmiş sipariş) entegre edin.
- Test ortamında tekrar, gecikme, başarısızlık ve refund senaryolarını doğrulayın.
- Tüm kayıtların kaynak olayla izlenebilir olduğundan emin olun.
- İnsan onayıyla sınırlı bir pilot başlatın; otomatik kesinleştirmeyi daha sonra değerlendirin.

## 9. Geliştirmeye başlamadan önce ürün/finans ekibinden netleştirilmesi gerekenler

1. Resmî muhasebe kaynağı hangi sistem olacak: Monoline server, Cloud Functions, dış muhasebe programı veya yeni merkezi veri tabanı mı?
2. Yurt içi satış ve komisyon tutarlarının ana para birimi TRY mi USD mi? Kur hangi anda sabitleniyor?
3. Vergi, stopaj, KDV ve şirket/bayi istisnaları için onaylı iş kuralları nelerdir?
4. Çekim `APPROVED` durumundan sonra hangi dış ödeme adımı “gerçekleşti” sayılacak?
5. Refund, chargeback ve negatif bakiye nasıl muhasebeleştirilecek?
6. Muhasebe modülü hangi kullanıcı rolleri tarafından görüntülenip onaylanabilecek?
7. Fatura dosyaları ve kişisel/banka bilgileri için saklama, erişim ve maskeleme kuralları nelerdir?
8. İstenen rapor dönemleri, hesap planı ve dışa aktarım formatı nedir?

## 10. Başlıca dosyalar

- `server.ts:149–254` — sunucu state değişkenleri
- `server.ts:711–871` — bölgesel para dönüşümü ve wallet yardımcıları
- `server.ts:4846–5072` — yerel sipariş/komisyon akışı
- `server.ts:4112–4493` — çekim talebi ve yönetici kararı
- `server.ts:6553–6877` — komisyon release ve refund/clawback
- `server.ts:7842–8067` — çekim faturası/vergi iadesi
- `functions/index.js:247–894, 1213–1265` — Firestore sipariş/komisyon ve release
- `src/types/monoline.ts:1099–1443, 1530–1759` — temel finans tipleri
- `src/utils/monolineSyncBridge.ts:150–395, 549–570, 621–789` — Frekans–Monoline veri köprüsü
- `src/utils/invoiceManager.ts:20–101, 314–342, 427–547` — dijital fatura modeli ve üretimi
- `src/components/AdminConsoleView.tsx` — Admin finans, çekim, vergi iadesi ve raporlama ekranları
- `src/components/DealerBackOfficeView.tsx` — bayi wallet, çekim ve komisyon ekranları
- `firebase.json:17–67` — Cloud Functions rewrite kapsamı

## Geliştiriciye verilecek ana yön

Önce üretimde hangi veri kaynağının otoritatif olduğunu, para birimi kurallarını ve bridge idempotency’sini netleştirin. Bunlar doğrulanmadan mevcut bakiyelerden doğrudan muhasebe fişi üretmeyin; ilk sürümü salt okunur mutabakat ve denetim ekranı olarak tasarlayın.
