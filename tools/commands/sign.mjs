// fzu-signin sign —— 立即签到

import { parseArgs, createLogger, EXIT } from '../lib/cli.mjs';
import { loadConfig } from '../../lib/config.mjs';
import { prepareJar, resolveTarget } from '../lib/runtime.mjs';
import { sign } from '../../lib/sign.mjs';

const args = parseArgs();
const log = createLogger({ quiet: args.has('quiet') });
const cfg = loadConfig();

try {
  const { jar } = prepareJar({
    sync: !args.has('no-adb'),
    jarFile: args.get('jar'),
    log,
  });
  const { lat, lng, address } = resolveTarget(cfg, args);
  log(`目标坐标: ${lat},${lng}`);

  const r = await sign({ jar, lat, lng, address, dry: args.has('dry'), log });

  if (args.has('json')) {
    console.log(JSON.stringify(r, null, 2));
  } else if (r.ok) {
    log((r.skipped ? '✔ ' : '✔ 签到成功：') + r.reason);
    if (r.detail) log('   回执: ' + JSON.stringify(r.detail));
  } else {
    log('✘ 失败：' + r.reason);
  }

  process.exit(r.ok ? EXIT.OK : EXIT.FAILED);
} catch (e) {
  log('✘ ' + e.message);
  process.exit(EXIT.FAILED);
}
