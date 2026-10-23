// 把 codenotes/ 的网页源码复制到 mobile/www/，供 Capacitor 打包
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');        // codenotes/
const dest = join(here, '..', 'www');      // mobile/www

const FILES = [
  'index.html',
  'styles.css',
  'app.js',
  'zip.js',
  'highlight.js',
  'manifest.webmanifest',
  'sw.js',
  'icon.svg',
  'icon.jpg',
  'demo-project.zip',
  'vendor/pdf.min.js',
  'vendor/pdf.worker.min.js'
];

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
for (const f of FILES) {
  const target = join(dest, f);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(src, f), target);
}
console.log(`[copy-web] ${FILES.length} 个文件 → mobile/www/`);
