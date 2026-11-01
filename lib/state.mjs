// 判定层：把服务端返回的原始字段翻译成「能不能签 / 该签哪个校区 / 是否迟到」
//
// 这一层是纯函数，没有 IO —— 方便单测，也方便你拿真实返回值对拍。

/** 视为「今天已完成」的 FState 取值 */
export const SIGNED_STATES = ['SUCCESS', '已签到', '已打卡', '已点名'];

/** 打卡方式（服务端 userData.FWay） */
export const CLOCK_WAY = {
  /** 校内打卡：必须命中围栏 */
  School: 1,
  /** 外勤打卡：不限围栏 */
  Outside: 2,
  /** 无需签到 */
  NeedNot: 3,
};

/** "21:00     " → 21*60 = 1260（服务端返回的时段字段尾部带空格，必须容忍） */
export function toMinutes(hhmm) {
  const m = /^\s*(\d{1,2})\s*:\s*(\d{1,2})/.exec(String(hhmm ?? ''));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!(h >= 0 && h <= 23 && min >= 0 && min <= 59)) return null;
  return h * 60 + min;
}

/** 今天是否已签到 */
export function isSigned(state) {
  if (!state) return false;
  const s = String(state);
  return SIGNED_STATES.some((x) => s.includes(x));
}

/** 是否在校内打卡模式（需要围栏命中） */
export function needsGeofence(way) {
  return Number(way) === CLOCK_WAY.School;
}

/** 今天是否根本不用签 */
export function needsNoClock(way) {
  return Number(way) === CLOCK_WAY.NeedNot;
}

/**
 * 时间窗判定
 * @param {Date} now 服务端时间
 * @param {string} start '21:00'（可带尾部空格）
 * @param {string} end   '23:59'
 * @returns {{inWindow:boolean, nowMinutes:number|null, startMinutes:number|null, endMinutes:number|null, reason:string}}
 */
export function checkWindow(now, start, end) {
  const s0 = toMinutes(start);
  const s1 = toMinutes(end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (s0 == null || s1 == null) {
    return { inWindow: false, nowMinutes: cur, startMinutes: s0, endMinutes: s1, reason: '时段字段无法解析' };
  }
  // 支持跨零点（如 22:00-01:00）
  const inWindow = s1 >= s0 ? cur >= s0 && cur <= s1 : cur >= s0 || cur <= s1;
  return {
    inWindow,
    nowMinutes: cur,
    startMinutes: s0,
    endMinutes: s1,
    reason: inWindow ? '' : `不在签到时段 (${String(start).trim()}-${String(end).trim()})`,
  };
}

/**
 * 迟到判定：前端用「当前分钟 > 迟到线」=> isLate=1
 * @returns {0|1}
 */
export function isLate(now, lateTime) {
  const limit = toMinutes(lateTime);
  if (limit == null) return 0;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur > limit ? 1 : 0;
}

/**
 * 从 check.action 的返回里挑出命中校区
 * @param {{success:boolean,data?:object[]}} res
 * @returns {{id:string,title:string}|null}
 */
export function pickMatchedCampus(res) {
  if (!res || !res.success || !Array.isArray(res.data) || res.data.length === 0) return null;
  const first = res.data[0] || {};
  return { id: String(first.id ?? ''), title: String(first.title ?? '') };
}

/**
 * 围栏多边形顶点（只取主多边形，用来给 doctor 打印范围）
 * @param {string|object} fposition schoolData[i].FPosition
 */
export function describeFence(fposition) {
  let obj;
  try {
    obj = typeof fposition === 'string' ? JSON.parse(fposition) : fposition;
  } catch {
    return null;
  }
  const polys = (obj?.range || []).filter((r) => r.type === 'polygon' && Array.isArray(r.paths) && r.paths.length);
  if (!polys.length) return null;
  const main = polys.find((p) => String(p.fillColor).toUpperCase() === '#0FAB6B') || polys[0];
  const lngs = main.paths.map((p) => Number(p[0]));
  const lats = main.paths.map((p) => Number(p[1]));
  return {
    title: main.title,
    count: polys.length,
    lng: [Math.min(...lngs), Math.max(...lngs)],
    lat: [Math.min(...lats), Math.max(...lats)],
  };
}
