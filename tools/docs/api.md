# 接口与字段（逆向前端得到）

> 这一页是把 `assets/index-*.js` 读完之后整理出来的，用来解释**为什么代码里是这么写的**。
> 服务端随时可能改，改了就按这里的思路重新对一遍。

## 0. 定位：谁在拦，拦什么

| 层 | 有什么 | 拦不拦打卡 |
|---|---|---|
| App（Flutter） | `isFromMockProvider` / `EXTRA_IS_MOCK` / `isInstalledHighDangerMockApp` | 拦「App 内点按钮」 |
| 高德 AMapLocation SDK | 错误码 `#1501` GPS 被模拟 / `#1502` 网络定位被模拟 / `#2007` 粗定位被模拟 | 拦「拿到坐标」 |
| **服务端** | `check.action` 只比围栏多边形、`clockIn.action` 只收字段 | **不看坐标来源** |

结论：**不要去骗高德，直接不走它**。前端校验得再密，只要请求能自己构造，校验就只在"帮用户少犯错"，不在"证明你在现场"。

## 1. 链路

```
GET  /livecloud/project/fzu/attn/oauth2/authorize.action
     ├─ 302  https://sso.fzu.edu.cn/login?service=…%2Fcallback.action
     ├─ 302  https://yzsxg.fzu.edu.cn/livecloud/project/fzu/attn/oauth2/callback.action?ticket=ST-…
     ├─ 302  …/authorize.action?token=<业务 token>
     └─ 200  …/plug-in/livecloud/project/fzu/attn/index.action?token=…&contextPath=
```

`sso.fzu.edu.cn` 的 `SESSION` / `SOURCEID_TGC` 让第 2 跳直接通过；`token=` 是业务侧的一次性凭据，后续请求放在 **header** 里。

## 2. 五个接口

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/livecloud/project/fzu/attn/oauth2/authorize.action` | cookie | 走 SSO，最终 URL 上带 `token=` |
| POST | `/livecloud/project/fzu/attn/init.action` | `token` header | 今日计划、时段、校区、围栏、用户信息 |
| GET | `/livecloud/project/fzu/attn/check.action?param=…` | `token` header | 围栏匹配，返回命中的多边形数组 |
| GET | `/livecloud/project/fzu/attn/clockIn.action?param=…` | `token` header | **打卡** |
| POST | `/livecloud/project/fzu/attn/currentTimestamp.action` | `token` header | 服务端时间（判断时间窗用） |

统一响应包：

```json
{ "success": true, "code": 1, "msg": "", "data": … }
```

`success && code === 1` 才算成功。

## 3. 加密

前端打包后的关键片段：

```js
const KEY = "apexinfoapexinfo";
function Encrypt(o) {
  const a = CryptoJS.enc.Utf8.parse(KEY);                    // key
  const j = CryptoJS.enc.Utf8.parse(KEY);                    // iv = key
  const et = CryptoJS.enc.Utf8.parse(typeof o == "string" ? o : JSON.stringify(o));
  return CryptoJS.AES.encrypt(et, a, {
    iv: j, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
  }).toString();
}
```

→ **AES-128-CBC / key = iv = `apexinfoapexinfo` / Pkcs7 / Base64**（无 salt 前缀）。

等价实现见 `lib/crypto.mjs`。

## 4. 两个必须踩准的坑

### 4.1 `param` 是**双重** URL 编码

```js
createEncryptApi = (o) => (a) =>
  axios.get(`${getBaseName()}${o}`, { headers:{ token: getToken() }, params: a });

// 调用处
await tn({ param: encodeURIComponent(Encrypt(qt)) });
```

`axios` 对 `params` 的值会**再编码一次**，服务端只解一层。所以线上 URL 上是双重编码。

| 编码次数 | 服务端返回 |
|---|---|
| 1 次 | `{"success":false,"code":0,"msg":"打卡地点校验发生异常"}` |
| **2 次** | `{"success":true,"code":1,…}` |

代码里对应 `encodeParam()`。

### 4.2 `range` 要传 **JSON 字符串**

```js
const Tt = { mapType:"amap", longitude: St, latitude: Dt, range: JSON.stringify(ft) };
```

`ft` 是 `JSON.parse(schoolData[0].FPosition)` 得到的对象，再用 `JSON.stringify` 变回字符串。

| `range` 类型 | 服务端返回 |
|---|---|
| 数组 | `当前点不在选定的范围区域内` |
| 缺省 | `当前点不在选定的范围区域内` |
| **JSON 字符串** | `{"success":true,"code":1,…}` |

## 5. 字段来源

### init.action

```jsonc
{
  "paramsData": {
    "FStartTime": "21:00     ",   // ← 尾部带空格，原样传给 clockIn，不要 trim
    "FEndTime":   "23:59     ",
    "FLateTime":  "22:30     ",   // 迟到线
    "FToday": "2026-11-01  星期日",
    "PD": "2026-11-01"
  },
  "schoolData": [
    { "ID": "2", "FName": "旗山校区", "FPosition": "{\"range\":[…],\"mapType\":\"amap\"}" }
  ],
  "userData": {
    "FName": "…", "UserId": "…", "FClass": "…",
    "FState": "未签到 | SUCCESS",   // ← 判重就看它
    "FCheckInTime": "2026-11-01 22:12:16 已签到",
    "FActualLocation": "旗山校区 …",
    "FCollUnit": 35,                // 学院 id（数字）
    "FWay": 1,                      // 1 校内 / 2 外勤 / 3 无需签到
    "FPlanID": 12345678,
    "FCampus": "2"
  }
}
```

### clockIn.action 请求体

```json
{
  "campus": "2",
  "lon": 119.196,
  "lat": 26.056,
  "startTime": "21:00     ",
  "endTime": "23:59     ",
  "actualLocation": "旗山校区 福建省福州市闽侯县上街镇学园路2号",
  "caIsNo": "0",
  "collUnit": 35,
  "way": 1,
  "isLate": 0
}
```

| 字段 | 来源 | 注意 |
|---|---|---|
| `campus` | `check.action` 返回值里的 `id` | 字符串 |
| `lon` / `lat` | 自己给的坐标 | GCJ-02 |
| `startTime` / `endTime` | `paramsData.FStartTime/FEndTime` | **保留尾部空格** |
| `actualLocation` | `${校区名} ${逆地理地址}` | 只做展示 |
| `caIsNo` | 前端 `readLocationValue("FCaIsNo") \|\| "0"` | 默认 `"0"` |
| `collUnit` | `userData.FCollUnit` | **数字**，不是字符串 |
| `way` | `userData.FWay` | 1/2/3 |
| `isLate` | 当前分钟 > `FLateTime` ? 1 : 0 | 用**服务端时间**算 |

### clockIn.action 成功回执

```json
{
  "success": true, "code": 1, "msg": "",
  "data": {
    "msg": "打卡成功",
    "attn": {
      "lon": "119.196", "lat": "26.056",
      "checkInDate": "2026-11-01",
      "checkInTime": "2026-11-01 22:12:16",
      "actualLocation": "旗山校区 …",
      "campus": "2", "collUnit": "35", "way": "1", "isLate": "0",
      "plan": "12345678"
    },
    "async": true, "userId": "…"
  }
}
```

重复提交 → `{"success":false,"code":0,"msg":"请勿重复打卡"}`。

## 6. 围栏几何

`FPosition` 是 GeoJSON 风格的 `range` 数组，每项 `{ id, type: "polygon"|"rectangle", title, paths, fillColor }`：

- `polygon`：`paths` 是顶点数组 `[[lng, lat], …]`
- `rectangle`：`paths` 是**两个对角点**

2026-11 旗山校区的实测范围：`lng 119.186648 ~ 119.206454` / `lat 26.047018 ~ 26.067868`。
默认坐标 `26.056, 119.196` 落在主多边形内部。

⚠️ 模拟器里那个 `26.0735, 119.1960`（很多人从地图上直接抄的）**纬度超了上界**，
所以 App 会显示「不在签到范围内」—— 那不是 App 的问题，是坐标出界了。

## 7. 页面状态为什么不可信

签到页是 React SPA，只在进入时请求一次 `init.action`，之后**不轮询**。
打完卡后再看那个页面，它还是进入时那份数据 —— 显示「未签到」很正常。

判断状态请用 `fzu-signin status`（每次重新 `init`），或者杀掉 App 进程重进。
