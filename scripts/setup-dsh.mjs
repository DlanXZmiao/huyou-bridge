#!/usr/bin/env node
// setup-dsh.mjs — 把狐友 MCP 工具装进 DSH profile
//
// 做三件事（幂等）：
//   1. 在 ~/.dsh/plugins/ 与 <profile>/node_modules/ 建 junction 指向本仓库的 bundle；
//   2. 生成 plugins/huyou-agent-tools/cordis.patch.yml（绝对路径，指向本机 node 与 mcp-huyou.js）；
//   3. 把 bundle 注册进 profile 的 package.json（dependencies + dsh.profile.bundles）。
//
// 用法：node scripts/setup-dsh.mjs [profile]      # 默认 desktop
// 装完需要重启 DSH（或在 DSH 里重新加载 profile）才会出现 huyou_* 工具。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const ARGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const REMOVE = process.argv.includes('--remove');
const PROFILE = ARGS[0] || 'desktop';
const BUNDLE = 'huyou-agent-tools';
const REPO_BUNDLE = path.join(ROOT, 'plugins', BUNDLE);
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', PROFILE);

const log = (m) => console.log(`[setup] ${m}`);
const fail = (m) => { console.error(`[setup] ERROR: ${m}`); process.exit(1); };

if (!/^[A-Za-z0-9._-]+$/.test(PROFILE)) fail(`非法 profile 名: ${PROFILE}`);
if (!fs.existsSync(ROOT)) fail(`仓库路径不存在: ${ROOT}`);
if (!fs.existsSync(path.join(ROOT, 'src', 'mcp-huyou.js'))) fail('找不到 src/mcp-huyou.js');

// ── 卸载：把 bundle 从 profile 摘掉、删 junction ────────────────────────────
if (REMOVE) {
  const pkgFile = path.join(PROFILE_DIR, 'package.json');
  if (fs.existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.dependencies?.[BUNDLE]) {
        delete pkg.dependencies[BUNDLE];
        log('已从 profile dependencies 移除');
      }
      if (Array.isArray(pkg.dsh?.profile?.bundles)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== BUNDLE);
        log('已从 profile bundles 移除');
      }
      fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    } catch (e) {
      fail(`profile package.json 解析失败: ${e.message}`);
    }
  }
  for (const p of [path.join(DSH_HOME, 'plugins', BUNDLE), path.join(PROFILE_DIR, 'node_modules', BUNDLE)]) {
    try { fs.rmSync(p, { recursive: true, force: true }); log(`已删除 ${p}`); } catch { /* 不存在就算了 */ }
  }
  try { fs.rmSync(path.join(REPO_BUNDLE, 'cordis.patch.yml'), { force: true }); } catch { /* ignore */ }
  log('完成。重启 DSH 后 huyou_* 工具会消失。');
  process.exit(0);
}

function ensureLink(linkPath, target, label) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let st = null;
  try { st = fs.lstatSync(linkPath); } catch { /* 不存在 */ }
  if (st) {
    if (!st.isSymbolicLink()) fail(`${label} 已存在且不是 junction: ${linkPath}（请手工移走）`);
    let same = false;
    try { same = fs.realpathSync(linkPath).toLowerCase() === fs.realpathSync(target).toLowerCase(); } catch { /* 悬空 */ }
    if (same) { log(`${label} 已就绪`); return; }
    log(`${label} 指向失效，重建`);
    fs.rmSync(linkPath, { recursive: true, force: true });
  }
  fs.symlinkSync(target, linkPath, 'junction');
  log(`${label} 已创建 → ${target}`);
}

const nodeExe = process.execPath;
const patch = [
  '# 由 scripts/setup-dsh.mjs 生成，请勿手改（重跑会覆盖）',
  '- insert:',
  '    - id: mcp-huyou',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: huyou',
  '        transport: stdio',
  `        command: '${nodeExe.replace(/\\/g, '/')}'`,
  '        args:',
  `          - '${path.join(ROOT, 'src', 'mcp-huyou.js').replace(/\\/g, '/')}'`,
  '        toolCallTimeoutMs: 120000',
  ''
].join('\n');

fs.writeFileSync(path.join(REPO_BUNDLE, 'cordis.patch.yml'), patch, 'utf8');
log(`已生成 ${path.relative(ROOT, path.join(REPO_BUNDLE, 'cordis.patch.yml'))}`);

ensureLink(path.join(DSH_HOME, 'plugins', BUNDLE), REPO_BUNDLE, `bundle ${BUNDLE} link`);
ensureLink(path.join(PROFILE_DIR, 'node_modules', BUNDLE), path.join(DSH_HOME, 'plugins', BUNDLE), 'node_modules link');

const pkgFile = path.join(PROFILE_DIR, 'package.json');
let pkg = { name: `dsh-profile-${PROFILE}`, private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
if (fs.existsSync(pkgFile)) {
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch (e) { fail(`profile package.json 解析失败: ${e.message}`); }
}
pkg.dependencies = pkg.dependencies || {};
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

const linkVal = `link:${path.join(DSH_HOME, 'plugins', BUNDLE).replace(/\\/g, '/')}`;
if (pkg.dependencies[BUNDLE] !== linkVal) {
  pkg.dependencies[BUNDLE] = linkVal;
  log(`package.json dependency 已更新`);
}
if (!pkg.dsh.profile.bundles.includes(BUNDLE)) {
  pkg.dsh.profile.bundles.push(BUNDLE);
  log(`package.json bundle 已注册`);
}
fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

log('完成。重启 DSH 后，会话里会出现 huyou_status / huyou_feed / huyou_comments / huyou_draft_comment。');
