#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) throw new Error('Pass an existing Android app/build.gradle path');
const run = Number(process.env.GITHUB_RUN_NUMBER || process.env.MESHWARI_VERSION_CODE || 1);
if (!Number.isSafeInteger(run) || run < 1 || run > 2100000000) throw new Error('Android versionCode must be a positive integer <= 2100000000');
const versionName = process.env.MESHWARI_VERSION_NAME || ('1.0.' + run);
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(versionName)) throw new Error('MESHWARI_VERSION_NAME must look like 1.2.3');
let gradle = fs.readFileSync(file, 'utf8');
const match = gradle.match(/defaultConfig\s*\{/);
if (!match) throw new Error('defaultConfig block not found in ' + file);
const start = match.index + match[0].length;
let depth = 1, end = start;
for (; end < gradle.length && depth; end++) {
  if (gradle[end] === '{') depth++;
  else if (gradle[end] === '}') depth--;
}
if (depth !== 0) throw new Error('Unbalanced defaultConfig block in ' + file);
let block = gradle.slice(start, end - 1);
if (/\bversionCode\s+\d+/.test(block)) block = block.replace(/\bversionCode\s+\d+/, 'versionCode ' + run);
else block += '\n        versionCode ' + run;
if (/\bversionName\s+["'][^"']*["']/.test(block)) block = block.replace(/\bversionName\s+["'][^"']*["']/, 'versionName "' + versionName + '"');
else block += '\n        versionName "' + versionName + '"';
gradle = gradle.slice(0, start) + block + gradle.slice(end - 1);
fs.writeFileSync(file, gradle);
console.log(path.basename(file) + ': versionCode=' + run + ', versionName=' + versionName);
