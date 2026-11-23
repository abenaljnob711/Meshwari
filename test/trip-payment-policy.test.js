'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCountryPaymentPolicy,
  calculateTripFinancialSnapshot,
  validateTripPaymentMethod,
  decimalToMinorUnits,
  minorUnitsToDecimal
} = require('../lib/trip-payment-policy');

test('Yemen defaults to cash while other countries default to cash and electronic', () => {
  assert.deepEqual(resolveCountryPaymentPolicy('ye', null, null), {
    countryCode: 'YE', cashEnabled: true, electronicEnabled: false
  });
  assert.deepEqual(resolveCountryPaymentPolicy('SA', null, null), {
    countryCode: 'SA', cashEnabled: true, electronicEnabled: true
  });
});

test('country payment policy honors explicit admin switches and requires one method', () => {
  assert.deepEqual(resolveCountryPaymentPolicy('YE', true, true), {
    countryCode: 'YE', cashEnabled: true, electronicEnabled: true
  });
  assert.throws(() => resolveCountryPaymentPolicy('SA', false, false), /At least one/);
  assert.throws(() => resolveCountryPaymentPolicy('YEM', true, false), /ISO country code/);
});

test('payment method validation rejects disabled or unknown methods', () => {
  const yemen = resolveCountryPaymentPolicy('YE', null, null);
  assert.equal(validateTripPaymentMethod(yemen, 'cash'), 'cash');
  assert.throws(() => validateTripPaymentMethod(yemen, 'electronic'), /disabled/);
  assert.throws(() => validateTripPaymentMethod(yemen, 'crypto'), /cash or electronic/);
});

test('trip financial snapshot calculates commission and driver net with exact currency precision', () => {
  assert.deepEqual(calculateTripFinancialSnapshot({
    fareAmount: '1000.00', commissionRate: '7.5', currencyMinorUnit: 2
  }), {
    fareAmount: '1000.00', commissionAmount: '75.00', driverNetAmount: '925.00'
  });
  assert.deepEqual(calculateTripFinancialSnapshot({
    fareAmount: '10.00', commissionRate: '100', currencyMinorUnit: 2
  }), {
    fareAmount: '10.00', commissionAmount: '10.00', driverNetAmount: '0.00'
  });
  assert.deepEqual(calculateTripFinancialSnapshot({
    fareAmount: '100', commissionRate: '12.3456', currencyMinorUnit: 0
  }), {
    fareAmount: '100', commissionAmount: '12', driverNetAmount: '88'
  });
});

test('financial snapshot rejects invalid precision, negative fare and out-of-range commission', () => {
  assert.throws(() => calculateTripFinancialSnapshot({
    fareAmount: '1.001', commissionRate: '5', currencyMinorUnit: 2
  }), /precision/);
  assert.throws(() => calculateTripFinancialSnapshot({
    fareAmount: '-1', commissionRate: '5', currencyMinorUnit: 2
  }), /non-negative/);
  assert.throws(() => calculateTripFinancialSnapshot({
    fareAmount: '10', commissionRate: '100.1', currencyMinorUnit: 2
  }), /from 0 to 100/);
});

test('exact minor-unit arithmetic handles four-decimal country pricing', () => {
  const base = decimalToMinorUnits('1.2500', 4, 'Base fare');
  const rate = decimalToMinorUnits('0.3750', 4, 'Per-kilometer rate');
  const distanceTenths = 123n;
  const total = base + (rate * distanceTenths + 5n) / 10n;
  assert.equal(minorUnitsToDecimal(total, 4), '5.8625');
  assert.throws(() => decimalToMinorUnits('1.25001', 4, 'Base fare'), /precision/);
});
