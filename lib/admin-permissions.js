'use strict';

function adminPermissionForRequest(req) {
  const path = String(req.path || '');
  const method = String(req.method || 'GET').toUpperCase();

  if (path === '/api/admin/whatsapp/settings' &&
      (method === 'GET' || method === 'PUT')) return 'manage_whatsapp_settings';
  if (path === '/api/admin/otp-eligible-accounts' && method === 'GET') return 'issue_otp';
  if (/^\/api\/admin\/accounts\/\d+\/issue-code$/.test(path) && method === 'POST') return 'issue_otp';
  if (path === '/api/admin/me' && method === 'GET') return null;

  return '__owner_only__';
}

module.exports = { adminPermissionForRequest };
