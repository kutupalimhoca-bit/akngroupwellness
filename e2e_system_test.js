import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { evaluateMemberOrganizationMetrics, INITIAL_CAREER_TIERS } from './src/types/monoline.ts';

const PORT = Number(process.env.E2E_PORT) || 3000;
const BASE = `http://127.0.0.1:${PORT}`;
const DAY_MS = 86400000;
const stamp = Date.now().toString(36);
const results = [];

function record(label, pass, detail) {
  results.push({ label, pass: Boolean(pass), detail });
  console.log(`${pass ? '[✓]' : '[✗]'} ${label} — ${detail}`);
}

const near = (a, b, eps = 0.005) => Math.abs(a - b) < eps;

async function api(method, path, { body, token } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

let adminToken = null;

async function snapshot() {
  const r = await api('GET', '/api/v1/admin/export-data', { token: adminToken });
  return r.json.data;
}

const find = (data, userId) => data.members.find((m) => m.user_id === userId);

async function waitForHealth(timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      // sunucu henüz ayağa kalkmadı
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  const adminPassword = randomBytes(16).toString('hex');
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    ADMIN_PASSWORD: adminPassword,
    ADMIN_JWT_SECRET: randomBytes(32).toString('hex'),
    MEMBER_JWT_SECRET: randomBytes(32).toString('hex'),
  };

  const alreadyRunning = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
  if (alreadyRunning) {
    console.error(`Port ${PORT} zaten kullanımda. Testler durum sıfırlamaması için mevcut sunucuyu kullanmaz; önce durdurun.`);
    process.exitCode = 1;
    return;
  }

  const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  try {
    if (!(await waitForHealth())) {
      console.error('Sunucu zamanında ayağa kalkmadı. Son log:\n' + serverLog.slice(-2000));
      process.exitCode = 1;
      return;
    }

    // ---------- Adım 1: Ağ ağacı ----------
    const adminLogin = await api('POST', '/api/v1/admin/login', {
      body: { email: 'psikologabdulkadirkan@gmail.com', password: adminPassword },
    });
    adminToken = adminLogin.json?.token || null;
    if (!adminToken) {
      console.error('Admin girişi başarısız; export/restore testleri yapılamaz.');
      process.exitCode = 1;
      return;
    }

    const PASSWORD = 'Test1234';
    const ids = { A: `E2E-A-${stamp}`, B: `E2E-B-${stamp}`, C: `E2E-C-${stamp}`, D: `E2E-D-${stamp}`, E: `E2E-E-${stamp}` };
    for (let i = 1; i <= 8; i++) ids[`U${i}`] = `E2E-U${i}-${stamp}`;
    const emails = {
      A: `e2e-a-${stamp}@test.local`,
      B: `e2e-b-${stamp}@test.local`,
      C: `e2e-c-${stamp}@test.local`,
      D: `e2e-d-${stamp}@test.local`,
      E: `e2e-e-${stamp}@test.local`,
    };
    for (let i = 1; i <= 8; i++) emails[`U${i}`] = `e2e-u${i}-${stamp}@test.local`;

    const createdOk = [];
    const create = async (key, country, sponsorUserId) => {
      const r = await api('POST', '/api/v1/members', {
        body: {
          user_id: ids[key],
          full_name: `E2E Kullanıcı ${key}`,
          email: emails[key],
          country_code: country,
          sponsor_id: sponsorUserId ?? '',
          password: PASSWORD,
          skip_initial_order: true,
        },
      });
      createdOk.push([200, 201].includes(r.status) && r.json?.status === 'success');
    };
    await create('A', 'TR', null);
    await create('B', 'TR', ids.A);
    await create('C', 'US', ids.B);
    await create('D', 'TR', ids.A);
    await create('E', 'TR', ids.D);
    await create('U1', 'TR', null);
    for (let i = 2; i <= 8; i++) await create(`U${i}`, 'TR', ids[`U${i - 1}`]);

    let data = await snapshot();
    const mA = find(data, ids.A);
    const mB = find(data, ids.B);
    const mC = find(data, ids.C);
    const mD = find(data, ids.D);
    record(
      'Test Kullanıcıları ve Hiyerarşi Oluşturuldu',
      createdOk.every(Boolean) && mB?.sponsor_id === ids.A && mC?.sponsor_id === ids.B && mC?.country_code === 'US' && mB?.country_code === 'TR',
      `B→A, C→B zinciri; C ülke=${mC?.country_code}, B ülke=${mB?.country_code}`
    );
    record(
      'Bölgesel cüzdan alanları kayıtta tanımlı',
      [mA, mB, mC, mD].every((m) => typeof m?.wallets?.wallet_domestic_usd === 'number' && typeof m?.wallets?.wallet_international_usd === 'number'),
      `A dom=${mA?.wallets?.wallet_domestic_usd}, intl=${mA?.wallets?.wallet_international_usd}; D dom=${mD?.wallets?.wallet_domestic_usd}, intl=${mD?.wallets?.wallet_international_usd}`
    );

    // ---------- Adım 2: Bakiye yükleme (test verisi, export/restore ile) ----------
    data.members.forEach((m) => {
      if (m.user_id === ids.B) m.wallets.wallet_domestic_usd = 500;
      if (m.user_id === ids.C) m.wallets.wallet_international_usd = 1000;
      if (m.user_id === ids.D) m.wallets.wallet_domestic_usd = 50;
      if (m.user_id === ids.E) m.wallets.wallet_domestic_usd = 500;
      if (m.user_id === ids.U8) m.wallets.wallet_domestic_usd = 500;
    });
    const restore = await api('POST', '/api/v1/admin/restore-data', { body: { data }, token: adminToken });
    data = await snapshot();
    const bDom = find(data, ids.B).wallets.wallet_domestic_usd;
    const cIntl = find(data, ids.C).wallet_international_usd ?? find(data, ids.C).wallets.wallet_international_usd;
    const dDom = find(data, ids.D).wallets.wallet_domestic_usd;
    record(
      'Bölgesel Cüzdan Yüklemeleri Başarılı',
      restore.status === 200 && bDom === 500 && cIntl === 1000 && dDom === 50,
      `B dom=${bDom}, C intl=${cIntl}, D dom=${dDom} (restore HTTP ${restore.status})`
    );

    // ---------- Oturumlar ----------
    const login = async (key) => {
      const r = await api('POST', '/api/v1/member/session', { body: { email: emails[key], password: PASSWORD } });
      return r.json?.token || null;
    };
    const tokB = await login('B');
    const tokC = await login('C');
    const tokD = await login('D');

    // ---------- Adım 3.1: Yurtiçi $100 ----------
    data = await snapshot();
    const b0 = find(data, ids.B);
    const b0Exp = new Date(b0.activity_expires_at).getTime();
    const b0Credits = b0.session_credits;
    const b0Intl = b0.wallets.wallet_international_usd || 0;
    const r31 = await api('POST', `/api/v1/members/${ids.B}/activity-action`, { token: tokB, body: { action: 'RENEW_PACKAGE' } });
    data = await snapshot();
    const b1 = find(data, ids.B);
    const dDomB = b1.wallets.wallet_domestic_usd - 500;
    const expDaysB = (new Date(b1.activity_expires_at).getTime() - b0Exp) / DAY_MS;
    record(
      'Yurtiçi ($100) Aktiflik Mevcut Süreye Eklenir (+30 gün)',
      r31.status === 200 && near(dDomB, -100) && expDaysB > 29.5 && expDaysB < 30.5 && b1.session_credits === b0Credits && (b1.wallets.wallet_international_usd || 0) === b0Intl,
      `HTTP ${r31.status}; dom Δ=${dDomB.toFixed(2)}; expiry Δ=${expDaysB.toFixed(2)} gün; kredi Δ=${b1.session_credits - b0Credits}; exp ${b0.activity_expires_at} → ${b1.activity_expires_at}`
    );

    // ---------- Adım 3.2: Uluslararası $300 ----------
    data = await snapshot();
    const a0 = find(data, ids.A);
    const bBefore = find(data, ids.B);
    const c0 = find(data, ids.C);
    const c0Exp = new Date(c0.activity_expires_at).getTime();
    const c0Credits = c0.session_credits;
    const c0Dom = c0.wallets.wallet_domestic_usd || 0;
    const totalsBefore = { A: a0.wallets.total_earnings, B: bBefore.wallets.total_earnings };
    const countersBefore = {
      A: sumCounters(a0),
      B: sumCounters(bBefore),
    };
    const r32 = await api('POST', `/api/v1/members/${ids.C}/activity-action`, { token: tokC, body: { action: 'RENEW_PACKAGE' } });
    data = await snapshot();
    const c1 = find(data, ids.C);
    const dIntlC = c1.wallets.wallet_international_usd - 1000;
    const expDaysC = (new Date(c1.activity_expires_at).getTime() - c0Exp) / DAY_MS;
    record(
      'Uluslararası ($300) Aktiflik Mevcut Süreye Eklenir (+30 gün)',
      r32.status === 200 && near(dIntlC, -300) && expDaysC > 29.5 && expDaysC < 30.5 && c1.session_credits === c0Credits && (c1.wallets.wallet_domestic_usd || 0) === c0Dom,
      `HTTP ${r32.status}; intl Δ=${dIntlC.toFixed(2)}; expiry Δ=${expDaysC.toFixed(2)} gün; kredi Δ=${c1.session_credits - c0Credits}; exp ${c0.activity_expires_at} → ${c1.activity_expires_at}`
    );

    // ---------- Adım 3.3: Yetersiz bakiye ----------
    const d0 = find(data, ids.D);
    const r33 = await api('POST', `/api/v1/members/${ids.D}/activity-action`, { token: tokD, body: { action: 'RENEW_PACKAGE' } });
    data = await snapshot();
    const d1 = find(data, ids.D);
    record(
      'Yetersiz Bakiye 422 Hatası Doğrulandı',
      r33.status === 422 && r33.json?.code === 'INSUFFICIENT_WALLET_BALANCE' && d1.wallets.wallet_domestic_usd === 50 && d1.activity_expires_at === d0.activity_expires_at,
      `HTTP ${r33.status}, code=${r33.json?.code}; bakiye korundu=${d1.wallets.wallet_domestic_usd}`
    );

    // ---------- Adım 4: Komisyon ve sayaç ----------
    const upA = find(data, ids.A);
    const upB = find(data, ids.B);
    const dTotalA = upA.wallets.total_earnings - totalsBefore.A;
    const dTotalB = upB.wallets.total_earnings - totalsBefore.B;
    const dCountersA = sumCounters(upA) - countersBefore.A;
    const dCountersB = sumCounters(upB) - countersBefore.B;
    record(
      'Sponsor Komisyon ve Sayaç Simetrisi (B: derinlik 1 ödenir; A: derinlik 2 kilitli)',
      dTotalB > 0 && near(dTotalA, 0) && near(dCountersB, dTotalB) && near(dCountersA, dTotalA),
      `C aktifliği sonrası: B kazanç Δ=${dTotalB.toFixed(2)}, A kazanç Δ=${dTotalA.toFixed(2)} (A seviye 1: yalnızca derinlik 1 açık); sayaç Δ B=${dCountersB.toFixed(2)}, A=${dCountersA.toFixed(2)}. 7 derinlik testi ayrı adımda`
    );

    // ---------- Adım 4b: 7 derinlik tam zincir (U8 → U7 … U1) ----------
    const uplineIds = [1, 2, 3, 4, 5, 6, 7].map((d) => ids[`U${8 - d}`]);
    for (let d = 1; d <= 7; d++) {
      await api('PUT', `/api/v1/admin/members/${ids[`U${8 - d}`]}`, {
        token: adminToken,
        body: { manual_career_override: d },
      });
    }
    const rNoAuth = await api('POST', '/api/v1/admin/career/calculate-active', { body: {} });
    record(
      'Kariyer Hesaplama Ucu Yetkisiz Erişimi Engellendi',
      rNoAuth.status === 401 && rNoAuth.json?.code === 'ADMIN_AUTH_REQUIRED',
      `HTTP ${rNoAuth.status}, code=${rNoAuth.json?.code}`
    );
    await api('POST', '/api/v1/admin/career/calculate-active', { token: adminToken, body: {} });
    data = await snapshot();
    const lockDepths = [1, 2, 3, 4, 5, 6, 7].map((d) => find(data, ids[`U${8 - d}`])?.unlocked_depth);
    record(
      '7 Derinlik Zinciri Kilit Derinlikleri (U7=1 … U1=7)',
      lockDepths.every((v, i) => v === i + 1),
      lockDepths.map((v, i) => `U${7 - i}=${v}`).join(', ')
    );
    const tokU8 = await login('U8');
    const earnBefore = uplineIds.map((uid) => find(data, uid).wallets.total_earnings);
    const r7 = await api('POST', `/api/v1/members/${ids.U8}/activity-action`, { token: tokU8, body: { action: 'RENEW_PACKAGE' } });
    data = await snapshot();
    const payouts = r7.json?.transaction?.monoline_upline_payouts || [];
    const depthPaid = [1, 2, 3, 4, 5, 6, 7].every((d) => {
      const p = payouts.find((x) => x.depth === d);
      return p?.status === 'PAID_TO_MEMBER' && p.recipient_user_id === ids[`U${8 - d}`] && p.calculated_amount > 0;
    });
    const earnedAll = uplineIds.every((uid, i) => find(data, uid).wallets.total_earnings > earnBefore[i]);
    const canonicalRates = near(payouts.reduce((sum, payout) => sum + payout.rate_percent, 0), 25) &&
      r7.json?.transaction?.direct_sponsor?.rate_percent === 20 &&
      near(r7.json?.transaction?.system_fund_base_amount, 5) &&
      r7.json?.transaction?.clawback_status === 'PENDING_14D';
    record(
      'Komisyon oranları %20/%25/%5 ve 14 günlük bekleme',
      r7.status === 200 && depthPaid && earnedAll && canonicalRates,
      `HTTP ${r7.status}; derinlik toplamı=%${payouts.reduce((sum, payout) => sum + payout.rate_percent, 0)}, sponsor=%${r7.json?.transaction?.direct_sponsor?.rate_percent}, fon=$${r7.json?.transaction?.system_fund_base_amount}, durum=${r7.json?.transaction?.clawback_status}`
    );
    const earlyRelease = await api('POST', '/api/v1/admin/cron/release-clawback', {
      token: adminToken,
      body: { order_id: r7.json?.transaction?.order_id },
    });
    record(
      'Vadesi dolmayan komisyon erken serbest bırakılamaz',
      earlyRelease.status === 200 && earlyRelease.json?.released_count === 0 &&
        r7.json?.transaction?.clawback_status === 'PENDING_14D',
      `HTTP ${earlyRelease.status}, serbest bırakılan=${earlyRelease.json?.released_count}`
    );

    // ---------- Adım 5: P2P transfer ----------
    data = await snapshot();
    const bP0 = find(data, ids.B).wallets.wallet_domestic_usd;
    const aP0 = find(data, ids.A).wallets.wallet_domestic_usd;
    const P2P_AMOUNT = 100; // Sunucu minimum P2P tutarını 100 USD uygular (Math.max(100, ...))
    const r5 = await api('POST', '/api/v1/p2p/transfer', {
      body: { from_user_id: ids.B, to_user_id: ids.A, amount: P2P_AMOUNT, transfer_type: 'WALLET_TO_WALLET' },
    });
    data = await snapshot();
    const bP1 = find(data, ids.B).wallets.wallet_domestic_usd;
    const aP1 = find(data, ids.A).wallets.wallet_domestic_usd;
    const txRec = data.p2pTransfers.find((t) => t.from_external_id === ids.B && t.to_external_id === ids.A);
    record(
      'P2P Bayiler Arası Transfer Başarılı',
      r5.status === 200 && near(bP1 - bP0, -P2P_AMOUNT) && near(aP1 - aP0, P2P_AMOUNT) && Boolean(txRec),
      `HTTP ${r5.status}; gönderen Δ=${(bP1 - bP0).toFixed(2)}, alıcı Δ=${(aP1 - aP0).toFixed(2)}; kayıt=${Boolean(txRec)}${txRec ? ` (tutar ${txRec.amount})` : ''}`
    );

    const p2pLogs = r5.json?.state?.activity_logs || [];
    const logSent = p2pLogs.some((l) => l.action_type === 'P2P_TRANSFER_SENT' && l.user_id === find(data, ids.B).id);
    const logRecv = p2pLogs.some((l) => l.action_type === 'P2P_TRANSFER_RECEIVED' && l.user_id === find(data, ids.A).id);
    record(
      'P2P Transferi activityLogs\'a Yazıldı',
      logSent && logRecv,
      `gönderen log=${logSent}, alıcı log=${logRecv}`
    );

    // ---------- Adım 6: Yetkisiz süre uzatma ----------
    data = await snapshot();
    const bSec0 = find(data, ids.B).activity_expires_at;
    const r6 = await api('POST', `/api/v1/members/${ids.B}/activity-action`, {
      token: tokB,
      body: { action: 'EXTEND_DAYS', days: 30 },
    });
    data = await snapshot();
    record(
      'Yetkisiz Süre Uzatma (403 Admin Only) Engeli Doğrulandı',
      r6.status === 403 && r6.json?.code === 'ADMIN_ONLY_ACTION' && find(data, ids.B).activity_expires_at === bSec0,
      `HTTP ${r6.status}, code=${r6.json?.code}`
    );

    // ---------- Adım 7: Kariyer eşikleri (gerçek motor) ----------
    const cases = [
      { name: 'L2: 10 aktif direkt, toplam ciro 2000', directs: 10, vol: 200, inactive: 0, expect: 2 },
      { name: 'L2 reddi: 9 aktif direkt, ciro 2700', directs: 9, vol: 300, inactive: 0, expect: 1 },
      { name: 'L2 reddi: 10 direkt ama 1 pasif (9 aktif)', directs: 10, vol: 300, inactive: 1, expect: 1 },
      { name: 'L2 reddi: 10 aktif direkt, ciro 1500', directs: 10, vol: 150, inactive: 0, expect: 1 },
      { name: 'L3: 20 aktif direkt, ciro 6000', directs: 20, vol: 300, inactive: 0, expect: 3 },
    ];
    for (const c of cases) {
      const r = buildCareerScenario(c);
      record(`Kariyer eşiği — ${c.name}`, r === c.expect, `hedef seviye=${r} (beklenen ${c.expect})`);
    }

    // ---------- Adım 8: Kariyer eşikleri (canlı API) ----------
    const liveCareerCase = async (key, { name, directCount, directVol, childVolumes, leaderVol, expectLevel, levvameRoot = false }) => {
      const leaderId = `E2E-${key}-L-${stamp}`;
      const childIds = Array.from({ length: directCount }, (_, i) => `E2E-${key}-D${i + 1}-${stamp}`);
      const register = (userId, sponsorUserId) =>
        api('POST', '/api/v1/members', {
          body: {
            user_id: userId,
            full_name: userId,
            email: `${userId.toLowerCase()}@test.local`,
            country_code: 'TR',
            sponsor_id: sponsorUserId ?? '',
            password: PASSWORD,
            skip_initial_order: true,
          },
        });

      const regResults = [await register(leaderId, null)];
      for (const cid of childIds) regResults.push(await register(cid, leaderId));
      const regOk = regResults.every((r) => [200, 201].includes(r.status));

      const volumes = childVolumes ?? Array(directCount).fill(directVol);
      for (const [i, cid] of childIds.entries()) {
        await api('PUT', `/api/v1/admin/members/${cid}`, {
          token: adminToken,
          body: {
            is_active: true,
            personal_volume: volumes[i],
            ...(levvameRoot && i === 0 ? { manual_career_override: 2 } : {}),
          },
        });
      }
      await api('PUT', `/api/v1/admin/members/${leaderId}`, {
        token: adminToken,
        body: { is_active: true, personal_volume: leaderVol },
      });

      const calc = await api('POST', '/api/v1/admin/career/calculate-active', {
        token: adminToken,
        body: { user_id: leaderId },
      });
      const snapLive = await snapshot();
      const leader = find(snapLive, leaderId);
      record(
        `Kariyer Canlı API — ${name}`,
        regOk && calc.status === 200 && leader?.active_career_level === expectLevel,
        `HTTP ${calc.status}, aktif seviye=${leader?.active_career_level} (beklenen ${expectLevel}), aktif direkt=${leader?.active_direct_referrals_30d}, PGV=${leader?.group_volume_30d}`
      );
    };

    const liveCases = [
      { key: 'LV2OK', name: 'Seviye 2: 10 aktif direkt, PGV 2000, kişisel 1000', directCount: 10, directVol: 200, leaderVol: 1000, expectLevel: 2 },
      { key: 'LV2NO9', name: 'Seviye 2 reddi: 9 aktif direkt, PGV 2250', directCount: 9, directVol: 250, leaderVol: 1000, expectLevel: 1 },
      { key: 'LV2NOVOL', name: 'Seviye 2 reddi: kişisel hacim 500', directCount: 10, directVol: 200, leaderVol: 500, expectLevel: 1 },
      {
        key: 'LV4BAL',
        name: 'Seviye 4 kol dengesi OK: 50 direkt × 200 (her kol %2), Levvâme kolu',
        directCount: 50,
        directVol: 200,
        leaderVol: 7500,
        levvameRoot: true,
        expectLevel: 4,
      },
      {
        key: 'LV4UNBAL',
        name: 'Seviye 4 kol dengesi reddi: tek kol 10000 (%100), diğer 49 kol 0, Levvâme kolu',
        directCount: 50,
        childVolumes: [10000, ...Array(49).fill(0)],
        leaderVol: 7500,
        levvameRoot: true,
        expectLevel: 3,
      },
      {
        key: 'LV4SINGLE20K',
        name: 'Seviye 4 kol dengesi reddi: tek kol 20000 (toplam 20000), Levvâme kolu',
        directCount: 50,
        childVolumes: [20000, ...Array(49).fill(0)],
        leaderVol: 7500,
        levvameRoot: true,
        expectLevel: 3,
      },
      {
        key: 'LV4SUBTHR',
        name: 'Seviye 4 reddi: toplam ciro 9000 < 10000 (kollar 4000/2500/2500), Levvâme kolu',
        directCount: 50,
        childVolumes: [4000, 2500, 2500, ...Array(47).fill(0)],
        leaderVol: 7500,
        levvameRoot: true,
        expectLevel: 3,
      },
    ];
    for (const c of liveCases) await liveCareerCase(c.key, c);

    const permanentLeaderId = `E2E-LV2OK-L-${stamp}`;
    const permanentLeaderBefore = find(await snapshot(), permanentLeaderId);
    await api('PUT', `/api/v1/admin/members/${permanentLeaderId}`, {
      token: adminToken,
      body: { is_active: false },
    });
    const permanenceRecalc = await api('POST', '/api/v1/admin/career/calculate-active', {
      token: adminToken,
      body: { user_id: permanentLeaderId },
    });
    const permanentLeaderAfter = find(await snapshot(), permanentLeaderId);
    record(
      'Kazanılmış kariyer pasif dönemde korunur',
      permanenceRecalc.status === 200 && permanentLeaderAfter?.max_career_level === permanentLeaderBefore?.max_career_level &&
        permanentLeaderAfter?.career_level === permanentLeaderBefore?.career_level &&
        permanentLeaderAfter?.career_title === permanentLeaderBefore?.career_title,
      `max ${permanentLeaderBefore?.max_career_level}→${permanentLeaderAfter?.max_career_level}, unvan ${permanentLeaderBefore?.career_title}→${permanentLeaderAfter?.career_title}`
    );

    // ---------- Adım 9: Bölgesel çekim (TR IBAN, SWIFT/SEPA, oturum bağlama, red iadesi) ----------
    const VALID_TR_IBAN = 'TR33 0006 1005 1978 6457 8413 26';
    const VALID_DE_IBAN = 'DE89370400440532013000';
    const BALANCE_KEY = { DOMESTIC: 'wallet_domestic_usd', INTERNATIONAL: 'wallet_international_usd' };
    const balanceOf = async (key, region) => find(await snapshot(), ids[key])?.wallets?.[BALANCE_KEY[region]];
    const requestWithdrawal = (token, body) => api('POST', '/api/v1/withdrawals', { token, body });

    const domBeforeTr = await balanceOf('B', 'DOMESTIC');
    const trReq = await requestWithdrawal(tokB, {
      amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı B', bank_name: 'Test Bank',
      iban: VALID_TR_IBAN, region: 'DOMESTIC', channel: 'TR_IBAN',
    });
    const trWd = trReq.json?.withdrawal;
    const domAfterTr = await balanceOf('B', 'DOMESTIC');
    record(
      'Yurtiçi TR IBAN çekimi oluşturuldu',
      trReq.status === 201 && trWd?.region === 'DOMESTIC' && trWd?.channel === 'TR_IBAN' && near(domBeforeTr - domAfterTr, 100),
      `HTTP ${trReq.status}, region=${trWd?.region}, channel=${trWd?.channel}, dom Δ=${(domAfterTr - domBeforeTr).toFixed(2)}`
    );

    const trInvoice = await api('POST', '/api/v1/tax-refunds/upload-invoice', {
      token: tokB,
      body: {
        user_id: ids.B,
        withdrawal_id: trWd?.id,
        invoice_file_name: 'test.pdf',
        invoice_file_type: 'application/pdf',
        invoice_data_url: 'data:application/pdf;base64,AA==',
        gross_withdrawal_amount: 999999,
        tax_deducted_amount: 999999,
      },
    });
    const missingWithdrawalDecision = await api('PUT', `/api/v1/admin/withdrawals/${trWd?.id}`, {
      token: adminToken,
      body: {},
    });
    const missingTaxDecision = await api('POST', `/api/v1/admin/tax-refunds/${trInvoice.json?.invoice?.id}/decision`, {
      token: adminToken,
      body: {},
    });
    const trReject = await api('PUT', `/api/v1/admin/withdrawals/${trWd?.id}`, { token: adminToken, body: { status: 'REJECTED' } });
    const domRefunded = await balanceOf('B', 'DOMESTIC');
    record(
      'Eksik yönetici kararı finansal işlem başlatmaz',
      missingWithdrawalDecision.status === 400 && missingTaxDecision.status === 400 &&
        trInvoice.json?.invoice?.status === 'PENDING_ADMIN_APPROVAL',
      `çekim kararı=${missingWithdrawalDecision.status}, vergi kararı=${missingTaxDecision.status}`
    );
    record(
      'Yurtiçi red sonrası tam tutar iade edildi, stopaj uygulanmadı',
      trReject.status === 200 && near(domRefunded, domBeforeTr) && near(trReject.json?.withdrawal?.tax_deduction, 0),
      `HTTP ${trReject.status}, dom bakiye=${domRefunded} (beklenen ${domBeforeTr}), stopaj=${trReject.json?.withdrawal?.tax_deduction}`
    );

    const rejectedInvoice = (await snapshot()).taxRefundInvoices?.find((invoice) => invoice.id === trInvoice.json?.invoice?.id);
    const approveRejectedInvoice = await api('POST', `/api/v1/admin/tax-refunds/${trInvoice.json?.invoice?.id}/decision`, {
      token: adminToken,
      body: { decision: 'APPROVED' },
    });
    const invoiceAfterRejectedWithdrawal = await api('POST', '/api/v1/tax-refunds/upload-invoice', {
      token: tokB,
      body: {
        user_id: ids.B,
        withdrawal_id: trWd?.id,
        invoice_file_name: 'late.pdf',
        invoice_file_type: 'application/pdf',
        invoice_data_url: 'data:application/pdf;base64,AA==',
      },
    });
    record(
      'Reddedilmiş çekime bağlı vergi iadesi kapatılır',
      trInvoice.status === 201 && near(trInvoice.json?.invoice?.gross_withdrawal_amount, 100) &&
        near(trInvoice.json?.invoice?.tax_deducted_amount, 20) && rejectedInvoice?.status === 'REJECTED' &&
        approveRejectedInvoice.status === 400 && invoiceAfterRejectedWithdrawal.status === 400,
      `fatura yükleme=${trInvoice.status}, durum=${rejectedInvoice?.status}, sonradan onay=${approveRejectedInvoice.status}, yeni fatura=${invoiceAfterRejectedWithdrawal.status}`
    );

    const intlBeforeSwift = await balanceOf('C', 'INTERNATIONAL');
    const swiftReq = await requestWithdrawal(tokC, {
      amount: 300, method: 'IBAN', holder_name: 'E2E Kullanıcı C', bank_name: 'Intl Bank',
      iban: VALID_DE_IBAN, region: 'INTERNATIONAL', channel: 'SWIFT', swift_code: 'deutdeff',
    });
    const swiftWd = swiftReq.json?.withdrawal;
    const intlAfterSwift = await balanceOf('C', 'INTERNATIONAL');
    record(
      'Yurt dışı SWIFT IBAN çekimi oluşturuldu',
      swiftReq.status === 201 && swiftWd?.region === 'INTERNATIONAL' && swiftWd?.channel === 'SWIFT' &&
        swiftWd?.bank_details?.swift_code === 'DEUTDEFF' && near(intlBeforeSwift - intlAfterSwift, 300),
      `HTTP ${swiftReq.status}, channel=${swiftWd?.channel}, swift=${swiftWd?.bank_details?.swift_code}, intl Δ=${(intlAfterSwift - intlBeforeSwift).toFixed(2)}`
    );

    const swiftReject = await api('PUT', `/api/v1/admin/withdrawals/${swiftWd?.id}`, { token: adminToken, body: { status: 'REJECTED' } });
    const intlRefunded = await balanceOf('C', 'INTERNATIONAL');
    record(
      'Yurt dışı red sonrası tam tutar iade edildi, stopaj uygulanmadı',
      swiftReject.status === 200 && near(intlRefunded, intlBeforeSwift) && near(swiftReject.json?.withdrawal?.tax_deduction, 0),
      `HTTP ${swiftReject.status}, intl bakiye=${intlRefunded} (beklenen ${intlBeforeSwift}), stopaj=${swiftReject.json?.withdrawal?.tax_deduction}`
    );

    const sepaReq = await requestWithdrawal(tokC, {
      amount: 50, method: 'IBAN', holder_name: 'E2E Kullanıcı C', bank_name: 'SEPA Bank',
      iban: VALID_DE_IBAN, region: 'INTERNATIONAL', channel: 'SEPA',
    });
    const sepaWd = sepaReq.json?.withdrawal;
    record(
      'Yurt dışı SEPA IBAN çekimi oluşturuldu',
      sepaReq.status === 201 && sepaWd?.channel === 'SEPA' && sepaWd?.region === 'INTERNATIONAL',
      `HTTP ${sepaReq.status}, channel=${sepaWd?.channel}`
    );

    const rejectedCases = [
      ['Geçersiz yurtiçi TR IBAN reddedildi', tokB, { amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı B', iban: 'TR12', region: 'DOMESTIC', channel: 'TR_IBAN' }, 'B'],
      ['TR IBAN checksum hatası reddedildi', tokB, { amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı B', iban: 'TR34 0006 1005 1978 6457 8413 26', region: 'DOMESTIC', channel: 'TR_IBAN' }, 'B'],
      ['Geçersiz uluslararası IBAN checksum reddedildi', tokC, { amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı C', iban: 'DE89370400440532013001', region: 'INTERNATIONAL', channel: 'SWIFT', swift_code: 'DEUTDEFF' }, 'C'],
      ['Geçersiz BIC reddedildi', tokC, { amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı C', iban: VALID_DE_IBAN, region: 'INTERNATIONAL', channel: 'SWIFT', swift_code: 'DEUT' }, 'C'],
      ['Ad-soyad uyuşmazlığı reddedildi', tokB, { amount: 100, method: 'IBAN', holder_name: 'Başka Kişi', iban: VALID_TR_IBAN, region: 'DOMESTIC', channel: 'TR_IBAN' }, 'B'],
    ];
    for (const [label, token, body, key] of rejectedCases) {
      const before = await balanceOf(key, body.region);
      const r = await requestWithdrawal(token, body);
      const after = await balanceOf(key, body.region);
      record(label, r.status === 400 && near(before, after), `HTTP ${r.status}, bakiye korundu=${near(before, after)}`);
    }

    const domBeforeAuth = await balanceOf('B', 'DOMESTIC');
    const noAuth = await api('POST', '/api/v1/withdrawals', {
      body: { amount: 100, method: 'IBAN', iban: VALID_TR_IBAN, region: 'DOMESTIC', channel: 'TR_IBAN' },
    });
    const spoofed = await requestWithdrawal(tokD, {
      user_id: ids.B, amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı B', iban: VALID_TR_IBAN, region: 'DOMESTIC', channel: 'TR_IBAN',
    });
    const domAfterAuth = await balanceOf('B', 'DOMESTIC');
    record(
      'Oturumsuz çekim reddedildi (401)',
      noAuth.status === 401 && noAuth.json?.code === 'MEMBER_AUTH_REQUIRED',
      `HTTP ${noAuth.status}, code=${noAuth.json?.code}`
    );
    record(
      'Başka bayi adına çekim (user_id spoof) reddedildi (403)',
      spoofed.status === 403 && spoofed.json?.code === 'PAYER_ID_MISMATCH' && near(domBeforeAuth, domAfterAuth),
      `HTTP ${spoofed.status}, code=${spoofed.json?.code}, B bakiye korundu=${near(domBeforeAuth, domAfterAuth)}`
    );

    const adminList = await api('GET', '/api/v1/admin/withdrawals', { token: adminToken });
    const listed = adminList.json?.data?.find((w) => w.id === swiftWd?.id);
    record(
      'Yönetici listesinde bölge, kanal ve SWIFT bilgisi görünür',
      adminList.status === 200 && listed?.region === 'INTERNATIONAL' && listed?.channel === 'SWIFT' &&
        listed?.bank_details?.swift_code === 'DEUTDEFF',
      `HTTP ${adminList.status}, region=${listed?.region}, channel=${listed?.channel}, swift=${listed?.bank_details?.swift_code}`
    );

    const noAdminDecision = await api('PUT', `/api/v1/admin/withdrawals/${sepaWd?.id}`, { body: { status: 'APPROVED' } });
    const sepaApprove = await api('PUT', `/api/v1/admin/withdrawals/${sepaWd?.id}`, { token: adminToken, body: { status: 'APPROVED' } });
    const sepaInvoice = await api('POST', '/api/v1/tax-refunds/upload-invoice', {
      token: tokC,
      body: {
        user_id: ids.C,
        withdrawal_id: sepaWd?.id,
        invoice_file_name: 'sepa.pdf',
        invoice_file_type: 'application/pdf',
        invoice_data_url: 'data:application/pdf;base64,AA==',
      },
    });
    const emptyTaxDecision = await api('POST', `/api/v1/admin/tax-refunds/${sepaInvoice.json?.invoice?.id}/decision`, {
      token: adminToken,
      body: {},
    });
    const sepaInvoiceState = (await snapshot()).taxRefundInvoices?.find((invoice) => invoice.id === sepaInvoice.json?.invoice?.id);
    record(
      'Eksik vergi kararı faturayı otomatik onaylamaz',
      sepaInvoice.status === 201 && emptyTaxDecision.status === 400 &&
        sepaInvoiceState?.status === 'PENDING_ADMIN_APPROVAL',
      `fatura=${sepaInvoice.status}, boş karar=${emptyTaxDecision.status}, durum=${sepaInvoiceState?.status}`
    );
    record(
      'Yönetici onayı yetkisiz erişime kapalı, yetkili onay kaydı APPROVED yapar',
      noAdminDecision.status === 401 && sepaApprove.status === 200 && sepaApprove.json?.withdrawal?.status === 'APPROVED',
      `yetkisiz HTTP ${noAdminDecision.status}, yetkili HTTP ${sepaApprove.status}`
    );

    // ---------- Adım 10: Aktiflik kapısı (süresi dolmuş bayi, alias, aktif süre üstüne alım) ----------
    const tokE = await login('E');
    await api('POST', '/api/v1/admin/member-activity-action', {
      token: adminToken,
      body: { user_id: ids.E, action: 'EXPIRE_NOW' },
    });
    const domBeforeE = await balanceOf('E', 'DOMESTIC');
    const expiredBody = { amount: 100, method: 'IBAN', holder_name: 'E2E Kullanıcı E', iban: VALID_TR_IBAN, region: 'DOMESTIC', channel: 'TR_IBAN' };
    const eCanonical = await api('POST', '/api/v1/user/withdrawal-request', { token: tokE, body: expiredBody });
    const eAlias = await requestWithdrawal(tokE, expiredBody);
    const domAfterE = await balanceOf('E', 'DOMESTIC');
    record(
      'Süresi dolmuş bayinin çekimi reddedildi (ana rota ve alias 403)',
      eCanonical.status === 403 && eCanonical.json?.code === 'WITHDRAWAL_CONDITION_NOT_MET' &&
        eAlias.status === 403 && eAlias.json?.code === 'WITHDRAWAL_CONDITION_NOT_MET' && near(domBeforeE, domAfterE),
      `ana rota HTTP ${eCanonical.status}, alias HTTP ${eAlias.status}, code=${eAlias.json?.code}; bakiye korundu=${near(domBeforeE, domAfterE)}`
    );

    const bStack0 = find(await snapshot(), ids.B);
    const bStackExp0 = new Date(bStack0.activity_expires_at).getTime();
    const bStackDom0 = bStack0.wallets.wallet_domestic_usd;
    const rStack = await api('POST', `/api/v1/members/${ids.B}/activity-action`, { token: tokB, body: { action: 'RENEW_PACKAGE' } });
    const bStack1 = find(await snapshot(), ids.B);
    const stackDays = (new Date(bStack1.activity_expires_at).getTime() - bStackExp0) / DAY_MS;
    const stackDom = bStack1.wallets.wallet_domestic_usd - bStackDom0;
    record(
      'Aktif süre varken ikinci alım aylık sınır olmadan kalan süreye +30 gün ekler',
      rStack.status === 200 && near(stackDom, -100) && stackDays > 29.5 && stackDays < 30.5,
      `HTTP ${rStack.status}; expiry Δ=${stackDays.toFixed(2)} gün; dom Δ=${stackDom.toFixed(2)}`
    );

    // ---------- Sonuç raporu ----------
    const failed = results.filter((r) => !r.pass).length;
    const lines = [
      '=== AKN GLOBAL GROUP E2E TEST SONUÇLARI ===',
      ...results.map((r) => `[${r.pass ? '✓' : '✗'}] ${r.label} — ${r.detail}`),
      '',
      failed === 0 ? 'TÜM TESTLER BAŞARIYLA TAMAMLANDI.' : `${failed} TEST BAŞARISIZ. Üretime hazır değil.`,
    ];
    const report = lines.join('\n');
    console.log('\n' + report);
    writeFileSync('test-results.md', '```\n' + report + '\n```\n');
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    server.kill();
  }
}

function sumCounters(m) {
  const w = m.wallets;
  return ['sponsor_wallet', 'monoline_wallet', 'career_pool_wallet', 'infinity_wallet', 'matching_wallet']
    .reduce((s, k) => s + (w[k] || 0), 0);
}

function buildCareerScenario({ directs, vol, inactive }) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 30 * DAY_MS).toISOString();
  const root = {
    user_id: 'R', full_name: 'R', global_line_id: 1, sponsor_id: null, career_level: 1, career_title: 'Emmâre',
    personal_volume: 5000, group_volume: 0, is_active: true, is_locked: false, activity_expires_at: future,
    joined_at: now, wallets: {},
  };
  const kids = Array.from({ length: directs }, (_, i) => ({
    user_id: `K${i}`, full_name: `K${i}`, global_line_id: i + 2, sponsor_id: 'R', career_level: 1,
    career_title: 'Emmâre', personal_volume: vol, group_volume: 0, is_active: i >= inactive,
    is_locked: false, activity_expires_at: future, joined_at: now, wallets: {},
  }));
  const evalResult = evaluateMemberOrganizationMetrics(root, [root, ...kids], INITIAL_CAREER_TIERS);
  return evalResult.target_active_level;
}

main().catch((err) => {
  console.error('E2E betiği beklenmeyen hata verdi:', err);
  process.exitCode = 1;
});
