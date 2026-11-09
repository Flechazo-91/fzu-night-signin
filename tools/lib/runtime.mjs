// 运行时准备：把「拿到一份可用 cookie」这件事收敛到一处
//
// 三种来源（优先级从高到低）：
//   1. --jar <path>      指定 cookie 文件
//   2. 模拟器现拉        默认；最省心，也最不容易过期
//   3. 本地缓存          模拟器不可用时的兜底

import fs from 'node:fs';
import { loadConfig, loadJar, saveJar, JAR_PATH } from '../../lib/config.mjs';
import { CookieJar } from '../../lib/http.mjs';
import { findDevice, ensureRoot, pullCookies } from '../../lib/adb.mjs';

/**
 * @param {object} opts
 * @param {boolean} [opts.sync]     是否尝试从模拟器同步
 * @param {string}  [opts.jarFile]  直接指定 cookie 文件
 * @param {(m:string)=>void} log
 * @returns {{jar: CookieJar, source: string, device: string|null}}
 */
export function prepareJar({ sync = true, jarFile = null, log = () => {} } = {}) {
  const cfg = loadConfig();

  if (jarFile) {
    const raw = JSON.parse(fs.readFileSync(jarFile, 'utf8'));
    log('cookie 来源: 指定文件 ' + jarFile);
    return { jar: new CookieJar(raw), source: 'file', device: null };
  }

  let device = null;
  if (sync) {
    try {
      device = findDevice(cfg.emulator);
    } catch (e) {
      log('探测模拟器失败: ' + e.message);
    }
    if (device) {
      log('设备: ' + device);
      const rooted = ensureRoot(cfg.emulator, device);
      if (!rooted) log('! adb 不是 root，可能读不到 App 私有目录');
      try {
    const jar = pullCookies(cfg.emulator, device);
        saveJar(jar);
        log('cookie 已同步: ' + Object.keys(jar).join(', '));
        return { jar: new CookieJar(jar), source: 'device', device };
      } catch (e) {
        log('cookie 同步失败: ' + e.message);
      }
    } else {
      log('! 没有可用设备，退回本地缓存');
    }
  }

  const cached = loadJar();
  if (!Object.keys(cached).length) {
    throw new Error(`没有可用 cookie：模拟器不可达，且本地缓存为空 (${JAR_PATH})`);
  }
  log('cookie 来源: 本地缓存 ' + JAR_PATH);
  return { jar: new CookieJar(cached), source: 'cache', device };
}

/** 坐标与地址：命令行 > 配置文件默认值 */
export function resolveTarget(cfg, args) {
  return {
    lat: args?.num('lat', cfg.lat),
    lng: args?.num('lng', cfg.lng),
    address: args?.get('address', cfg.address),
  };
}
