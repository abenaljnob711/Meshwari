'use strict';

// Schema-only foundation for per-country pricing and immutable trip price snapshots.
// All new financial fields are nullable: no country price, currency, or commission
// is invented, and existing trips retain their historical values unchanged.
const migrations = [
  {
    id: '001_country_pricing_snapshots',
    sql: `
      ALTER TABLE mesh_service_countries
        ADD COLUMN currency_code CHAR(3),
        ADD COLUMN currency_minor_unit SMALLINT,
        ADD COLUMN base_fare NUMERIC(12,2),
        ADD COLUMN per_km_rate NUMERIC(12,2);

      ALTER TABLE mesh_service_countries
        ADD CONSTRAINT mesh_service_countries_currency_code_check
          CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT mesh_service_countries_currency_minor_unit_check
          CHECK (currency_minor_unit IS NULL OR currency_minor_unit BETWEEN 0 AND 4),
        ADD CONSTRAINT mesh_service_countries_base_fare_check
          CHECK (base_fare IS NULL OR base_fare >= 0),
        ADD CONSTRAINT mesh_service_countries_per_km_rate_check
          CHECK (per_km_rate IS NULL OR per_km_rate >= 0);

      ALTER TABLE mesh_trips
        ADD COLUMN country_code CHAR(2),
        ADD COLUMN currency_code CHAR(3),
        ADD COLUMN base_fare_snapshot NUMERIC(12,2),
        ADD COLUMN per_km_rate_snapshot NUMERIC(12,2),
        ADD COLUMN commission_rate_snapshot NUMERIC(7,4);

      ALTER TABLE mesh_trips
        ADD CONSTRAINT mesh_trips_country_code_fk
          FOREIGN KEY (country_code) REFERENCES mesh_service_countries(country_code),
        ADD CONSTRAINT mesh_trips_currency_code_check
          CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
        ADD CONSTRAINT mesh_trips_base_fare_snapshot_check
          CHECK (base_fare_snapshot IS NULL OR base_fare_snapshot >= 0),
        ADD CONSTRAINT mesh_trips_per_km_rate_snapshot_check
          CHECK (per_km_rate_snapshot IS NULL OR per_km_rate_snapshot >= 0),
        ADD CONSTRAINT mesh_trips_commission_rate_snapshot_check
          CHECK (commission_rate_snapshot IS NULL OR commission_rate_snapshot >= 0);
    `
  },
  {
    id: '002_trip_financial_foundation',
    sql: `
      ALTER TABLE mesh_service_countries
        ADD COLUMN commission_rate NUMERIC(7,4),
        ADD COLUMN cash_enabled BOOLEAN,
        ADD COLUMN electronic_enabled BOOLEAN;

      ALTER TABLE mesh_service_countries
        ADD CONSTRAINT mesh_service_countries_commission_rate_check
          CHECK (commission_rate IS NULL OR commission_rate BETWEEN 0 AND 100);

      ALTER TABLE mesh_trips
        ADD COLUMN currency_minor_unit_snapshot SMALLINT,
        ADD COLUMN payment_method VARCHAR(20),
        ADD COLUMN payment_provider VARCHAR(80),
        ADD COLUMN commission_amount_snapshot NUMERIC(12,2),
        ADD COLUMN driver_net_amount_snapshot NUMERIC(12,2);

      ALTER TABLE mesh_trips
        ADD CONSTRAINT mesh_trips_currency_minor_unit_snapshot_check
          CHECK (currency_minor_unit_snapshot IS NULL OR currency_minor_unit_snapshot BETWEEN 0 AND 4),
        ADD CONSTRAINT mesh_trips_payment_method_check
          CHECK (payment_method IS NULL OR payment_method IN ('cash','electronic')),
        ADD CONSTRAINT mesh_trips_commission_amount_snapshot_check
          CHECK (commission_amount_snapshot IS NULL OR commission_amount_snapshot >= 0),
        ADD CONSTRAINT mesh_trips_driver_net_amount_snapshot_check
          CHECK (driver_net_amount_snapshot IS NULL OR driver_net_amount_snapshot >= 0);

      CREATE TABLE mesh_trip_financial_ledger (
        id BIGSERIAL PRIMARY KEY,
        trip_id BIGINT NOT NULL REFERENCES mesh_trips(id),
        entry_type VARCHAR(40) NOT NULL
          CHECK (entry_type IN ('commission_debt','commission_collection','electronic_collection',
            'driver_settlement','refund','reversal','adjustment')),
        amount NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
        currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
        reference_key VARCHAR(180) NOT NULL UNIQUE,
        related_reference VARCHAR(180),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by VARCHAR(80),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX mesh_trip_financial_ledger_trip_idx
        ON mesh_trip_financial_ledger(trip_id,created_at,id);

      CREATE TABLE mesh_trip_payment_attempts (
        id BIGSERIAL PRIMARY KEY,
        trip_id BIGINT NOT NULL REFERENCES mesh_trips(id),
        provider VARCHAR(80) NOT NULL,
        idempotency_key VARCHAR(180) NOT NULL UNIQUE,
        amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
        currency_code CHAR(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','authorized','captured','failed','cancelled','refunded')),
        provider_payment_id VARCHAR(180),
        failure_code VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX mesh_trip_payment_attempts_trip_idx
        ON mesh_trip_payment_attempts(trip_id,created_at DESC);

      CREATE TABLE mesh_payment_webhook_events (
        id BIGSERIAL PRIMARY KEY,
        provider VARCHAR(80) NOT NULL,
        provider_event_id VARCHAR(180) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        processed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(provider,provider_event_id)
      );
    `
  }
];

module.exports = { migrations };
