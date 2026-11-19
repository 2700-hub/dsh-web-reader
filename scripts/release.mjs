#!/usr/bin/env node
/**
 * 发版辅助：改版本号 + 往 CHANGELOG.md 插入一节模板。
 *
 * 用法：
 *   node scripts/release.mjs 1.11.9 "一句话摘要"
 *
 * 做的事：
 *   1. 校验新版本号是合法 semver 且大于当前版本
 *   2. 同步更新 dsh-web-reader.user.js 的 @version 和 LOCAL_VERSION
 *   3. 在 CHANGELOG.md 第一个版本节之前插入新节（含日期与摘要）
 *   4. 打印后续的 git 命令
 *
 * 为什么要有它：版本号有两个地方要同步（@version 和 LOCAL_VERSION），
 * 手改容易漏；CHANGELOG 靠自觉写，久了就断更。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jsPath = path.join(root, 'dsh-web-reader.user.js');
const clPath = path.join(root, 'CHANGELOG.md');

const [version, summary] = process.argv.slice(2);

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/release.mjs <主.次.修订> ["本次摘要"]');
  process.exit(1);
}

const js = fs.readFileSync(jsPath, 'utf8');
const current = (/\/\/ @version\s+(\S+)/.exec(js) || [])[1];
if (!current) {
  console.error('找不到 @version，脚本可能被改坏了');
  process.exit(1);
}

const cmp = (a, b) => {
  const A = a.split('.').map(Number);
  const B = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
};

if (cmp(version, current) <= 0) {
  console.error(`新版本 ${version} 必须大于当前 ${current}（版本号只能递增）`);
  process.exit(1);
}

let next = js.replace(/(\/\/ @version\s+)\S+/, `$1${version}`);
next = next.replace(/(const LOCAL_VERSION = ')[^']+(')/, `$1${version}$2`);

if (!next.includes(`@version      ${version}`) || !next.includes(`LOCAL_VERSION = '${version}'`)) {
  console.error('版本号替换失败，请检查文件结构是否被改动');
  process.exit(1);
}

fs.writeFileSync(jsPath, next, 'utf8');

const today = new Date().toISOString().slice(0, 10);
const section = `## [${version}] - ${today}

### 变更

- ${summary || '（待补充：这次改了什么，用户能感知到什么）'}

### 修复

- （无则删掉本行）

### 技术说明

- （可选：为什么这么改、踩了什么坑，写给三个月后的自己和 AI 看）

---

`;

let cl = fs.readFileSync(clPath, 'utf8');
const anchor = cl.search(/\n## \[\d/);
if (anchor < 0) {
  console.error('CHANGELOG.md 里找不到版本节（形如 "## [1.11.8] - ..."），未插入');
  process.exit(1);
}
cl = cl.slice(0, anchor + 1) + section + cl.slice(anchor + 1);
fs.writeFileSync(clPath, cl, 'utf8');

console.log(`✅ 版本 ${current} → ${version}`);
console.log('   · dsh-web-reader.user.js  @version + LOCAL_VERSION 已同步');
console.log('   · CHANGELOG.md 已插入新节（记得补全「变更 / 修复 / 技术说明」）');
console.log('');
console.log('接下来：');
console.log(`  git add .`);
console.log(`  git commit -m "feat: ${summary || '（摘要）'} (v${version})"`);
console.log(`  git tag -a v${version} -m "v${version}"`);
console.log(`  git push && git push origin v${version}`);
