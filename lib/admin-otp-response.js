'use strict';

function buildAdminOtpResponse(delivery, code) {
  if (delivery?.status === 'sent') {
    return {
      ok: true,
      delivery: 'sent',
      expiresInSeconds: 300,
      message: 'تم إرسال رمز التفعيل عبر واتساب. الرمز صالح لمدة 5 دقائق.'
    };
  }

  return {
    ok: true,
    delivery: delivery?.status || 'failed',
    reason: delivery?.reason || null,
    code,
    expiresInSeconds: 300,
    message: delivery?.status === 'manual'
      ? 'الإرسال التلقائي متوقف؛ سلّم الرمز يدوياً.'
      : 'تعذر الإرسال عبر واتساب؛ سلّم الرمز يدوياً.'
  };
}

module.exports = { buildAdminOtpResponse };
