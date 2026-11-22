'use strict';

const crypto = require('crypto');

function createTripCallIceServers({ turnUrls = '', sharedSecret = '', userId, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const urls = String(turnUrls || '').split(',').map(value => value.trim()).filter(Boolean);
  const secret = String(sharedSecret || '');

  if (urls.length && secret) {
    const expiry = Math.floor(Number(nowSeconds)) + 12 * 60 * 60;
    const username = expiry + ':' + String(userId);
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    iceServers.push({ urls, username, credential });
  }

  return iceServers;
}

module.exports = { createTripCallIceServers };
