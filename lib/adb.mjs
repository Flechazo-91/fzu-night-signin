// 设备层：MuMu 模拟器 + adb + 从 App 的 WebView 里取 cookie
//
// 为什么绕这一圈：签到接口要的业务 token 藏在 SSO 会话后面，而 SSO 会话
// 由 App 的「一键登录」维持。所以 App 只承担一件事——**当 cookie 的持有者**，
// 打卡本身完全不经过它。这样既不用跑 UI 自动化，也不用伪造定位。

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.mjs';

const require = createRequire(import.meta.url);

export function sh(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    // 关键：execFileSync 默认无限等待。2026-11-08 那次任务进程被系统强杀
    // （0xC000013A）就是卡在没有超时的子进程调用上。所有外部命令都必须带时限。
    timeout: 30000,
    killSignal: 'SIGKILL',
    ...opts,
  });
}

export const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** node:sqlite 是否可用（Node >= 22.5） */
export function hasSqlite() {
  try { require('node:sqlite'); return true; } catch { return false; }
}

/**
 * 找可用设备；找不到就按配置把模拟器拉起来
 * @param {object} cfg config.emulator
 * @returns {string|null} 形如 127.0.0.1:16416
 */
export function findDevice(cfg) {
  const { adb, manager, autostart = true, waitSeconds = 120 } = cfg;
  // 整体硬超时：内部哪一步卡住，到点都必须返回，让上层决定下一步
  const hardDeadline = Date.now() + Math.min(waitSeconds, 150) * 1000 + 20000;

  const tryConnect = (info) => {
    if (Date.now() > hardDeadline) return null;
    const ports = [...String(info).matchAll(/"adb_port":\s*(\d+)/g)].map((m) => m[1]);
    for (const p of ports) {
      const dev = `127.0.0.1:${p}`;
      try {
        sh(adb, ['connect', dev], { timeout: 10000 });
        const list = sh(adb, ['devices'], { timeout: 10000 });
        const line = list.split('\n').find((l) => l.includes(dev) && !l.includes('offline'));
        if (line && /\bdevice\b/.test(line)) return dev;
      } catch { /* 端口不通，换下一个 */ }
    }
    return null;
  };

  let info = '';
  try { info = sh(manager, ['info', '-v', 'all'], { timeout: 20000 }); } catch { /* 管理器不在也继续尝试直连 */ }

  let dev = tryConnect(info);
  if (dev) return dev;

  // 有些环境 manager 读不到但 adb 端口是固定的，再兜一次
  if (!info) {
    const guess = tryConnect('"adb_port": 16384');
    if (guess) return guess;
  }

  if (!autostart || !fs.existsSync(manager)) return null;

  // 挑一个没开机的实例启动（优先配置里那个）
  const indexes = [...info.matchAll(/"index":\s*"(\d+)"/g)].map((m) => m[1]);
  const preferred = String(cfg.instance || '1');
  const order = indexes.includes(preferred) ? [preferred, ...indexes.filter((i) => i !== preferred)] : indexes;
  for (const idx of order) {
    const start = info.indexOf(`"${idx}": {`);
    const block = info.slice(start, start + 800);
    if (/"is_android_started":\s*true/.test(block)) continue;
    try { sh(manager, ['control', '-v', idx, 'launch'], { timeout: 30000 }); } catch { }
    break;
  }

  const deadline = Math.min(Date.now() + waitSeconds * 1000, hardDeadline);
  while (Date.now() < deadline) {
    sleep(4000);
    try {
      info = sh(manager, ['info', '-v', 'all'], { timeout: 20000 });
    } catch { continue; }
    if (!/"is_android_started":\s*true/.test(info)) continue;
    dev = tryConnect(info);
    if (dev) { sleep(3000); return dev; }
  }
  return null;
}

/** 确认 adbd 是 root（读别的 App 的数据目录需要） */
export function ensureRoot(cfg, dev) {
  try {
    const out = sh(cfg.adb, ['-s', dev, 'shell', 'id']);
    if (out.includes('uid=0')) return true;
    sh(cfg.adb, ['-s', dev, 'root']);
    sleep(3000);
    sh(cfg.adb, ['connect', dev]);
    sleep(1500);
    const again = sh(cfg.adb, ['-s', dev, 'shell', 'id']);
    return again.includes('uid=0');
  } catch {
    return false;
  }
}

/**
 * 直接从设备上的 cookie 库读出 { host: ['k=v', ...] }
 *
 * 为什么不用 cp + sqlite3 读本地文件：2026-11-09 实测翻车——
 * 设备上 `sqlite3 ... 'select count(*) from cookies'` 明明有 5 行，
 * 但 `cp` 出来的文件用 node:sqlite 读是 0 行。WebView 的库在
 * App 运行期间处于半提交状态，文件级拷贝拿不到一致快照。
 * 改成让设备上的 sqlite3 自己把结果导出来，绕开这个坑。
 *
 * 所有 cookie 都是 session cookie（is_persistent=0），所以必须每次现拉。
 */
export function pullCookies(cfg, dev) {
  const sql = "select host_key,name,value from cookies where value<>''";
  const out = sh(cfg.adb, ['-s', dev, 'shell', `sqlite3 -separator '|' ${cfg.cookieDb} "${sql}"`], { timeout: 25000 });
  const jar = {};
  let n = 0;
  for (const line of String(out).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const i = s.indexOf('|');
    const j = s.indexOf('|', i + 1);
    if (i <= 0 || j <= i) continue;
    const host = s.slice(0, i);
    const name = s.slice(i + 1, j);
    const value = s.slice(j + 1);
    if (!value) continue;
    (jar[host] ||= []).push(`${name}=${value}`);
    n++;
  }
  if (!n) throw new Error('设备上 cookies 表为空（App 可能还没加载过 WebView）');
  return jar;
}

/**
 * 把设备上的 cookie 库拉到本地（保留，供人工排查用）
 * @returns {string} 本地路径
 */
export function pullCookieDb(cfg, dev) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const local = path.join(CONFIG_DIR, 'Cookies.db');
  const remote = '/data/local/tmp/fzu_cookies.db';
  sh(cfg.adb, ['-s', dev, 'shell', `cp ${cfg.cookieDb} ${remote} && chmod 644 ${remote}`]);
  sh(cfg.adb, ['-s', dev, 'pull', remote, local]);
  if (!fs.existsSync(local)) throw new Error('cookie 数据库拉取失败：' + local);
  return local;
}

/**
 * 解析 cookie 库 → { host: ['k=v', ...] }
 *
 * 首选 node:sqlite（Node 22.5+ 内置，零依赖）；
 * 不可用时降级成「二进制扫明文三元组」——WebView 默认不加密 cookie value。
 */
export function readCookieDb(dbPath) {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT host_key, name, value FROM cookies').all();
    db.close();
    const jar = {};
    for (const r of rows) {
      if (!r.value) continue;
      (jar[r.host_key] ||= []).push(`${r.name}=${r.value}`);
    }
    return jar;
  } catch {
    return scanCookieDb(dbPath);
  }
}

/** 兜底解析：只认 fzu.edu.cn 域的明文 cookie */
function scanCookieDb(dbPath) {
  const buf = fs.readFileSync(dbPath);
  const text = buf.toString('latin1');
  const jar = {};
  const re = /((?:[a-z0-9-]+\.)+fzu\.edu\.cn)[\x00-\x1f]+([A-Za-z0-9_]+)[\x00-\x1f]+([\x20-\x7e]{1,512})/g;
  let m;
  while ((m = re.exec(text))) {
    (jar[m[1]] ||= []).push(`${m[2]}=${m[3]}`);
  }
  return jar;
}

/**
 * 从无障碍树里找含指定文案的控件，返回它的中心点
 *
 * 为什么不用固定坐标：屏幕方向（MuMu 会在横竖屏之间切）、列表是否已滚动、
 * 顶部有没有多一行标题，都会让同一个数字落到不同地方。
 * 2026-11-02 那次 warmUp 点歪，点到的是「福大体育」，就是这个原因。
 *
 * @returns {{x:number,y:number}|null}
 */
export function findByDesc(cfg, dev, keyword) {
  const { adb } = cfg;
  let xml = '';
  for (let i = 0; i < 3; i++) {
    try {
      xml = sh(adb, ['-s', dev, 'shell', 'uiautomator dump /sdcard/w.xml >/dev/null 2>&1; cat /sdcard/w.xml'], { timeout: 20000 });
      if (xml && xml.includes('<hierarchy')) break;
    } catch { }
    sleep(1500);
  }
  if (!xml) return null;

  const re = /content-desc="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
  const hits = [];
  let m;
  while ((m = re.exec(xml))) {
    const desc = m[1].replace(/&#10;/g, '\n').replace(/&amp;/g, '&');
    if (!desc.includes(keyword)) continue;
    const [l, t, r, b] = [+m[2], +m[3], +m[4], +m[5]];
    const w = r - l, h = b - t;
    // 只排除整屏容器节点（Flutter 的容器常是 0,0~全屏）
    if (w >= 1900 && h >= 1000) continue;
    // 注意：纯文字节点的 bounds 高度可能只有几像素（实测「登录即代表您已同意」只有 4px），
    // 早先按 <40px 过滤会把这个节点直接丢掉，导致登录检测从来不触发。
    if (w <= 0 || h < 0) continue;
    hits.push({ x: Math.round((l + r) / 2), y: Math.round((t + b) / 2), w, h });
  }
  if (!hits.length) return null;
  // 优先返回"有一定尺寸"的节点；没有就退回文字节点（中心点依然准）
  hits.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  const pick = hits.find((h) => h.w >= 40 && h.h >= 40) || hits[0];
  return { x: pick.x, y: pick.y };
}

/** 点一个按文案找到的控件；找不到返回 false */
export function tapByDesc(cfg, dev, keyword, log = () => {}) {
  const { adb } = cfg;
  const pos = findByDesc(cfg, dev, keyword);
  if (!pos) { log(`没找到「${keyword}」`); return false; }
  log(`点击「${keyword}」@ (${pos.x},${pos.y})`);
  sh(adb, ['-s', dev, 'shell', `input tap ${pos.x} ${pos.y}`], { timeout: 15000 });
  return true;
}

/**
 * 唤醒 App，把 WebView 推到签到页，重建 SSO 会话
 * 只在 cookie 失效时才会走到这里
 */
export function warmUp(cfg, dev, log = () => {}) {
  const { adb, package: pkg } = cfg;
  const tap = (x, y) => sh(adb, ['-s', dev, 'shell', `input tap ${x} ${y}`], { timeout: 15000 });

  log('唤醒屏幕并启动 App');
  sh(adb, ['-s', dev, 'shell', 'input keyevent KEYCODE_WAKEUP'], { timeout: 15000 });
  sh(adb, ['-s', dev, 'shell', `am start -n ${pkg}/cn.edu.fzu.fdxy_app.MainActivity`], { timeout: 20000 });
  sleep(12000);

  // App 掉登录时会停在登录页：勾协议 → 一键登录
  try {
    const agree = findByDesc(cfg, dev, '登录即代表您已同意');
    if (agree) {
      log('检测到登录页，自动一键登录');
      // 协议圆圈在文案左侧约 130px；clamp 到屏幕内，避免算出负数点空
      const { w } = screenSize(cfg, dev);
      const boxX = Math.max(20, Math.min(agree.x - 130, w - 20));
      log(`勾选协议 @ (${boxX},${agree.y})`);
      tap(boxX, agree.y);
      sleep(1300);
      const btn = findByDesc(cfg, dev, '一键登录');
      if (btn) {
        log(`点一键登录 @ (${btn.x},${btn.y})`);
        tap(btn.x, btn.y);
        sleep(11000);
      } else {
        log('没找到「一键登录」按钮');
      }
    } else {
      log('当前不在登录页');
    }
  } catch (e) { log('登录页处理异常: ' + e.message); }

  // 导航：业务 → 我的服务 → 晚点名签到（全部按文案找，不写死坐标）
  log('导航到「业务 → 我的服务 → 晚点名签到」');
  if (!tapByDesc(cfg, dev, '第 4 个标签', log)) {
    // 兜底：底部导航按屏幕宽度比例
    const w = screenSize(cfg, dev).w;
    tap(Math.round(w * 0.875), Math.round(screenSize(cfg, dev).h * 0.958));
  }
  sleep(3500);

  // 「晚点名签到」可能不在首屏，试着往下滑几次
  for (let i = 0; i < 4; i++) {
    if (tapByDesc(cfg, dev, '晚点名签到', log)) { sleep(9000); return; }
    log(`第 ${i + 1} 次滑动找入口`);
    sh(adb, ['-s', dev, 'shell', 'input swipe 960 850 960 300 400'], { timeout: 15000 });
    sleep(2000);
  }
  log('⚠ 没找到「晚点名签到」入口，但 App 已启动，OAuth 可能已刷新');
  sleep(4000);
}

/** 读屏幕尺寸（用于兜底坐标） */
export function screenSize(cfg, dev) {
  try {
    const out = sh(cfg.adb, ['-s', dev, 'shell', 'wm size'], { timeout: 10000 });
    const m = /(\d+)x(\d+)/.exec(out);
    if (m) return { w: +m[1], h: +m[2] };
  } catch { }
  return { w: 1920, h: 1080 };
}
