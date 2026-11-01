// fzu-signin selftest —— 装完立刻跑这一条
//
// 只回答一件事：**现在能不能签**。缺什么就直说缺什么。

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadConfig, loadJar, CONFIG_PATH, JAR_PATH } from '../../lib/config.mjs';
import { CookieJar } from '../../lib/http.mjs';
import { findDevice, hasSqlite } from '../../lib/adb.mjs';
import { fetchToken, fetchInit, fetchCheck } from '../../lib/api.mjs';
import { isSigned, checkWindow } from '../../lib/state.mjs';

const rows = [];
const add = (item, state, detail = '') => rows.push({ item, state, detail });

const cfg = loadConfig();

// 1) 运行时
const [maj, min] = process.versions.node.split('.').map(Number);
const nodeOk = maj > 22 || (maj === 22 && min >= 5);
add('Node 版本', nodeOk ? '✓' : '✗', process.versions.node + (nodeOk ? '' : ' 需要 >=22.5'));
add('cookie 解析', hasSqlite() ? '✓' : '!', hasSqlite() ? 'node:sqlite' : '降级扫描');
add('配置文件', fs.existsSync(CONFIG_PATH) ? '✓' : '!', CONFIG_PATH.replace(/^.*?([\\/][^\\/]+)$/, '…$1'));

// 2) 模拟器
let device = null;
try { device = findDevice(cfg.emulator); } catch { }
add('模拟器', device ? '✓' : '✗', device || '没找到设备（运行时会自动拉起）');

// 3) cookie
const jarObj = fs.existsSync(JAR_PATH) ? loadJar() : null;
const hasCookie = !!(jarObj && jarObj['yzsxg.fzu.edu.cn'] && jarObj['sso.fzu.edu.cn']);
add('cookie', hasCookie ? '✓' : '✗', hasCookie ? '已同步' : '缺（跑 fzu-signin cookies）');

// 4) 接口
let signed = false;
let windowOk = false;
let fenceOk = false;
let who = '';
if (hasCookie) {
  const jar = new CookieJar(jarObj);
  try {
    const { token } = await fetchToken(jar);
    add('登录态', '✓', 'token 正常');
    const data = await fetchInit(jar, token);
    const U = data.userData || {}, P = data.paramsData || {};
    who = `${U.FName} / ${U.UserId}`;
    signed = isSigned(U.FState);
    add('今日状态', signed ? '✓' : '!', U.FState + (U.FCheckInTime ? '  ' + String(U.FCheckInTime).trim() : ''));
    windowOk = checkWindow(new Date(), P.FStartTime, P.FEndTime).inWindow;
    add('签到时段', windowOk ? '✓' : '!', `${String(P.FStartTime).trim()}-${String(P.FEndTime).trim()}`);
    const c = (data.schoolData || [])[0];
    if (c) {
      const res = await fetchCheck(jar, token, { lat: cfg.lat, lng: cfg.lng, range: c.FPosition });
      fenceOk = res.success && Array.isArray(res.data) && res.data.length > 0;
      add('围栏命中', fenceOk ? '✓' : '✗', `${cfg.lat},${cfg.lng} → ${c.FName}`);
    }
  } catch (e) {
    add('登录态', '✗', e.message);
  }
} else {
  add('登录态', '✗', '跳过');
}

// 5) 计划任务
let taskOk = false;
try {
  execFileSync('schtasks', ['/Query', '/TN', 'FZU晚点名签到'], { stdio: 'ignore' });
  taskOk = true;
} catch { }
add('计划任务', taskOk ? '✓' : '!', taskOk ? 'FZU晚点名签到 每天 21:30' : '未注册，跑 scripts/install-task.ps1');

// ── 打印 ─────────────────────────────────────────────────
const w = Math.max(...rows.map((r) => r.item.length)) + 2;
console.log('\n────────── 启动测试 ──────────\n');
for (const r of rows) {
  console.log(`  ${r.item.padEnd(w)} ${r.state}   ${r.detail}`);
}
console.log('');

const fatal = rows.filter((r) => r.state === '✗');
if (fatal.length) {
  console.log('────────── 接下来要做 ──────────\n');
  const seen = new Set();
  for (const r of fatal) {
    const key = (r.item === '登录态' || r.item === 'cookie') ? 'cookie' : r.item;
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'cookie') {
      console.log('  ① 在模拟器里打开「智汇福大」，完成一键登录');
      console.log('  ② 跑  fzu-signin cookies  同步会话');
    } else if (key === '模拟器') {
      console.log('  ① 启动 MuMu 模拟器（实例 1）');
      console.log('  ② 若路径不同，改 ~/.fzu-night-signin/config.json 的 emulator.adb / manager');
    } else if (key === '围栏命中') {
      console.log('  ① 在 ~/.fzu-night-signin/config.json 里改 lat / lng 到围栏内');
      console.log('  ② fzu-signin doctor 会打印当前围栏的经纬度范围');
    } else if (key === 'Node 版本') {
      console.log('  升级 Node 到 22.5 以上（package.json 里 engines 已写明）');
    }
  }
  console.log('\n══════════ 还没准备好 ✗ ══════════\n');
  process.exit(1);
}

console.log('────────── 现在的状态 ──────────\n');
if (who) console.log('  账号   ' + who);
if (signed) console.log('  今天   已经签过了，无需操作 ✓');
else if (windowOk && fenceOk) console.log('  今天   待签到，跑  fzu-signin sign  即可');
else if (!windowOk) console.log('  今天   还没到/已过签到时段（21:00-23:59）');
else console.log('  今天   坐标不在围栏内，先改配置');
console.log('\n══════════ 全部通过 ✓ 可以用了 ══════════\n');
process.exit(0);
