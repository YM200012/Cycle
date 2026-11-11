import packager from '@electron/packager';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
const result = await packager({
  dir: root,
  out: path.join(root, 'release', 'v'+manifest.version),
  name: 'Cycle',
  executableName: 'Cycle',
  appBundleId: 'local.cycle.training',
  appVersion: manifest.version,
  icon: path.join(root, 'assets', process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
  platform: process.platform,
  arch: process.arch,
  electronVersion: '39.2.7',
  ...(process.env.CYCLE_ELECTRON_ZIP_DIR ? { electronZipDir: path.resolve(process.env.CYCLE_ELECTRON_ZIP_DIR) } : {}),
  asar: true,
  prune: true,
  overwrite: true,
  ignore: [
    /^\/(?:release|data|evidence|output|docs|tests|scripts)(?:\/|$)/,
    /^\/\.playwright-cli(?:\/|$)/,
    /^\/\.(?:git|agents|codex)(?:\/|$)/,
    /^\/(?:README\.md|package-lock\.json|\.gitignore)$/
  ]
});
for (const output of result) console.log(`已生成桌面应用：${output}`);
