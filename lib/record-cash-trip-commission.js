'use strict';

const { buildTripSettlementPlan } = require('./trip-settlement-plan');

async function recordCashTripCommission(client, trip) {
  if (!trip || trip.payment_method !== 'cash' || trip.status !== 'completed') {
    throw new TypeError('A completed cash trip is required');
  }
  const plan = buildTripSettlementPlan({
    tripId: trip.id,
    paymentMethod: 'cash',
    fareAmount: trip.fare_amount,
    commissionRate: trip.commission_rate_snapshot ?? '0',
    currencyMinorUnit: Number(trip.currency_minor_unit_snapshot)
  });
  for (const entry of plan.ledgerEntries) {
    const inserted = await client.query(
      `INSERT INTO mesh_trip_financial_ledger
       (trip_id,entry_type,amount,currency_code,reference_key,metadata,created_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,'system')
       ON CONFLICT(reference_key) DO NOTHING RETURNING id`,
      [trip.id,entry.entryType,entry.amount,trip.currency_code,entry.referenceKey,
       JSON.stringify({ paymentMethod:'cash', commissionRate:trip.commission_rate_snapshot })]
    );
    if (!inserted.rowCount) continue;
    await client.query(
      `INSERT INTO mesh_driver_wallet_accounts(driver_id,currency_code,balance)
       VALUES($1,$2,0) ON CONFLICT(driver_id,currency_code) DO NOTHING`,
      [trip.driver_id,trip.currency_code]
    );
    const wallet = await client.query(
      `UPDATE mesh_driver_wallet_accounts SET balance=balance-$3,updated_at=NOW()
       WHERE driver_id=$1 AND currency_code=$2 RETURNING balance`,
      [trip.driver_id,trip.currency_code,entry.amount]
    );
    if (!wallet.rowCount) throw new Error('Driver currency wallet not found while recording cash commission debt');
    await client.query(
      `INSERT INTO mesh_driver_wallet_transactions
       (driver_id,amount,balance_after,transaction_type,description,reference_key,created_by,currency_code)
       VALUES($1,$2,$3,'trip_commission_debt',$4,$5,'system',$6)`,
      [trip.driver_id,'-'+entry.amount,wallet.rows[0].balance,
       'عمولة مشواري المستحقة عن الرحلة رقم '+trip.id,entry.referenceKey,trip.currency_code]
    );
  }
  return plan;
}
module.exports = { recordCashTripCommission };
