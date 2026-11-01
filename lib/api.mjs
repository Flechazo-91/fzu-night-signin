// 接口层：福大「一站式学工 · livecloud · attn」晚点名签到
//
// 全链路（2026-11 实测）：
//
//   GET  /livecloud/project/fzu/attn/oauth2/authorize.action
//        └─ 302 sso.fzu.edu.cn/login?service=…/callback.action
//        └─ 302 …/callback.action?ticket=ST-xxx
//        └─ 302 …/authorize.action?token=<业务 token>
//        └─ 200 …/plug-in/livecloud/project/fzu/attn/index.action?token=…
//   POST /livecloud/project/fzu/attn/init.action             headers:{token}
//   GET  /livecloud/project/fzu/attn/check.action?param=…    headers:{token}
//   GET  /livecloud/project/fzu/attn/clockIn.action?param=…  headers:{token}
//   POST /livecloud/project/fzu/attn/currentTimestamp.action headers:{token}
//
// 签名：全部走 headers 里的 `token`，没有额外 sign/时间戳。

import { request, parseJSON } from './http.mjs';
import { encrypt, decrypt, encodeParam } from './crypto.mjs';

export const HOST = 'yzsxg.fzu.edu.cn';
export const BASE = `https://${HOST}`;
export const ATTN = '/livecloud/project/fzu/attn';

const REFERER = `${BASE}/plug-in${ATTN}/index.action`;
const ORIGIN = BASE;

/**
 * 走完 SSO 拿到业务 token
 * @param {import('./http.mjs').CookieJar} jar
 * @returns {Promise<{token:string, finalUrl:string}>}
 */
export async function fetchToken(jar) {
  const start = `${BASE}${ATTN}/oauth2/authorize.action`;
  const res = await request('GET', start, { jar });
  const m = /[?&]token=([A-Za-z0-9]+)/.exec(res.url) || /[?&]token=([A-Za-z0-9]+)/.exec(res.body);
  if (!m) {
    throw new Error(
      res.url.includes('sso.fzu.edu.cn/login')
        ? 'cookie 已失效（被 SSO 打回登录页），需要重新登录 App 后同步 cookie'
        : `未拿到 token，最终 URL: ${res.url}`
    );
  }
  return { token: m[1], finalUrl: res.url };
}

/**
 * 今日计划 / 校区 / 围栏 / 时段
 * @returns {Promise<{paramsData:object, schoolData:object[], userData:object, mapData:object}>}
 */
export async function fetchInit(jar, token) {
  const res = await request('POST', `${BASE}${ATTN}/init.action`, {
    jar,
    headers: {
      token,
      'Content-Type': 'application/json;charset=UTF-8',
      Origin: ORIGIN,
      Referer: REFERER,
    },
    body: '{}',
    follow: false,
  });
  const j = parseJSON(res, 'init.action ');
  if (!j.success || j.code !== 1) throw new Error('init.action 失败: ' + (j.msg || res.body.slice(0, 200)));
  return j.data;
}

/**
 * 围栏匹配：拿坐标去比对校区多边形
 * @param {object[]|string} range 围栏（原样传 JSON 字符串最稳）
 * @returns {Promise<{success:boolean,code:number,msg:string,data:object[]}>}
 */
export async function fetchCheck(jar, token, { lat, lng, range, mapType = 'amap' }) {
  const plain = {
    mapType,
    longitude: lng,
    latitude: lat,
    // 前端就是 JSON.stringify(schoolPosition)；传数组会被判「当前点不在选定的范围区域内」
    range: typeof range === 'string' ? range : JSON.stringify(range),
  };
  const res = await request('GET', `${BASE}${ATTN}/check.action?param=${encodeParam(plain)}`, {
    jar,
    headers: { token, Origin: ORIGIN, Referer: REFERER },
    follow: false,
  });
  return parseJSON(res, 'check.action ');
}

/**
 * 打卡
 * @param {object} payload 见 buildClockPayload()
 */
export async function clockIn(jar, token, payload) {
  const res = await request('GET', `${BASE}${ATTN}/clockIn.action?param=${encodeParam(payload)}`, {
    jar,
    headers: { token, Origin: ORIGIN, Referer: REFERER },
    follow: false,
  });
  return parseJSON(res, 'clockIn.action ');
}

/** 服务端时间（判断时间窗用，别信本机时钟） */
export async function fetchServerTime(jar, token) {
  const res = await request('POST', `${BASE}${ATTN}/currentTimestamp.action`, {
    jar,
    headers: { token, 'Content-Type': 'application/json;charset=UTF-8', Origin: ORIGIN },
    body: '{}',
    follow: false,
  });
  const j = parseJSON(res, 'currentTimestamp.action ');
  return j?.data?.timestamp ?? null;
}

/**
 * 组装打卡请求体。字段来源见 tools/docs/api.md
 * @param {object} p
 * @param {string|number} p.campusId   命中的校区 id
 * @param {string} p.campusTitle       命中的校区名
 * @param {number} p.lat
 * @param {number} p.lng
 * @param {string} p.startTime         paramsData.FStartTime（**原样带尾部空格，不要 trim**）
 * @param {string} p.endTime           paramsData.FEndTime
 * @param {object} p.userData
 * @param {string} p.address           逆地理地址（拼接进 actualLocation）
 * @param {0|1} p.isLate
 */
export function buildClockPayload({ campusId, campusTitle, lat, lng, startTime, endTime, userData, address, isLate }) {
  return {
    campus: String(campusId),
    lon: lng,
    lat,
    startTime,
    endTime,
    actualLocation: `${campusTitle} ${address}`,
    caIsNo: '0',
    collUnit: userData.FCollUnit,
    way: userData.FWay,
    isLate,
  };
}

export { encrypt, decrypt, encodeParam };
