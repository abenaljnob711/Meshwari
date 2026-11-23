'use strict';

const { calculateTripFinancialSnapshot } = require('./trip-payment-policy');

function isZeroAmount(value) {
  return /^0(?:\.0+)?$/.test(String(value));
}

function buildTripSettlementPlan({ paymentMethod, fareAmount, commissionRate, currencyMinorUnit, tripId }) {
  const numericTripId = Number(tripId);
  if (!Number.isSafeInteger(numericTripId) || numericTripId <= 0) {
    throw new TypeError('A valid trip id is required');
  }
  if (!['cash', 'electronic'].includes(paymentMethod)) {
    throw new TypeError('Payment method must be cash or electronic');
  }

  const snapshot = calculateTripFinancialSnapshot({ fareAmount, commissionRate, currencyMinorUnit });
  const reference = 'trip:' + numericTripId;

  if (paymentMethod === 'cash') {
    return {
      paymentMethod,
      snapshot,
      walletBalanceDelta: '-' + snapshot.commissionAmount,
      withdrawableBalanceDelta: '0',
      ledgerEntries: isZeroAmount(snapshot.commissionAmount) ? [] : [{
        entryType: 'commission_debt',
        amount: snapshot.commissionAmount,
        referenceKey: reference + ':commission-debt'
      }]
    };
  }

  return {
    paymentMethod,
    snapshot,
    walletBalanceDelta: '0',
    withdrawableBalanceDelta: snapshot.driverNetAmount,
    ledgerEntries: [
      {
        entryType: 'electronic_collection',
        amount: snapshot.fareAmount,
        referenceKey: reference + ':electronic-collection'
      },
      ...(isZeroAmount(snapshot.driverNetAmount) ? [] : [{
        entryType: 'driver_settlement',
        amount: snapshot.driverNetAmount,
        referenceKey: reference + ':driver-settlement'
      }])
    ]
  };
}

module.exports = { buildTripSettlementPlan };
