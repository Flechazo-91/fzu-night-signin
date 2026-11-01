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

  const tryConnect = (info) => {
    const ports = [...String(info).matchAll(/"adb_port":\s*(\d+)/g)].map((m) => m[1]);
    for (const p of ports) {
      const dev = `127.0.0.1:${p}`;
      try {
        sh(adb, ['connect', dev]);
        const list = sh(adb, ['devices']);
        const line = list.split('\n').find((l) => l.includes(dev) && !l.includes('offline'));
        if (line && /\bdevice\b/.test(line)) return dev;
      } catch { /* 端口不通，换下一个 */ }
    }
    return null;
  };

  let info = '';
  try { info = sh(manager, ['info', '-v', 'all']); } catch { /* 管理器不在也继续尝试直连 */ }

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
    try { sh(manager, ['control', '-v', idx, 'launch']); } catch { }
    break;
  }

  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    sleep(4000);
    try {
      info = sh(manager, ['info', '-v', 'all']);
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
 * 把设备上的 cookie 库拉到本地
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
 * 唤醒 App，把 WebView 推到签到页，重建 SSO 会话
 * 只在 cookie 失效时才会走到这里
 */
export function warmUp(cfg, dev, log = () => {}) {
  const { adb, package: pkg } = cfg;
  const tap = (x, y) => sh(adb, ['-s', dev, 'shell', `input tap ${x} ${y}`]);

  log('唤醒屏幕并启动 App');
  sh(adb, ['-s', dev, 'shell', 'input keyevent KEYCODE_WAKEUP']);
  sh(adb, ['-s', dev, 'shell', `am start -n ${pkg}/cn.edu.fzu.fdxy_app.MainActivity`]);
  sleep(12000);

  // App 掉登录时会停在登录页：勾协议 → 一键登录
  try {
    const ui = sh(adb, ['-s', dev, 'shell', 'uiautomator dump /sdcard/w.xml >/dev/null 2>&1; cat /sdcard/w.xml']);
    if (ui.includes('一键登录')) {
      log('检测到登录页，自动一键登录');
      tap(78, 961);      // 同意协议
      sleep(1200);
      tap(961, 758);     // 一键登录
      sleep(9000);
    }
  } catch { /* 无障碍不可用就算了 */ }

  log('导航到「业务 → 我的服务 → 晚点名签到」');
  tap(1678, 1035);
  sleep(3500);
  sh(adb, ['-s', dev, 'shell', 'input swipe 960 850 960 300 400']);
  sleep(2000);
  tap(223, 284);
  sleep(9000);
}
