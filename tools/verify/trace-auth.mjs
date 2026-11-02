// 完整跟踪 authorize 流程的每一次 set-cookie，看能不能拿到可用的 access_token / TGC
import { CookieJar, request } from '../../lib/http.mjs';
import { loadJar } from '../../lib/config.mjs';

const jar = new CookieJar(loadJar());
const BASE = 'https://yzsxg.fzu.edu.cn';
const ATTN = '/livecloud/project/fzu/attn';

const seen = [];
const origAbsorb = jar.absorb.bind(jar);
jar.absorb = (host, sc) => {
  if (sc) for (const c of sc) {
    const kv = String(c).split(';')[0];
    const [k] = kv.split('=');
    seen.push({ host, name: k, raw: c });
  }
  origAbsorb(host, sc);
};

const url = `${BASE}${ATTN}/oauth2/authorize.action`;
const r = await request('GET', url, { jar, follow: true });

console.log('=== 最终 URL ===');
console.log(r.url);
console.log('\n=== 沿途 set-cookie ===');
for (const s of seen) {
  const [k, ...rest] = s.raw.split(';');
  const [, ...v] = k.split('=');
  console.log(`${s.host}  ${k.split('=')[0]} = ${v.join('=').slice(0, 80)}`);
  const attrs = rest.join(';').trim();
  if (attrs) console.log('     attrs:', attrs.slice(0, 120));
}

console.log('\n=== 最终 cookie 罐 ===');
for (const [h, arr] of Object.entries(jar.jar)) {
  console.log(h + ':');
  for (const c of arr) {
    const [k, ...v] = c.split('=');
    console.log('  ' + k + ' = ' + v.join('=').slice(0, 100));
  }
}

// 若拿到 access_token，试着用它直接换授权
const at = (jar.jar['sso.fzu.edu.cn'] || []).find((c) => c.startsWith('access_token='));
if (at) {
  const token = at.slice('access_token='.length);
  console.log('\n=== 用 access_token 试 oauth2/authorize ===');
  for (const band of [
    `${BASE}${ATTN}/oauth2/authorize.action?access_token=${token}`,
    `${BASE}${ATTN}/oauth2/authorize.action?token=${token}`,
  ]) {
    const rr = await request('GET', band, { jar, follow: true });
    console.log(rr.url.slice(0, 140));
  }
} else {
  console.log('\n（没有 access_token）');
}
