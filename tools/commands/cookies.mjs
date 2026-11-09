// fzu-signin cookies —— 从模拟器同步 App 的 WebView cookie

import { parseArgs, createLogger, EXIT } from '../lib/cli.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { findDevice, ensureRoot, pullCookies } from '../../lib/adb.mjs';
import { saveJar, JAR_PATH } from '../../lib/config.mjs';

const args = parseArgs();
const log = createLogger({ quiet: args.has('quiet') });
const cfg = loadConfig();

const NEEDED = [
  ['yzsxg.fzu.edu.cn', ['JSESSIONID']],
  ['sso.fzu.edu.cn', ['SESSION', 'SOURCEID_TGC']],
];

try {
  const dev = findDevice(cfg.emulator);
  if (!dev) {
    log('✘ 没有可用设备（MuMu 未启动且自动拉起失败）');
    process.exit(EXIT.FAILED);
  }
  log('设备: ' + dev);

  if (!ensureRoot(cfg.emulator, dev)) {
    log('! adb 不是 root，读取 App 私有目录可能失败');
  }
    const jar = pullCookies(cfg.emulator, dev);
  saveJar(jar);

  const hosts = Object.keys(jar);
  log('已同步域名: ' + (hosts.join(', ') || '（空）'));
  for (const h of hosts) {
    for (const c of jar[h]) log('  ' + h + ' | ' + c.slice(0, 64));
  }

  const problems = [];
  for (const [host, names] of NEEDED) {
    for (const n of names) {
      const ok = (jar[host] || []).some((c) => c.startsWith(n + '='));
      if (!ok) problems.push(`${host} 缺 ${n}`);
    }
  }
  if (problems.length) {
    log('✘ 缺关键 cookie: ' + problems.join('; '));
    log('  请在模拟器里打开一次「智汇福大」并完成登录，再重跑本命令');
    process.exit(EXIT.FAILED);
  }

  log('✔ 写入 ' + JAR_PATH);
  process.exit(EXIT.OK);
} catch (e) {
  log('✘ ' + e.message);
  process.exit(EXIT.FAILED);
}
