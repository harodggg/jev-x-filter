/**
 * 静态自检（不需要浏览器）：
 *   1. manifest.json 合法、引用的文件都存在、权限最小；
 *   2. 没有远程代码 / eval / new Function（MV3 CSP 会直接拒绝，属于打包事故）；
 *   3. 所有 JS 都能通过 `node --check`；
 *   4. 内容脚本确实是「传统脚本」（不能出现 import/export，否则在页面上会语法错误）；
 *   5. HTML 引用的本地资源都存在、没有外链脚本。
 *
 * 用法：node tools/check-sources.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];

function ok(name, detail = '') {
  checks.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail) {
  failures.push(`  ✗ ${name} — ${detail}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`解析 ${path.relative(ROOT, file)}`, String(error.message));
    return null;
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.tmp')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT).filter((f) => !f.includes(`${path.sep}icons${path.sep}`));

/* ------------------------------- 1. manifest ------------------------------- */
const manifestPath = path.join(ROOT, 'manifest.json');
const manifest = readJson(manifestPath);
const ALLOWED_PERMISSIONS = new Set(['storage', 'alarms']);

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest.manifest_version', `应为 3，实际 ${manifest.manifest_version}`);
  else ok('manifest_version = 3');

  const referenced = [];
  for (const size of Object.values(manifest.icons ?? {})) referenced.push(size);
  for (const f of manifest.content_scripts?.[0]?.js ?? []) referenced.push(f);
  for (const f of manifest.content_scripts?.[0]?.css ?? []) referenced.push(f);
  referenced.push(manifest.background?.service_worker);
  referenced.push(manifest.action?.default_popup);
  referenced.push(manifest.options_ui?.page);

  for (const rel of referenced.filter(Boolean)) {
    if (fs.existsSync(path.join(ROOT, rel))) ok(`引用存在: ${rel}`);
    else fail(`引用缺失: ${rel}`, 'manifest 指向的文件不存在');
  }

  if (manifest.background?.type !== 'module') fail('background.type', 'Service Worker 必须声明 type: module（要 import 内置 Jev 客户端）');
  else ok('Service Worker 为 ES module');

  const badPermissions = (manifest.permissions ?? []).filter((p) => !ALLOWED_PERMISSIONS.has(p));
  if (badPermissions.length) fail('权限最小化', `出现未预期的权限: ${badPermissions.join(', ')}`);
  else ok('权限最小化', (manifest.permissions ?? []).join(', '));

  const hosts = manifest.host_permissions ?? [];
  const unexpectedHost = hosts.find((h) => !/^https:\/\/(x\.com|twitter\.com|pbs\.twimg\.com|video\.twimg\.com|api\.typesafe\.ai|opencode\.ai|openrouter\.ai|ai-gateway\.vercel\.sh)\/\*$/.test(h));
  if (unexpectedHost) fail('host_permissions', `未预期的域名: ${unexpectedHost}`);
  else ok('host_permissions 限定在 X 与 Jev/网关 + 图片 CDN');

  if (manifest.web_accessible_resources) fail('web_accessible_resources', '不应暴露任何扩展资源给页面');
  else ok('未暴露 web_accessible_resources');

  if ((manifest.content_scripts ?? []).some((cs) => cs.matches?.includes('<all_urls>'))) {
    fail('content_scripts.matches', '不应注册 <all_urls>，只应在 X 上运行');
  } else ok('内容脚本只注入 x.com / twitter.com');
}

/* --------------------------- 2. 无远程代码 / eval --------------------------- */
// 只扫描「会被打进扩展」的代码（src/，vendor 是原样收录的官方客户端）。
// tools/ 与 tests/ 是开发期脚本，不参与打包，因此不在扫描范围内。
const jsFiles = files.filter(
  (f) => f.endsWith('.js') && f.includes(`${path.sep}src${path.sep}`) && !f.includes(`${path.sep}vendor${path.sep}`),
);
const htmlFiles = files.filter((f) => f.endsWith('.html'));

for (const file of jsFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (/\beval\s*\(/.test(source)) fail(`${rel}`, '出现 eval()，MV3 不允许');
  if (/new\s+Function\s*\(/.test(source)) fail(`${rel}`, '出现 new Function()，MV3 不允许');
  if (/import\s*\(\s*['"]https?:/.test(source)) fail(`${rel}`, '出现远程动态 import');
  if (/(?:src|href)\s*=\s*['"]https?:\/\//.test(source)) fail(`${rel}`, '出现远程资源引用');
}
ok('业务脚本无 eval / new Function / 远程 import', `${jsFiles.length} 个文件`);

for (const file of htmlFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const remote = [...source.matchAll(/<(?:script|link)[^>]+(?:src|href)=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  if (remote.length) fail(`${rel}`, `引用了远程资源: ${remote.join(', ')}`);
  const local = [...source.matchAll(/<(?:script|link)[^>]+(?:src|href)=["']([^"']+)["']/gi)].map((m) => m[1]);
  for (const target of local) {
    if (/^https?:/.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!fs.existsSync(resolved)) fail(`${rel}`, `本地资源缺失: ${target}`);
  }
}
ok('HTML 无远程脚本，本地引用齐全', `${htmlFiles.length} 个文件`);

/* ------------------------- 3. 内容脚本必须是传统脚本 ------------------------- */
for (const file of files.filter((f) => f.includes(`${path.sep}content${path.sep}`) && f.endsWith('.js'))) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (/^\s*(?:import|export)\s/m.test(source)) {
    fail(`${rel}`, '内容脚本是传统脚本，不能出现 import/export（否则页面上直接语法错误）');
  }
}
ok('内容脚本保持传统脚本（无 ESM 语法）');

/* ----------------------------- 4. 语法检查 ----------------------------- */
let checked = 0;
for (const file of files.filter((f) => f.endsWith('.js'))) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    checked++;
  } catch (error) {
    fail(`node --check ${path.relative(ROOT, file)}`, String(error.stderr ?? error.message).trim().split('\n')[0]);
  }
}
ok('node --check 全部通过', `${checked} 个 JS 文件`);

/* ------------------------------- 输出结论 ------------------------------- */
console.log('静态自检报告：');
console.log(checks.join('\n'));
if (failures.length) {
  console.log('\n发现问题：');
  console.log(failures.join('\n'));
  process.exit(1);
}
console.log(`\n全部通过（${checks.length} 项）。`);
