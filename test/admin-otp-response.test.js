'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAdminOtpResponse } = require('../lib/admin-otp-response');

test('successful WhatsApp delivery never returns the OTP to the admin client', () => {
  const response = buildAdminOtpResponse({ status: 'sent', messageId: 'provider-message-1' }, '482951');
  assert.equal(response.delivery, 'sent');
  assert.equal(response.expiresInSeconds, 300);
  assert.equal(Object.hasOwn(response, 'code'), false);
});

test('manual fallback returns the OTP for handoff when WhatsApp is unavailable', () => {
  const response = buildAdminOtpResponse({ status: 'manual', reason: 'disabled' }, '482951');
  assert.equal(response.delivery, 'manual');
  assert.equal(response.code, '482951');
  assert.equal(response.reason, 'disabled');
});
