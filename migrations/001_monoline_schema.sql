-- ============================================================================
-- PROJE: Monoline 7 Nefis Mertebesi MLM & Back-Office Sistemi Entegrasyonu
-- MIGRATION: 001_monoline_schema.sql (PostgreSQL 15+)
-- ============================================================================

BEGIN;

-- ENUM Tipleri
DO $$ BEGIN
    CREATE TYPE commission_log_type AS ENUM ('SPONSOR', 'MONOLINE_DEPTH', 'SYSTEM_POOL');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE payout_method_type AS ENUM ('IBAN', 'TRC20');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE withdrawal_status_type AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 1. users Tablosu (Monoline Küresel Tek Hat Mantığıyla)
CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    external_app_user_id VARCHAR(100) UNIQUE NOT NULL, -- Mevcut uygulamadaki üye ID'si
    sponsor_id BIGINT REFERENCES users(id) ON DELETE SET NULL, -- Direkt davet eden kişi
    monoline_position BIGSERIAL UNIQUE NOT NULL, -- Sisteme giriş sırasına göre artan küresel sıralama ID'si
    career_level SMALLINT NOT NULL DEFAULT 1 CHECK (career_level BETWEEN 1 AND 7), -- 1: Emmâre, 2: Levvâme, ..., 7: Kâmile
    ref_code VARCHAR(32) UNIQUE NOT NULL, -- Sosyal paylaşım ve QR kod için üretilen kod
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_monoline_position ON users(monoline_position);
CREATE INDEX IF NOT EXISTS idx_users_sponsor_id ON users(sponsor_id);

-- 2. wallets Tablosu (Atomik Bakiye ve Ödeme Yöntemleri)
CREATE TABLE IF NOT EXISTS wallets (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance DECIMAL(15,2) NOT NULL DEFAULT 0.00, -- Çekilebilir bakiye
    pending_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00, -- Bekleyen bakiye
    system_fund_balance DECIMAL(15,2) NOT NULL DEFAULT 0.00, -- Yalnızca Sistem / Şirket hesabında biriken %50'lik fon
    iban TEXT, -- Kullanıcının kaydettiği IBAN ödeme yöntemi
    crypto_trc20 TEXT, -- Kullanıcının kaydettiği USDT (TRC20) cüzdan adresi
    total_withdrawn DECIMAL(15,2) NOT NULL DEFAULT 0.00,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. commission_logs Tablosu (Idempotency ve Dağıtım Kayıtları)
CREATE TABLE IF NOT EXISTS commission_logs (
    id BIGSERIAL PRIMARY KEY,
    order_id VARCHAR(100) NOT NULL, -- Dış uygulamadan gelen benzersiz sipariş numarası
    source_user_id BIGINT NOT NULL REFERENCES users(id), -- Alışverişi yapan üye
    target_user_id BIGINT REFERENCES users(id), -- Komisyonu kazanan üye (Sistem havuzu için Kök/Şirket ID)
    type commission_log_type NOT NULL, -- Enum: 'SPONSOR', 'MONOLINE_DEPTH', 'SYSTEM_POOL'
    depth_level INT CHECK (depth_level IS NULL OR (depth_level BETWEEN 1 AND 7)), -- 1 ile 7 arası derinlik seviyesi
    amount DECIMAL(15,2) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency: Aynı order_id, type ve depth_level ile mükerrer kayıt engeli
CREATE UNIQUE INDEX IF NOT EXISTS idx_commission_logs_idempotency
    ON commission_logs(order_id, type, COALESCE(depth_level, 0));

CREATE INDEX IF NOT EXISTS idx_commission_logs_order_id ON commission_logs(order_id);
CREATE INDEX IF NOT EXISTS idx_commission_logs_target_user_id ON commission_logs(target_user_id);

-- 4. withdrawal_requests Tablosu (IBAN & TRC20 Nakit Çekim Talepleri)
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount DECIMAL(15,2) NOT NULL CHECK (amount > 0),
    payout_method payout_method_type NOT NULL, -- Enum: 'IBAN', 'TRC20'
    payout_address TEXT NOT NULL,
    bank_details JSONB,
    status withdrawal_status_type NOT NULL DEFAULT 'PENDING', -- Enum: 'PENDING', 'APPROVED', 'REJECTED'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user_status ON withdrawal_requests(user_id, status);

COMMIT;
