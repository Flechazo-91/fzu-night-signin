// 诊断：不经过 oauth2/authorize，直接用 WebView 里的 cookie 试探各接口
import fs from 'node:fs';
import { CookieJar, request } from '../../lib/http.mjs';
import { loadJar } from '../../lib/config.mjs';
import { encodeParam, encrypt } from '../../lib/crypto.mjs';

const jar = new CookieJar(loadJar());
const BASE = 'https://yzsxg.fzu.edu.cn';
const ATTN = '/livecloud/project/fzu/attn';

const sess = (jar.jar['yzsxg.fzu.edu.cn'] || []).find((c) => c.startsWith('JSESSIONID='));
const jsid = sess ? sess.split('=')[1] : '';
console.log('JSESSIONID =', jsid);

async function probe(label, url, opts) {
  try {
    const r = await request(opts.method || 'GET', url, { ...opts, jar, follow: false });
    const body = r.body.slice(0, 220).replace(/\s+/g, ' ');
    console.log(`\n[${label}] HTTP ${r.status}`);
    console.log('  ' + body);
    return body;
  } catch (e) {
    console.log(`\n[${label}] 异常: ${e.message}`);
    return '';
  }
}

// 1) 不带 token
await probe('init 无 token', `${BASE}${ATTN}/init.action`, {
  method: 'POST', headers: { 'Content-Type': 'application/json;charset=UTF-8', Origin: BASE }, body: '{}',
});

// 2) token 用 JSESSIONID
await probe('init token=JSESSIONID', `${BASE}${ATTN}/init.action`, {
  method: 'POST',
  headers: { token: jsid, 'Content-Type': 'application/json;charset=UTF-8', Origin: BASE },
  body: '{}',
});

// 3) 带 contextPath 参数重走 index.action，看会不会自己发 token
const idx = await request('GET', `${BASE}/plug-in${ATTN}/index.action?contextPath=`, { jar, follow: false });
console.log(`\n[index.action 无 token] HTTP ${idx.status}  ${idx.body.slice(0, 150).replace(/\s+/g, ' ')}`);

// 4) 试探 authorize 的多种入口
for (const p of [
  `${ATTN}/oauth2/authorize.action`,
  `${ATTN}/oauth2/authorize.action?response_type=code`,
  `/plug-in${ATTN}/index.action`,
]) {
  const r = await request('GET', `${BASE}${p}`, { jar, follow: true });
  const tok = /[?&]token=([A-Za-z0-9]+)/.exec(r.url);
  console.log(`\n[authorize ${p}] → ${r.url.slice(0, 110)}`);
  if (tok) console.log('  ✔ 拿到 token =', tok[1]);
}

// 5) 看当前 cookie 全貌
console.log('\n=== cookie ===');
for (const [h, arr] of Object.entries(jar.jar)) console.log(h, '|', arr.map((c) => c.split('=')[0]).join(','));
