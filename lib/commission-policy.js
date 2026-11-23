'use strict';

function parseCommissionRate(value) {
  if (value === undefined) return null;
  const raw = String(value).trim();
  if (!/^\d{1,3}(?:\\.\d{1,4})?$/.test(raw)) {
    throw new TypeError('Commission rate must be a decimal from 0 to 100 with up to four decimal places');
  }
  const rate = Number(raw);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new RangeError('Commission rate must be between 0 and 100');
  }
  return rate;
}

module.exports = { parseCommissionRate };
