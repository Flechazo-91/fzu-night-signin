// fzu-signin doctor —— 环境自检
//
// 五项：文件 → 模拟器+cookie → 本地 cookie → 接口连通 → 计划任务
// 缺哪项说哪项，不猜。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, EXIT } from '../lib/cli.mjs';
import { loadConfig, loadJar, CONFIG_PATH, JAR_PATH } from '../../lib/config.mjs';
import { CookieJar } from '../../lib/http.mjs';
import { findDevice, ensureRoot, pullCookieDb, readCookieDb, hasSqlite } from '../../lib/adb.mjs';
import { fetchToken, fetchInit, fetchCheck } from '../../lib/api.mjs';
import { describeFence, checkWindow } from '../../lib/state.mjs';

const args = parseArgs();
const show = (...a) => { if (!args.has('quiet')) console.log(...a); };
const ok = (m) => show('  ✔ ' + m);
const bad = (m) => show('  ✘ ' + m);
const warn = (m) => show('  ! ' + m);

const cfg = loadConfig();
let healthy = true;

// ── 1. 运行时 ─────────────────────────────────────────────
show('=== 1. 运行时 ===');
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major > 22 || (major === 22 && minor >= 5)) ok(`Node ${process.versions.node}`);
else { bad(`Node ${process.versions.node} —— 需要 >= 22.5（读 cookie 库要用 node:sqlite）`); healthy = false; }
if (hasSqlite()) ok('node:sqlite 可用');
else warn('node:sqlite 不可用，将降级为二进制扫描 cookie（可能不全）');

// ── 2. 文件 ───────────────────────────────────────────────
show('\n=== 2. 文件 ===');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../..');
for (const f of ['lib/api.mjs', 'lib/crypto.mjs', 'lib/state.mjs', 'lib/sign.mjs', 'tools/fzu.mjs']) {
  const p = path.join(root, f);
  fs.existsSync(p) ? ok(f) : (bad(f + ' 缺失'), healthy = false);
}
if (fs.existsSync(CONFIG_PATH)) ok('配置 ' + CONFIG_PATH);
else warn('配置未创建（使用默认值）：' + CONFIG_PATH);

// ── 3. 模拟器 + cookie ───────────────────────────────────
show('\n=== 3. 模拟器 ===');
let device = null;
try { device = findDevice(cfg.emulator); } catch (e) { bad('探测失败: ' + e.message); }
if (device) {
  ok('设备 ' + device);
  const rooted = ensureRoot(cfg.emulator, device);
  rooted ? ok('adb root') : warn('adb 非 root，可能读不到 App 私有目录');
  try {
    const db = pullCookieDb(cfg.emulator, device);
    const jar = readCookieDb(db);
    ok('cookie: ' + (Object.keys(jar).join(', ') || '（空）'));
  } catch (e) {
    bad('cookie 同步失败: ' + e.message);
    healthy = false;
  }
} else {
  warn('没有可用设备（运行时会把模拟器拉起来）');
}

// ── 4. 本地 cookie ───────────────────────────────────────
show('\n=== 4. 本地 cookie ===');
let jarObj = null;
if (fs.existsSync(JAR_PATH)) {
  jarObj = loadJar();
  for (const [host, names] of [['yzsxg.fzu.edu.cn', ['JSESSIONID']], ['sso.fzu.edu.cn', ['SESSION', 'SOURCEID_TGC']]]) {
    const missing = names.filter((n) => !(jarObj[host] || []).some((c) => c.startsWith(n + '=')));
    missing.length ? (bad(`${host} 缺 ${missing.join(',')}`), healthy = false) : ok(host + ' → ' + names.join(','));
  }
} else {
  bad('cookiejar.json 不存在（先跑 fzu-signin cookies）');
  healthy = false;
}

// ── 5. 接口 ───────────────────────────────────────────────
show('\n=== 5. 接口 ===');
if (jarObj) {
  const jar = new CookieJar(jarObj);
  try {
    const { token } = await fetchToken(jar);
    ok('oauth2 token = ' + token);
    const data = await fetchInit(jar, token);
    const U = data.userData || {}, P = data.paramsData || {};
    ok(`init: ${U.FName} / ${U.UserId} / ${U.FClass}`);
    const start = String(P.FStartTime || '').trim(), end = String(P.FEndTime || '').trim();
    ok(`时段 ${start}-${end}，迟到线 ${String(P.FLateTime || '').trim()}`);
    const signed = String(U.FState || '').toUpperCase().includes('SUCCESS');
    ok('今日状态: ' + U.FState + (signed ? '（已完成）' : '（待签到）'));

    for (const c of data.schoolData || []) {
      const res = await fetchCheck(jar, token, { lat: cfg.lat, lng: cfg.lng, range: c.FPosition });
      const hit = res.success && Array.isArray(res.data) && res.data.length > 0;
      hit ? ok(`围栏命中 ${c.FName}#${c.ID}: ${cfg.lat},${cfg.lng}`)
        : (bad(`围栏未命中 ${c.FName}#${c.ID}: ${cfg.lat},${cfg.lng} → ${res.msg || '不在范围'}`), healthy = false);
      const f = describeFence(c.FPosition);
      if (f) show(`     围栏 lng ${f.lng[0]}~${f.lng[1]} / lat ${f.lat[0]}~${f.lat[1]}（${f.count} 块）`);
    }
    const w = checkWindow(new Date(), P.FStartTime, P.FEndTime);
    show(`     当前${w.inWindow ? '在' : '不在'}签到时段`);
  } catch (e) {
    bad('接口失败: ' + e.message);
    healthy = false;
  }
} else {
  warn('跳过（没有 cookie）');
}

// ── 6. 计划任务 ───────────────────────────────────────────
show('\n=== 6. 计划任务 ===');
try {
  const out = execFileSync('schtasks', ['/Query', '/TN', 'FZU晚点名签到', '/FO', 'LIST'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  });
  for (const line of out.split('\n')) {
    if (/下次运行|Next Run|状态|Status/.test(line)) ok(line.trim());
  }
} catch {
  warn('计划任务未注册（Windows: powershell -ExecutionPolicy Bypass -File scripts/install-task.ps1）');
}

show('\n' + (healthy ? '=== 全部通过 ✓ ===' : '=== 有项目未通过，见上面的 ✘ ==='));
process.exit(healthy ? EXIT.OK : EXIT.FAILED);
