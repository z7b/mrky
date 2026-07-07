import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const tinyPngHex = '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082';
const pngBuffer = Buffer.from(tinyPngHex, 'hex');

const iconDir = 'public/icons';
mkdirSync(iconDir, { recursive: true });

writeFileSync(join(iconDir, 'icon16.png'), pngBuffer);
writeFileSync(join(iconDir, 'icon48.png'), pngBuffer);
writeFileSync(join(iconDir, 'icon128.png'), pngBuffer);

console.log('✅ Created placeholder icons in public/icons/');
