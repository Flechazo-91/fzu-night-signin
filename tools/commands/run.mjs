// fzu-signin run —— 定时任务入口
//
// 一次执行的完整流程：
//   同步 cookie → 签到 →（会话失效）唤醒 App 重建 → 再试一次 → 写日志
//
// 退出码：0 成功（含「本来就不用签」）· 1 失败 · 3 不在时段 · 4 坐标不在围栏

import { parseArgs, createLogger, EXIT } from '../lib/cli.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { prepareJar, resolveTarget } from '../lib/runtime.mjs';
import { sign } from '../../lib/sign.mjs';
import { warmUp, findDevice, ensureRoot } from '../../lib/adb.mjs';

const args = parseArgs();
const log = createLogger({ quiet: args.has('quiet'), file: true });
const cfg = loadConfig();

log('================ 晚点名签到 开始 ================');

let device = null;
if (!args.has('no-adb')) {
  try { device = findDevice(cfg.emulator); } catch (e) { log('探测模拟器失败: ' + e.message); }
}

/** @param {boolean} sync 是否从设备重新拉 cookie */
async function attempt(tag, sync) {
  log('--- ' + tag + ' ---');
  try {
    const { jar } = prepareJar({ sync, jarFile: args.get('jar'), log });
    const { lat, lng, address } = resolveTarget(cfg, args);
    return await sign({ jar, lat, lng, address, dry: args.has('dry'), log });
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

let r = await attempt('第 1 次尝试', !args.has('no-adb'));

const cookieProblem = !r.ok && /cookie|token|登录|会话/i.test(r.reason || '');
if (cookieProblem && device && cfg.warmUp && !args.has('dry')) {
  log('会话可能已失效，唤醒 App 重建…');
  try {
    ensureRoot(cfg.emulator, device);
    warmUp(cfg.emulator, device, log);
    // 必须重新从设备拉 cookie：warmUp 会重建 SSO 会话，
    // 用缓存里的旧 cookie 重试等于原地失败（v1.0.0 的 bug）
    r = await attempt('第 2 次尝试（会话刷新后）', true);
    if (!r.ok) {
      log('重拉 cookie 后仍失败，等 20s 再试一次');
      await new Promise((s) => setTimeout(s, 20000));
      r = await attempt('第 3 次尝试', true);
    }
  } catch (e) {
    log('唤醒失败: ' + e.message);
  }
}

if (r.ok) {
  log((r.skipped ? '✔ 已完成，无需操作：' : '✔ 签到成功：') + r.reason);
  if (r.detail) log('   回执: ' + JSON.stringify(r.detail));
  log('================ 结束 (0) ================');
  process.exit(EXIT.OK);
}

log('✘ 失败：' + r.reason);
log('================ 结束 (1) ================');
process.exit(
  /不在签到时段/.test(r.reason) ? EXIT.NOT_IN_WINDOW
    : /围栏/.test(r.reason) ? EXIT.NO_FENCE
      : EXIT.FAILED
);
