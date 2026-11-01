```
=== AKN GLOBAL GROUP E2E TEST SONUÇLARI ===
[✓] State uç noktası oturumsuz erişimi reddeder — HTTP 401
[✓] Test Kullanıcıları ve Hiyerarşi Oluşturuldu — B→A, C→B zinciri; C ülke=US, B ülke=TR
[✓] Bölgesel cüzdan alanları kayıtta tanımlı — A dom=0, intl=0; D dom=0, intl=0
[✓] 14 gerçek paket ve katalog uç değerleri — 14 paket; Mini $101, Enterprise Mega $6031
[✓] Kayıt endpointi vergi/kariyer/kredi ayrıcalıklarını istemciden kabul etmez — vergi=false, kariyer=null, kredi=64, sipariş=null
[✓] Yedi kişilik zincir ciroya rağmen direkt bayi şartı olmadan kariyer atlamaz — T1=1, T2=1; 3. kariyer için 20, 4. kariyer için 50 aktif direkt gerekir
[✓] Yedi test bayisi paket, sponsor zinciri, bölge fiyatı ve seans kredileriyle kaydedildi — T1 TR/PKG_ALTIN_PRO $603 · 270 kredi | T2 TR/PKG_MINI_DENEME $101 · 32 kredi | T3 US/PKG_BRONZ_BASLANGIC $603 · 70 kredi | T4 TR/PKG_GUMUS_STANDART $302 · 115 kredi | T5 DE/PKG_ALTIN_DANISMAN $1509 · 215 kredi | T6 TR/PKG_ALTIN_PRO $603 · 270 kredi | T7 TR/PKG_MINI_DENEME $101 · 32 kredi
[✓] Üst altı test bayisinin kariyer hak edişleri test override ile açıldı — T1=7, T2=6, T3=5, T4=4, T5=3, T6=2
[✓] Bayi 7 siparişi altı üst bayiye dağıtılır ve havuz bütçesi dengededir — HTTP 201; derinlik 1–6=T6→T1, 7=TRANSFERRED_TO_POOL_NO_UPLINE; baz=$50.50/$50.50; sistem fonu Δ=$5.05; havuz devri Δ=$2.02
[✓] Primler hak sahiplerinin cüzdan ve 14 günlük bekleyen bakiyelerine işlendi — hak ediş toplamı=$57.08; kayıtlı prim=$57.08; yurtiçi bekleyen USD dönüşümü=true; durum=PENDING_14D
[✓] T1 ve T2 kariyer ödülleri ve panel ağaç verisi senkron — T1=7. kariyer, T2=6. kariyer; ödüller=2,3,4,5,6,7; sponsor ağacı=1→1→1→1→1→1
[✓] Yurt dışı ilk kayıt yalnızca 3D Secure ödeme sonrası 3x paket tutarıyla işlenir — kayıt HTTP 201, sipariş HTTP 200; tutar=$603, kredi=70
[✓] Bölgesel Cüzdan Yüklemeleri Başarılı — B dom=500, C intl=1000, D dom=50 (restore HTTP 200)
[✓] State yanıtı 2FA sırlarını ve alt üye kişisel verilerini gizler — HTTP 200; 2FA ve alt üye kişisel alanları gizli
[✓] Paket fiyatları oturum ve hesap kapsamı ister; yapılandırılmamış TOTP etkinleştirilemez — anonim fiyat=401, başka kullanıcı fiyatı=403, TOTP=501
[✓] Bayi kendi seans kredisi bakiyesini API ile artıramaz — HTTP 403
[✓] Yurtiçi ($100) Aktiflik Mevcut Süreye Eklenir (+30 gün) — HTTP 200; dom Δ=-100.00; expiry Δ=30.00 gün; kredi Δ=0; exp 2026-12-01T15:46:41.278Z → 2026-12-31T15:46:41.278Z
[✓] Uluslararası ($300) Aktiflik Mevcut Süreye Eklenir (+30 gün) — HTTP 200; intl Δ=-300.00; expiry Δ=30.00 gün; kredi Δ=0; exp 2026-12-01T15:46:41.313Z → 2026-12-31T15:46:41.313Z
[✓] Yetersiz Bakiye 422 Hatası Doğrulandı — HTTP 422, code=INSUFFICIENT_WALLET_BALANCE; bakiye korundu=50
[✓] Sponsor Komisyon ve Sayaç Simetrisi (B: derinlik 1 ödenir; A: derinlik 2 kilitli) — C aktifliği sonrası: B kazanç Δ=81.00, A kazanç Δ=0.00 (A seviye 1: yalnızca derinlik 1 açık); sayaç Δ B=81.00, A=0.00. 7 derinlik testi ayrı adımda
[✓] Kariyer Hesaplama Ucu Yetkisiz Erişimi Engellendi — HTTP 401, code=ADMIN_AUTH_REQUIRED
[✓] 7 Derinlik Zinciri Kilit Derinlikleri (U7=1 … U1=7) — U7=1, U6=2, U5=3, U4=4, U3=5, U2=6, U1=7
[✓] 7. kariyere geçişte 2–7 kariyer ödülleri tek kez oluştu — seviyeler=2,3,4,5,6,7; ödül toplamı=$215500
[✓] Baz dağıtım bütçesi %5 fon + %20 sponsor + %25 monoline = %50 — HTTP 200; baz dağıtım=$50.00/$50.00, derinlik=%25, sponsor=%20, fon=$5; ek sonsuzluk=$10, eşleşme=$2.7; durum=PENDING_14D
[✓] Vadesi dolmayan komisyon erken serbest bırakılamaz — HTTP 200, serbest bırakılan=0
[✓] Bekleyen bakiye yetersizse komisyon serbest bırakılmaz veya cüzdan artırılmaz — HTTP 200, serbest=0, log=PENDING_14D
[✓] P2P Bayiler Arası Transfer Başarılı — HTTP 200; gönderen Δ=-100.00, alıcı Δ=100.00; kayıt=true (tutar 100)
[✓] P2P Transferi activityLogs'a Yazıldı — gönderen log=true, alıcı log=true
[✓] P2P geçersiz tür ve oturumsuz istekleri reddeder — geçersiz tür HTTP 400, oturumsuz HTTP 401
[✓] Yetkisiz Süre Uzatma (403 Admin Only) Engeli Doğrulandı — HTTP 403, code=ADMIN_ONLY_ACTION
[✓] Kariyer eşiği — L2: 10 aktif direkt, toplam ciro 2000 — hedef seviye=2 (beklenen 2)
[✓] Kariyer eşiği — L2 reddi: 9 aktif direkt, ciro 2700 — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L2 reddi: 10 direkt ama 1 pasif (9 aktif) — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L2 reddi: 10 aktif direkt, ciro 1500 — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L3: 20 aktif direkt, ciro 6000 — hedef seviye=3 (beklenen 3)
[✓] Kariyer Canlı API — Seviye 2: 10 aktif direkt, PGV 2000, kişisel 1000 — HTTP 200, aktif seviye=2 (beklenen 2), aktif direkt=10, PGV=2000
[✓] Kariyer Canlı API — Seviye 3: 20 aktif direkt, PGV 6000, kişisel 3000 — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=20, PGV=6000
[✓] Kariyer Canlı API — Seviye 2 reddi: 9 aktif direkt, PGV 2250 — HTTP 200, aktif seviye=1 (beklenen 1), aktif direkt=9, PGV=2250
[✓] Kariyer Canlı API — Seviye 2 reddi: kişisel hacim 500 — HTTP 200, aktif seviye=1 (beklenen 1), aktif direkt=10, PGV=2000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi OK: 50 direkt × 200 (her kol %2), Levvâme kolu — HTTP 200, aktif seviye=4 (beklenen 4), aktif direkt=50, PGV=10000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi reddi: tek kol 10000 (%100), diğer 49 kol 0, Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=10000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi reddi: tek kol 20000 (toplam 20000), Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=20000
[✓] Kariyer Canlı API — Seviye 4 reddi: toplam ciro 9000 < 10000 (kollar 4000/2500/2500), Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=9000
[✓] Kazanılmış kariyer pasif dönemde korunur — max 2→2, unvan Levvâme→Levvâme
[✓] Yurtiçi TR IBAN çekimi oluşturuldu — HTTP 201, region=DOMESTIC, channel=TR_IBAN, dom Δ=-100.00
[✓] Eksik yönetici kararı finansal işlem başlatmaz — çekim kararı=400, vergi kararı=400
[✓] Yurtiçi red sonrası stopaj düşülerek net tutar iade edildi — HTTP 200, dom bakiye=280 (beklenen 280), stopaj=20
[✓] Reddedilmiş çekime bağlı vergi iadesi kapatılır — fatura yükleme=201, durum=REJECTED, sonradan onay=400, yeni fatura=400
[✓] Yurt dışı SWIFT IBAN çekimi oluşturuldu — HTTP 201, channel=SWIFT, swift=DEUTDEFF, intl Δ=-300.00
[✓] Yurt dışı red sonrası stopaj düşülerek net tutar iade edildi — HTTP 200, intl bakiye=640 (beklenen 640), stopaj=60
[✓] Yurt dışı SEPA IBAN çekimi oluşturuldu — HTTP 201, channel=SEPA
[✓] Geçersiz yurtiçi TR IBAN reddedildi — HTTP 400, bakiye korundu=true
[✓] TR IBAN checksum hatası reddedildi — HTTP 400, bakiye korundu=true
[✓] Geçersiz uluslararası IBAN checksum reddedildi — HTTP 400, bakiye korundu=true
[✓] Geçersiz BIC reddedildi — HTTP 400, bakiye korundu=true
[✓] Ad-soyad uyuşmazlığı reddedildi — HTTP 400, bakiye korundu=true
[✓] Oturumsuz çekim reddedildi (401) — HTTP 401, code=MEMBER_AUTH_REQUIRED
[✓] Başka bayi adına çekim (user_id spoof) reddedildi (403) — HTTP 403, code=PAYER_ID_MISMATCH, B bakiye korundu=true
[✓] Yönetici listesinde bölge, kanal ve SWIFT bilgisi görünür — HTTP 200, region=INTERNATIONAL, channel=SWIFT, swift=DEUTDEFF
[✓] Eksik vergi kararı faturayı otomatik onaylamaz — fatura=201, boş karar=400, durum=PENDING_ADMIN_APPROVAL
[✓] Yönetici onayı yetkisiz erişime kapalı, yetkili onay kaydı APPROVED yapar — yetkisiz HTTP 401, yetkili HTTP 200
[✓] Süresi dolmuş bayinin çekimi reddedildi (ana rota ve alias 403) — ana rota HTTP 403, alias HTTP 403, code=WITHDRAWAL_CONDITION_NOT_MET; bakiye korundu=true
[✓] Aktif süre varken ikinci alım aylık sınır olmadan kalan süreye +30 gün ekler — HTTP 200; expiry Δ=30.00 gün; dom Δ=-100.00
[✓] Yinelenen sipariş gönderimi cüzdanı ve komisyon loglarını değiştirmez — ilk sipariş log=12; tekrar HTTP 200, code=IDEMPOTENCY_DUPLICATE_ORDER_ID; cüzdan değişmedi=true; log sonrası=12
[✓] Kariyer havuzu aynı dönemde ikinci kez dağıtılmaz ve atlanan krediler denetlenir — ilk dağıtım=46.49; ikinci dağıtım=0; atlanan kayıt=54; cüzdanlar değişmedi=true
[✓] Manuel bireysel kariyer ödemesi batch_id ile tekrar edilemez — batch_id yok=400/BATCH_ID_REQUIRED; ilk=200; tekrar=409/BATCH_ALREADY_PAID; bakiye Δ=1.00; tekrar sonrası değişmedi=true
[✓] Tier kariyer ödemesinde tüm adaylar ödenmişse ALL_ELIGIBLE_ALREADY_PAID döner — ilk=200; tekrar=409/ALL_ELIGIBLE_ALREADY_PAID; cüzdanlar değişmedi=true
[✓] Dinamik havuz REV1 revizyonu ayrı dönemde bir kez dağıtılır — geçersiz=400/INVALID_REVISION; REV1 ilk=1.85; REV1 tekrar=0; atlanan=30
[✓] Ödül teslimi cüzdana bir kez işlenir, tekrar teslim REWARD_ALREADY_DELIVERED döner — teslim edilecek ödül=true; ilk=200; tekrar=409/REWARD_ALREADY_DELIVERED; cüzdan değişmedi=true

TÜM TESTLER BAŞARIYLA TAMAMLANDI.
```
