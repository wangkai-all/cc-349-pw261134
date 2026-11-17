// 让 playwright 的 chromium 找到 .runtime 下本地解压的系统库与字体（在 spawn 浏览器前生效）。
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function ensureBrowserEnv() {
  // 浏览器本体也放在 .runtime 下（~/.cache 会被环境清理）
  const browsersPath = join(root, '.runtime', 'ms-playwright');
  if (existsSync(browsersPath) && !process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  }
  const base = join(root, '.runtime', 'syslibs');
  const dirs = [join(base, 'usr/lib/x86_64-linux-gnu'), join(base, 'lib/x86_64-linux-gnu')]
    .filter((d) => existsSync(d));
  if (dirs.length) {
    const cur = process.env.LD_LIBRARY_PATH ? process.env.LD_LIBRARY_PATH.split(':') : [];
    process.env.LD_LIBRARY_PATH = [...dirs, ...cur].join(':');
  }
  // fontconfig：无 /etc/fonts 的环境，指向 .runtime 内的配置与字体
  const fontsDir = join(base, 'usr/share/fonts');
  if (existsSync(fontsDir) && !process.env.FONTCONFIG_FILE) {
    const cacheDir = join(root, '.runtime', 'fontcache');
    mkdirSync(cacheDir, { recursive: true });
    const conf = join(root, '.runtime', 'fonts.conf');
    writeFileSync(conf, `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontsDir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>
`);
    process.env.FONTCONFIG_FILE = conf;
  }
}
