```
=== AKN GLOBAL GROUP E2E TEST SONUÇLARI ===
[✓] Test Kullanıcıları ve Hiyerarşi Oluşturuldu — B→A, C→B zinciri; C ülke=US, B ülke=TR
[✓] Bölgesel cüzdan alanları kayıtta tanımlı — A dom=0, intl=0; D dom=0, intl=0
[✓] Bölgesel Cüzdan Yüklemeleri Başarılı — B dom=500, C intl=1000, D dom=50 (restore HTTP 200)
[✓] Yurtiçi ($100) Aktiflik Mevcut Süreye Eklenir (+30 gün) — HTTP 200; dom Δ=-100.00; expiry Δ=30.00 gün; kredi Δ=0; exp 2026-11-27T21:08:47.450Z → 2026-12-27T21:08:47.450Z
[✓] Uluslararası ($300) Aktiflik Mevcut Süreye Eklenir (+30 gün) — HTTP 200; intl Δ=-300.00; expiry Δ=30.00 gün; kredi Δ=0; exp 2026-11-27T21:08:47.485Z → 2026-12-27T21:08:47.485Z
[✓] Yetersiz Bakiye 422 Hatası Doğrulandı — HTTP 422, code=INSUFFICIENT_WALLET_BALANCE; bakiye korundu=50
[✓] Sponsor Komisyon ve Sayaç Simetrisi (B: derinlik 1 ödenir; A: derinlik 2 kilitli) — C aktifliği sonrası: B kazanç Δ=81.00, A kazanç Δ=0.00 (A seviye 1: yalnızca derinlik 1 açık); sayaç Δ B=81.00, A=0.00. 7 derinlik testi ayrı adımda
[✓] Kariyer Hesaplama Ucu Yetkisiz Erişimi Engellendi — HTTP 401, code=ADMIN_AUTH_REQUIRED
[✓] 7 Derinlik Zinciri Kilit Derinlikleri (U7=1 … U1=7) — U7=1, U6=2, U5=3, U4=4, U3=5, U2=6, U1=7
[✓] Komisyon oranları %20/%25/%5 ve 14 günlük bekleme — HTTP 200; derinlik toplamı=%25, sponsor=%20, fon=$5, durum=PENDING_14D
[✓] Vadesi dolmayan komisyon erken serbest bırakılamaz — HTTP 200, serbest bırakılan=0
[✓] P2P Bayiler Arası Transfer Başarılı — HTTP 200; gönderen Δ=-100.00, alıcı Δ=100.00; kayıt=true (tutar 100)
[✓] P2P Transferi activityLogs'a Yazıldı — gönderen log=true, alıcı log=true
[✓] Yetkisiz Süre Uzatma (403 Admin Only) Engeli Doğrulandı — HTTP 403, code=ADMIN_ONLY_ACTION
[✓] Kariyer eşiği — L2: 10 aktif direkt, toplam ciro 2000 — hedef seviye=2 (beklenen 2)
[✓] Kariyer eşiği — L2 reddi: 9 aktif direkt, ciro 2700 — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L2 reddi: 10 direkt ama 1 pasif (9 aktif) — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L2 reddi: 10 aktif direkt, ciro 1500 — hedef seviye=1 (beklenen 1)
[✓] Kariyer eşiği — L3: 20 aktif direkt, ciro 6000 — hedef seviye=3 (beklenen 3)
[✓] Kariyer Canlı API — Seviye 2: 10 aktif direkt, PGV 2000, kişisel 1000 — HTTP 200, aktif seviye=2 (beklenen 2), aktif direkt=10, PGV=2000
[✓] Kariyer Canlı API — Seviye 2 reddi: 9 aktif direkt, PGV 2250 — HTTP 200, aktif seviye=1 (beklenen 1), aktif direkt=9, PGV=2250
[✓] Kariyer Canlı API — Seviye 2 reddi: kişisel hacim 500 — HTTP 200, aktif seviye=1 (beklenen 1), aktif direkt=10, PGV=2000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi OK: 50 direkt × 200 (her kol %2), Levvâme kolu — HTTP 200, aktif seviye=4 (beklenen 4), aktif direkt=50, PGV=10000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi reddi: tek kol 10000 (%100), diğer 49 kol 0, Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=10000
[✓] Kariyer Canlı API — Seviye 4 kol dengesi reddi: tek kol 20000 (toplam 20000), Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=20000
[✓] Kariyer Canlı API — Seviye 4 reddi: toplam ciro 9000 < 10000 (kollar 4000/2500/2500), Levvâme kolu — HTTP 200, aktif seviye=3 (beklenen 3), aktif direkt=50, PGV=9000
[✓] Kazanılmış kariyer pasif dönemde korunur — max 2→2, unvan Levvâme→Levvâme
[✓] Yurtiçi TR IBAN çekimi oluşturuldu — HTTP 201, region=DOMESTIC, channel=TR_IBAN, dom Δ=-100.00
[✓] Eksik yönetici kararı finansal işlem başlatmaz — çekim kararı=400, vergi kararı=400
[✓] Yurtiçi red sonrası tam tutar iade edildi, stopaj uygulanmadı — HTTP 200, dom bakiye=300 (beklenen 300), stopaj=0
[✓] Reddedilmiş çekime bağlı vergi iadesi kapatılır — fatura yükleme=201, durum=REJECTED, sonradan onay=400, yeni fatura=400
[✓] Yurt dışı SWIFT IBAN çekimi oluşturuldu — HTTP 201, channel=SWIFT, swift=DEUTDEFF, intl Δ=-300.00
[✓] Yurt dışı red sonrası tam tutar iade edildi, stopaj uygulanmadı — HTTP 200, intl bakiye=700 (beklenen 700), stopaj=0
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

TÜM TESTLER BAŞARIYLA TAMAMLANDI.
```
