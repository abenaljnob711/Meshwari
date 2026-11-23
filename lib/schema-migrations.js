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
  }
];

module.exports = { migrations };
