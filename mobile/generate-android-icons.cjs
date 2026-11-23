'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const [input, resourceRoot] = process.argv.slice(2);
  if (!input || !resourceRoot) {
    throw new Error('Usage: node generate-android-icons.cjs <512px-icon.png> <android-res-directory>');
  }
  if (!fs.existsSync(input)) throw new Error('Launcher icon source is missing: ' + input);
  const metadata = await sharp(input).metadata();
  if (metadata.format !== 'png' || metadata.width !== 512 || metadata.height !== 512) {
    throw new Error('Launcher icon must be a 512x512 PNG; received ' + metadata.width + 'x' + metadata.height + ' ' + metadata.format);
  }

  const densities = [
    { name: 'mdpi', legacy: 48, adaptive: 108, safe: 66 },
    { name: 'hdpi', legacy: 72, adaptive: 162, safe: 99 },
    { name: 'xhdpi', legacy: 96, adaptive: 216, safe: 132 },
    { name: 'xxhdpi', legacy: 144, adaptive: 324, safe: 198 },
    { name: 'xxxhdpi', legacy: 192, adaptive: 432, safe: 264 }
  ];

  for (const density of densities) {
    const dir = path.join(resourceRoot, 'mipmap-' + density.name);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
      await sharp(input).resize(density.legacy, density.legacy, { fit: 'contain' }).png().toFile(path.join(dir, name));
    }
    const foreground = await sharp(input)
      .resize(density.safe, density.safe, { fit: 'contain' })
      .png()
      .toBuffer();
    await sharp({
      create: {
        width: density.adaptive,
        height: density.adaptive,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    })
      .composite([{ input: foreground, gravity: 'centre' }])
      .png()
      .toFile(path.join(dir, 'ic_launcher_foreground.png'));
  }

  const adaptiveDir = path.join(resourceRoot, 'mipmap-anydpi-v26');
  fs.mkdirSync(adaptiveDir, { recursive: true });
  const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`;
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher.xml'), adaptiveXml);
  fs.writeFileSync(path.join(adaptiveDir, 'ic_launcher_round.xml'), adaptiveXml);

  const valuesDir = path.join(resourceRoot, 'values');
  fs.mkdirSync(valuesDir, { recursive: true });
  const colorsFile = path.join(valuesDir, 'ic_launcher_background.xml');
  fs.writeFileSync(colorsFile, `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#071421</color>
</resources>
`);

  console.log('Generated legacy and adaptive launcher icons in ' + resourceRoot);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
