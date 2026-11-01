// 配置：默认值 + 用户覆盖（~/.fzu-night-signin/config.json）
//
// 这里**不含任何凭据**。cookie 每次运行时从模拟器的 App 里现拉，
// 不会落到仓库，也不会落到配置文件。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR = path.join(os.homedir(), '.fzu-night-signin');
export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const JAR_PATH = path.join(CONFIG_DIR, 'cookiejar.json');
export const LOG_DIR = path.join(CONFIG_DIR, 'logs');

export const DEFAULTS = {
  // ── 打卡坐标（GCJ-02，高德系）────────────────────────────────
  // 默认值 = 旗山校区主围栏多边形内部靠中心的点。
  // 2026-11 实测围栏：lng 119.1866~119.2065 / lat 26.0470~26.0679
  lat: 26.056,
  lng: 119.196,

  // 逆地理地址（拼进 actualLocation，形如「旗山校区 福建省福州市闽侯县上街镇学园路2号」）
  address: '福建省福州市闽侯县上街镇学园路2号',

  // ── 模拟器 / adb ───────────────────────────────────────────
  emulator: {
    adb: 'D:\\Program Files\\Netease\\MuMu\\nx_main\\adb.exe',
    manager: 'D:\\Program Files\\Netease\\MuMu\\nx_main\\MuMuManager.exe',
    instance: '1',
    package: 'cn.edu.fzu.fdxypa',
    /** 没找到设备时是否自动拉起模拟器 */
    autostart: true,
    /** 等模拟器起来的秒数 */
    waitSeconds: 120,
    /** cookie 数据库在设备上的路径 */
    cookieDb: '/data/data/cn.edu.fzu.fdxypa/app_webview/Default/Cookies',
  },

  // ── 时间窗兜底（服务端返回值优先，这里只做异常兜底）────────────
  window: { start: '21:00', end: '23:59' },

  // ── 行为 ──────────────────────────────────────────────────
  /** cookie 失效时是否唤醒 App 重建会话 */
  warmUp: true,
  /** 唤醒后等 App 起来并导航到签到页的秒数 */
  warmUpSeconds: 45,
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 读取配置（不存在则返回默认值，不落盘） */
export function loadConfig() {
  let user = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      throw new Error(`配置文件解析失败 ${CONFIG_PATH}: ${e.message}`);
    }
  }
  return deepMerge(DEFAULTS, user);
}

/** 写一份配置样例（不覆盖已有文件） */
export function ensureConfigFile() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (fs.existsSync(CONFIG_PATH)) return { created: false, path: CONFIG_PATH };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
  return { created: true, path: CONFIG_PATH };
}

/** 读 / 写 cookie 罐 */
export function loadJar() {
  if (!fs.existsSync(JAR_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(JAR_PATH, 'utf8')); } catch { return {}; }
}

export function saveJar(jar) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(JAR_PATH, JSON.stringify(jar, null, 2), 'utf8');
}
