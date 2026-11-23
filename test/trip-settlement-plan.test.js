'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTripSettlementPlan } = require('../lib/trip-settlement-plan');

test('cash trip records commission as driver debt without releasing withdrawable funds', () => {
  const plan = buildTripSettlementPlan({
    tripId: 42, paymentMethod: 'cash', fareAmount: '100.00',
    commissionRate: '10', currencyMinorUnit: 2
  });
  assert.deepEqual(plan.snapshot, {
    fareAmount: '100.00', commissionAmount: '10.00', driverNetAmount: '90.00'
  });
  assert.equal(plan.walletBalanceDelta, '-10.00');
  assert.equal(plan.withdrawableBalanceDelta, '0');
  assert.deepEqual(plan.ledgerEntries, [{
    entryType: 'commission_debt', amount: '10.00',
    referenceKey: 'trip:42:commission-debt'
  }]);
});

test('electronic trip collects fare and settles only the driver net amount', () => {
  const plan = buildTripSettlementPlan({
    tripId: 43, paymentMethod: 'electronic', fareAmount: '100.00',
    commissionRate: '10', currencyMinorUnit: 2
  });
  assert.equal(plan.walletBalanceDelta, '0');
  assert.equal(plan.withdrawableBalanceDelta, '90.00');
  assert.deepEqual(plan.ledgerEntries, [
    { entryType: 'electronic_collection', amount: '100.00', referenceKey: 'trip:43:electronic-collection' },
    { entryType: 'driver_settlement', amount: '90.00', referenceKey: 'trip:43:driver-settlement' }
  ]);
});

test('zero commission and zero driver net do not create zero-value ledger rows', () => {
  const cash = buildTripSettlementPlan({
    tripId: 44, paymentMethod: 'cash', fareAmount: '100',
    commissionRate: '0', currencyMinorUnit: 0
  });
  assert.deepEqual(cash.ledgerEntries, []);
  const electronic = buildTripSettlementPlan({
    tripId: 45, paymentMethod: 'electronic', fareAmount: '100',
    commissionRate: '100', currencyMinorUnit: 0
  });
  assert.deepEqual(electronic.ledgerEntries, [{
    entryType: 'electronic_collection', amount: '100',
    referenceKey: 'trip:45:electronic-collection'
  }]);
});

test('settlement plan rejects invalid trip ids and payment methods', () => {
  const common = { fareAmount: '10.00', commissionRate: '5', currencyMinorUnit: 2 };
  assert.throws(() => buildTripSettlementPlan({ ...common, tripId: 0, paymentMethod: 'cash' }), /trip id/);
  assert.throws(() => buildTripSettlementPlan({ ...common, tripId: 1, paymentMethod: 'crypto' }), /Payment method/);
});
