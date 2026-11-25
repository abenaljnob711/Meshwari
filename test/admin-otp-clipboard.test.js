'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('admin-issued activation code remains visible and copyable', () => {
  const admin = fs.readFileSync(require.resolve('../public/admin.html'), 'utf8');
  assert.match(admin, /window\.issue=async id=>/);
  assert.match(admin, /window\.showIssuedOtp=\(code,delivery\)=>/);
  assert.match(admin, /نسخ الرمز/);
  assert.match(admin, /window\.MeshwariClipboard\?\.writeText\(code\)/);
  assert.match(admin, /navigator\.clipboard\?\.writeText/);
  assert.match(admin, /document\.execCommand\('copy'\)/);
  assert.match(admin, /الرمز محدد؛ اضغط مطولاً عليه واختر «نسخ»/);
});

test('admin APK includes clipboard bridge but excludes native Firebase Push', () => {
  const workflow = fs.readFileSync(require.resolve('../.github/workflows/build-apk.yml'), 'utf8');
  const start = workflow.indexOf('      - name: Prepare admin application');
  const end = workflow.indexOf('      - name: Create passenger Android project', start);
  assert.ok(start >= 0 && end > start, 'admin build section exists');
  const section = workflow.slice(start, end);
  assert.match(section, /clipboard-bundle\.js/);
  assert.match(section, /Admin app must not contain native Firebase Push code/);
});
