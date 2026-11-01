// HTTP 层：一个能自动跟随重定向、自动维护 cookie 的最小客户端
//
// 为什么不用 fetch：需要拿到每一次 set-cookie（SSO 的 TGC 与业务 JSESSIONID
// 分属两个域，必须各自留一份），并且要允许自签证书环境（校园网出口常有
// TLS 中间设备）。node:https 直接可控。

import https from 'node:https';
import http from 'node:http';

export const DEFAULT_UA =
  'Mozilla/5.0 (Linux; Android 15; 23113RKC6C Build/AP3A.240905.015; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';

/** 极简 cookie 罐：按 host 分桶，父域自动匹配子域 */
export class CookieJar {
  constructor(initial = {}) {
    /** @type {Record<string, string[]>} */
    this.jar = {};
    for (const [host, arr] of Object.entries(initial)) {
      this.jar[host] = [...arr];
    }
  }

  /** 取出该 host 可用的全部 cookie（含父域） */
  header(host) {
    const out = [];
    for (const [h, arr] of Object.entries(this.jar)) {
      if (host === h || host.endsWith('.' + h)) out.push(...arr);
    }
    return out.join('; ');
  }

  /** 吸收 set-cookie */
  absorb(host, setCookie) {
    if (!setCookie) return;
    for (const raw of setCookie) {
      const kv = String(raw).split(';')[0];
      const i = kv.indexOf('=');
      if (i <= 0) continue;
      const name = kv.slice(0, i).trim();
      const arr = (this.jar[host] ||= []);
      const idx = arr.findIndex((c) => c.startsWith(name + '='));
      if (idx >= 0) arr[idx] = kv; else arr.push(kv);
    }
  }

  /** 该 host 是否已有某个 cookie */
  has(host, name) {
    return (this.jar[host] || []).some((c) => c.startsWith(name + '='));
  }

  names(host) {
    return (this.jar[host] || []).map((c) => c.split('=')[0]);
  }

  toJSON() {
    return this.jar;
  }
}

function requestOnce(method, url, { headers = {}, body = null, jar, rejectUnauthorized = false, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const h = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers,
    };
    if (jar) {
      const ck = jar.header(u.hostname);
      if (ck) h.Cookie = ck;
    }
    if (body != null) h['Content-Length'] = Buffer.byteLength(body);

    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: h,
        rejectUnauthorized,
        timeout,
      },
      (res) => {
        if (jar) jar.absorb(u.hostname, res.headers['set-cookie']);
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            url,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeout}ms): ${url}`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

/**
 * 发起请求，默认自动跟随 3xx（跟随到最终页，并保留沿途 set-cookie）
 * @returns {Promise<{url:string,status:number,headers:object,body:string}>}
 */
export async function request(method, url, opts = {}) {
  const { follow = true, maxRedirect = 10, ...rest } = opts;
  let current = url;
  let res = await requestOnce(method, current, rest);
  let hops = 0;
  while (follow && res.status >= 300 && res.status < 400 && res.headers.location && hops < maxRedirect) {
    const next = new URL(res.headers.location, current).toString();
    // 3xx 之后统一用 GET（和浏览器行为一致）
    res = await requestOnce('GET', next, rest);
    current = next;
    hops++;
  }
  return res;
}

export const get = (url, opts) => request('GET', url, opts);
export const post = (url, opts) => request('POST', url, opts);

/** 把响应按 JSON 解析，失败时抛出带上下文的错误 */
export function parseJSON(res, label = '响应') {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`${label}不是 JSON（HTTP ${res.status}）：${res.body.slice(0, 300)}`);
  }
}
