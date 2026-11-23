'use strict';

const { buildTripSettlementPlan } = require('./trip-settlement-plan');

async function recordCashTripCommission(client, trip) {
  if (!trip || trip.payment_method !== 'cash') {
    throw new TypeError('Cash trip data is required');
  }
  if (trip.status !== 'completed') {
    throw new TypeError('Cash commission can only be recorded for a completed trip');
  }
  const plan = buildTripSettlementPlan({
    tripId: trip.id,
    paymentMethod: 'cash',
    fareAmount: trip.fare_amount,
    commissionRate: trip.commission_rate_snapshot ?? '0',
    currencyMinorUnit: Number(trip.currency_minor_unit_snapshot)
  });

  for (const entry of plan.ledgerEntries) {
    const ledger = await client.query(
      `INSERT INTO mesh_trip_financial_ledger
       (trip_id,entry_type,amount,currency_code,reference_key,metadata,created_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,'system')
       ON CONFLICT(reference_key) DO NOTHING RETURNING id`,
      [trip.id,entry.entryType,entry.amount,trip.currency_code,entry.referenceKey,
       JSON.stringify({ paymentMethod:'cash', commissionRate:trip.commission_rate_snapshot })]
    );
    if (!ledger.rowCount) continue;

    const wallet = await client.query(
      `UPDATE mesh_driver_profiles SET wallet_balance=wallet_balance-$1
       WHERE account_id=$2 RETURNING wallet_balance`,
      [entry.amount,trip.driver_id]
    );
    if (!wallet.rowCount) throw new Error('Driver wallet not found while recording cash commission debt');

    await client.query(
      `INSERT INTO mesh_driver_wallet_transactions
       (driver_id,amount,balance_after,transaction_type,description,reference_key,created_by)
       VALUES($1,$2,$3,'trip_commission_debt',$4,$5,'system')`,
      [trip.driver_id,'-'+entry.amount,wallet.rows[0].wallet_balance,
       'عمولة مشواري المستحقة عن الرحلة رقم '+trip.id,entry.referenceKey]
    );
  }
  return plan;
}

module.exports = { recordCashTripCommission };
