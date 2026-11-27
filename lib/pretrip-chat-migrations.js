'use strict';

// Temporary passenger/driver fare-negotiation chats. A trip is created only
// after the passenger confirms the driver's stored fare agreement.
const migrations = [
  {
    id: '007_temporary_pretrip_chats',
    sql: `
      CREATE TABLE mesh_pretrip_chats (
        id BIGSERIAL PRIMARY KEY,
        passenger_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
        driver_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
        status VARCHAR(20) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','agreed','converted','cancelled','expired')),
        pickup_address TEXT NOT NULL,
        dropoff_address TEXT NOT NULL,
        pickup_lat DOUBLE PRECISION NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
        pickup_lng DOUBLE PRECISION NOT NULL CHECK (pickup_lng BETWEEN -180 AND 180),
        dropoff_lat DOUBLE PRECISION NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
        dropoff_lng DOUBLE PRECISION NOT NULL CHECK (dropoff_lng BETWEEN -180 AND 180),
        stops JSONB NOT NULL DEFAULT '[]'::jsonb
          CHECK (jsonb_typeof(stops) = 'array'),
        CONSTRAINT mesh_pretrip_chats_stops_count_check
          CHECK (CASE WHEN jsonb_typeof(stops) = 'array' THEN jsonb_array_length(stops) <= 5 ELSE FALSE END),
        vehicle_class VARCHAR(80),
        agreed_fare NUMERIC(18,4),
        currency_code CHAR(3),
        currency_minor_unit SMALLINT,
        agreed_by_driver_at TIMESTAMPTZ,
        converted_trip_id BIGINT REFERENCES mesh_trips(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
        CONSTRAINT mesh_pretrip_chats_distinct_participants CHECK (passenger_id <> driver_id),
        CONSTRAINT mesh_pretrip_chats_fare_check CHECK (agreed_fare IS NULL OR agreed_fare > 0),
        CONSTRAINT mesh_pretrip_chats_currency_check CHECK (
          (currency_code IS NULL AND currency_minor_unit IS NULL) OR
          (currency_code IS NOT NULL AND currency_minor_unit IS NOT NULL
            AND currency_code ~ '^[A-Z]{3}$' AND currency_minor_unit BETWEEN 0 AND 4)
        ),
        CONSTRAINT mesh_pretrip_chats_agreement_state_check CHECK (
          (status <> 'agreed') OR
          (agreed_fare IS NOT NULL AND currency_code IS NOT NULL
            AND currency_minor_unit IS NOT NULL AND agreed_by_driver_at IS NOT NULL)
        ),
        CONSTRAINT mesh_pretrip_chats_converted_state_check CHECK (
          (status = 'converted' AND converted_trip_id IS NOT NULL) OR
          (status <> 'converted' AND converted_trip_id IS NULL)
        )
      );

      CREATE UNIQUE INDEX mesh_pretrip_chats_one_passenger_open_idx
        ON mesh_pretrip_chats(passenger_id)
        WHERE status IN ('open','agreed');
      CREATE UNIQUE INDEX mesh_pretrip_chats_one_driver_open_idx
        ON mesh_pretrip_chats(driver_id)
        WHERE status IN ('open','agreed');
      CREATE INDEX mesh_pretrip_chats_expiry_idx
        ON mesh_pretrip_chats(expires_at)
        WHERE status IN ('open','agreed');
      CREATE INDEX mesh_pretrip_chats_participant_idx
        ON mesh_pretrip_chats(passenger_id,created_at DESC);

      CREATE TABLE mesh_pretrip_chat_messages (
        id BIGSERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL REFERENCES mesh_pretrip_chats(id) ON DELETE CASCADE,
        sender_id BIGINT NOT NULL REFERENCES mesh_accounts(id) ON DELETE CASCADE,
        message VARCHAR(1000) NOT NULL CHECK (length(trim(message)) BETWEEN 1 AND 1000),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
      );
      CREATE INDEX mesh_pretrip_chat_messages_chat_idx
        ON mesh_pretrip_chat_messages(chat_id,created_at,id);
      CREATE INDEX mesh_pretrip_chat_messages_expiry_idx
        ON mesh_pretrip_chat_messages(expires_at);
    `
  }
];

module.exports = { migrations };
