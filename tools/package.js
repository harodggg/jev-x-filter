/**
 * 打包发布：生成可直接「加载已解压的扩展程序」的产物 + 一个 zip。
 *
 * 产物只包含运行必需的东西（manifest.json / src / icons）：
 * 开发期的 tests/ tools/ docs/ 不进包，避免把验证脚本一起发给用户。
 * 内置的 Jev 客户端（src/vendor）属于运行必需，必须保留。
 *
 * 用法：node tools/package.js
 * 输出：dist/jev-x-filter-<version>/ 与 dist/jev-x-filter-<version>.zip
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version;
const stageName = `jev-x-filter-${version}`;
const stage = path.join(DIST, stageName);
const zipPath = path.join(DIST, `${stageName}.zip`);

/** 只打包运行必需的文件。 */
const INCLUDE = ['manifest.json', 'README.md', 'src', 'icons'];
const EXCLUDE_DIRS = ['src/vendor/jev-systemone/dist/__none__']; // 内置客户端要保留，这里只是占位
const EXCLUDE_FILES = [/\.map$/];

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.some((d) => path.relative(ROOT, src) === d)) continue;
      copyTree(src, dest);
      continue;
    }
    if (EXCLUDE_FILES.some((re) => re.test(entry.name))) continue;
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
for (const item of INCLUDE) {
  const from = path.join(ROOT, item);
  if (!fs.existsSync(from)) continue;
  const to = path.join(stage, item);
  if (fs.statSync(from).isDirectory()) copyTree(from, to);
  else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

// 打包前后都校验：清单完整、版本一致、没有密钥
const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'manifest.json'), 'utf8'));
const failures = [];
if (stagedManifest.version !== version) failures.push('manifest 版本不一致');
for (const rel of [stagedManifest.background?.service_worker, ...(stagedManifest.content_scripts?.[0]?.js ?? []), ...(stagedManifest.content_scripts?.[0]?.css ?? []), stagedManifest.action?.default_popup, stagedManifest.options_ui?.page, ...Object.values(stagedManifest.icons ?? {})]) {
  if (rel && !fs.existsSync(path.join(stage, rel))) failures.push(`缺文件: ${rel}`);
}
if (!fs.existsSync(path.join(stage, 'src/vendor/jev-systemone/dist/index.js'))) failures.push('内置 Jev 客户端缺失');

function scanSecrets(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanSecrets(full);
      continue;
    }
    if (!/\.(js|json|html|css|md)$/.test(entry.name)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (/apikey_[0-9a-f]{16,}_[0-9a-f]{16,}/i.test(text) || /sk-[A-Za-z0-9]{24,}/.test(text)) {
      failures.push(`疑似密钥泄漏: ${path.relative(ROOT, full)}`);
    }
  }
}
scanSecrets(stage);

if (failures.length > 0) {
  console.error('打包自检失败：');
  for (const item of failures) console.error(`  ✗ ${item}`);
  process.exit(1);
}

let zipNote = '（未生成 zip：本机没有 zip 命令，可手动压缩 dist 目录）';
fs.rmSync(zipPath, { force: true });
try {
  execFileSync('zip', ['-qr', zipPath, stageName], { cwd: DIST });
  zipNote = `${path.relative(ROOT, zipPath)}（${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB）`;
} catch {
  /* 没有 zip 就只产出目录 */
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

console.log(`已打包 v${version}`);
console.log(`  目录：${path.relative(ROOT, stage)}（${countFiles(stage)} 个文件，可直接“加载已解压的扩展程序”）`);
console.log(`  zip ：${zipNote}`);
console.log('  已校验：清单引用齐全、版本一致、无内置密钥、内置 Jev 客户端在包内');
