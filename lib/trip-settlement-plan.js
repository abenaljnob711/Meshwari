'use strict';

const { calculateTripFinancialSnapshot } = require('./trip-payment-policy');

function buildTripSettlementPlan({ paymentMethod, fareAmount, commissionRate, currencyMinorUnit, tripId }) {
  if (!Number.isSafeInteger(Number(tripId)) || Number(tripId) <= 0) {
    throw new TypeError('A valid trip id is required');
  }
  if (!['cash', 'electronic'].includes(paymentMethod)) {
    throw new TypeError('Payment method must be cash or electronic');
  }
  const snapshot = calculateTripFinancialSnapshot({ fareAmount, commissionRate, currencyMinorUnit });
  const reference = 'trip:' + Number(tripId);
  if (paymentMethod === 'cash') {
    return {
      paymentMethod,
      snapshot,
      walletBalanceDelta: '-' + snapshot.commissionAmount,
      withdrawableBalanceDelta: '0',
      ledgerEntries: snapshot.commissionAmount === '0.00' || snapshot.commissionAmount === '0'
        ? []
        : [{
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
      ...(snapshot.driverNetAmount === '0.00' || snapshot.driverNetAmount === '0' ? [] : [{
        entryType: 'driver_settlement',
        amount: snapshot.driverNetAmount,
        referenceKey: reference + ':driver-settlement'
      }])
    ]
  };
}

module.exports = { buildTripSettlementPlan };
