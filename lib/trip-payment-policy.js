'use strict';

const COUNTRY_DEFAULTS = Object.freeze({
  YE: Object.freeze({ cashEnabled: true, electronicEnabled: false }),
  DEFAULT: Object.freeze({ cashEnabled: true, electronicEnabled: true })
});

function resolveCountryPaymentPolicy(countryCode, cashEnabled, electronicEnabled) {
  const code = String(countryCode || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) throw new TypeError('A valid ISO country code is required');
  const defaults = COUNTRY_DEFAULTS[code] || COUNTRY_DEFAULTS.DEFAULT;
  const cash = cashEnabled === null || cashEnabled === undefined ? defaults.cashEnabled : cashEnabled;
  const electronic = electronicEnabled === null || electronicEnabled === undefined ? defaults.electronicEnabled : electronicEnabled;
  if (typeof cash !== 'boolean' || typeof electronic !== 'boolean') {
    throw new TypeError('Country payment switches must be booleans or null');
  }
  if (!cash && !electronic) throw new RangeError('At least one payment method must be enabled');
  return { countryCode: code, cashEnabled: cash, electronicEnabled: electronic };
}

function decimalToMinorUnits(value, minorUnit, fieldName) {
  if (!Number.isInteger(minorUnit) || minorUnit < 0 || minorUnit > 4) {
    throw new RangeError('Currency minor unit must be an integer from 0 to 4');
  }
  const raw = String(value ?? '').trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw);
  const suppliedFraction = match?.[2] || '';
  if (!match || (suppliedFraction.length > minorUnit &&
      /[1-9]/.test(suppliedFraction.slice(minorUnit)))) {
    throw new TypeError(fieldName + ' must be a non-negative decimal with valid currency precision');
  }
  // PostgreSQL NUMERIC(18,4) pads values with trailing zeros. Those zeros
  // do not increase the amount's precision for a currency with fewer decimals.
  const fraction = suppliedFraction.slice(0, minorUnit).padEnd(minorUnit, '0');
  return BigInt(match[1]) * (10n ** BigInt(minorUnit)) + BigInt(fraction || '0');
}

function minorUnitsToDecimal(value, minorUnit) {
  const amount = BigInt(value);
  const scale = 10n ** BigInt(minorUnit);
  const whole = amount / scale;
  if (minorUnit === 0) return whole.toString();
  return whole.toString() + '.' + (amount % scale).toString().padStart(minorUnit, '0');
}

function calculateTripFinancialSnapshot({ fareAmount, commissionRate, currencyMinorUnit }) {
  const fareMinor = decimalToMinorUnits(fareAmount, currencyMinorUnit, 'Fare');
  const rateRaw = String(commissionRate ?? '0').trim();
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(rateRaw)) {
    throw new TypeError('Commission rate must be from 0 to 100 with up to four decimal places');
  }
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new RangeError('Commission rate must be from 0 to 100');
  const fractionDigits = rateRaw.includes('.') ? rateRaw.length - rateRaw.indexOf('.') - 1 : 0;
  const rateScaled = BigInt(rateRaw.replace('.', '').padEnd(rateRaw.replace('.', '').length + 4 - fractionDigits, '0'));
  const denominator = 1000000n;
  const commissionMinor = (fareMinor * rateScaled + denominator / 2n) / denominator;
  const driverNetMinor = fareMinor - commissionMinor;
  return {
    fareAmount: minorUnitsToDecimal(fareMinor, currencyMinorUnit),
    commissionAmount: minorUnitsToDecimal(commissionMinor, currencyMinorUnit),
    driverNetAmount: minorUnitsToDecimal(driverNetMinor, currencyMinorUnit)
  };
}

function validateTripPaymentMethod(policy, paymentMethod) {
  if (!['cash', 'electronic'].includes(paymentMethod)) {
    throw new TypeError('Payment method must be cash or electronic');
  }
  if (paymentMethod === 'cash' && !policy.cashEnabled) throw new RangeError('Cash payment is disabled in this country');
  if (paymentMethod === 'electronic' && !policy.electronicEnabled) throw new RangeError('Electronic payment is disabled in this country');
  return paymentMethod;
}

module.exports = {
  resolveCountryPaymentPolicy,
  calculateTripFinancialSnapshot,
  validateTripPaymentMethod,
  decimalToMinorUnits,
  minorUnitsToDecimal
};
