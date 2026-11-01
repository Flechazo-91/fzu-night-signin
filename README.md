# fzu-night-signin

> 福大晚点名签到：**每晚 21:30 自动打完，不伪造 GPS、不 hook 高德、不跑 UI 自动化。**
>
> 签到页的定位与反模拟校验**全在前端**；服务端只做一件事——拿经纬度比对校区围栏多边形。
> 所以这个项目不跟高德较劲，它直接把请求自己构造出来。

---

## 它能做什么

- **每晚 21:30 自动签到**：计划任务触发 → 同步会话 → 提交 → 写日志
- **人在哪都行**：服务端只校验坐标是否落在围栏内，不校验真实位置
- **失败会自愈**：会话过期 → 自动唤醒 App 重建 SSO 会话 → 再试一次
- **幂等**：已经签过、今天无需签到、不在时段，都会**直接退出且不发任何写请求**
- **可查状态**：`status` 每次重新拉服务端数据，不受 App 页面缓存影响
- **可演练**：`--dry` 走完整流程但不提交，坐标随便改
- **零常驻**：没有守护进程、没有数据库、没有框架依赖，状态就是几个普通文件

## 它**不会**做什么

- ❌ 伪造 GPS / 注入 Location / 改系统定位（**根本不需要**——见「为什么这样能成」）
- ❌ 反编译改包 / 注入 so / 装 Xposed 模块
- ❌ 跑无障碍点击、模拟人手点按钮
- ❌ 存储你的密码（cookie 从模拟器现拉，`~/.fzu-night-signin/` 下，不进仓库）
- ❌ 多账号 / 批量刷 / 代签

---

## 装

**前提**：Node **22.5+**（读 cookie 库用内置 `node:sqlite`）；一个装好「智汇福大」并已登录的 Android 模拟器（MuMu / 夜神 / 雷电都行，改配置里的 adb 路径即可）。

```bash
git clone https://github.com/<you>/fzu-night-signin.git
cd fzu-night-signin

# 1) 从模拟器同步会话（App 必须已登录）
node tools/fzu.mjs cookies

# 2) 启动测试
node tools/fzu.mjs selftest

# 3) 注册每天 21:30 的计划任务（Windows）
powershell -ExecutionPolicy Bypass -File scripts/install-task.ps1
```

第一次运行会自动生成 `~/.fzu-night-signin/config.json`（**不含凭据**）。
要改坐标 / adb 路径就改它，样例见 [`examples/config.example.json`](examples/config.example.json)。

### 命令一览

```bash
node tools/fzu.mjs selftest        # 装完立刻跑这条
node tools/fzu.mjs doctor          # 五项自检
node tools/fzu.mjs status          # 查今天状态（只读）
node tools/fzu.mjs sign            # 立刻签一次
node tools/fzu.mjs sign --dry      # 演练，不提交
node tools/fzu.mjs sign --lat=26.056 --lng=119.196
node tools/fzu.mjs run             # 定时任务入口（带自愈重试）
node tools/fzu.mjs cookies         # 只同步 cookie
```

---

## 🚦 启动测试（装完**立刻**跑这一条）

```bash
node tools/fzu.mjs selftest
```

它会列成一张表，缺哪项说哪项：

```
────────── 启动测试 ──────────

  Node 版本     ✓   24.21.0
  cookie 解析   ✓   node:sqlite
  配置文件        !   …\config.json
  模拟器         ✓   127.0.0.1:16416
  cookie        ✓   已同步
  登录态         ✓   token 正常
  今日状态        ✓   SUCCESS  2026-11-01 22:12:16
  签到时段        ✓   21:00-23:59
  围栏命中        ✓   26.056,119.196 → 旗山校区
  计划任务        ✓   FZU晚点名签到 每天 21:30

══════════ 全部通过 ✓ 可以用了 ══════════
```

### 最容易卡的三件事

| 症状 | 真正原因 |
|---|---|
| `cookie 已失效（被 SSO 打回登录页）` | 模拟器里 App 掉登录了。打开 App 完成一键登录，再 `cookies` 一次 |
| `坐标 … 不在任何校区围栏内` | 坐标出界。`doctor` 会打印当前围栏的经纬度范围，照着改 `config.json` 里的 `lat`/`lng` |
| 计划任务 `LastTaskResult != 0` | 大多是没有桌面会话。任务必须**用户登录时**才跑（模拟器要图形界面） |

---

## 为什么这样能成

### 原来的死结

「在模拟器里改定位」这条路怎么走都会踩雷，因为拦你的有三层：

1. **App 层**：`isFromMockProvider()`、`EXTRA_IS_MOCK`、以及 `isInstalledHighDangerMockApp`（扫已装的虚拟定位 App 包名）
2. **高德 SDK 层**：分来源的风控错误码 —— `#1501` GPS 被模拟、`#1502` 网络定位被模拟、`#2007` 粗定位被模拟
3. **网络定位层**：坐标来自 `apilocate.amap.com` 的基站/WiFi 反查，模拟器里没有真实基站指纹

### 真正的突破口

签到页是 React H5，定位经 JSBridge 从原生拿。而**服务端只做三件事**：

- `check.action`：拿经纬度比对围栏多边形
- `clockIn.action`：收下坐标、校区、时段，写一条考勤
- 时间窗 21:00–23:59，迟到线 22:30

**它不问坐标从哪来。** 于是整条链路在协议层重建：

```
oauth2/authorize.action   (SSO cookie → ticket → token)
  → init.action           今日计划 / 时段 / 校区 / 围栏
  → check.action          命中哪个校区
  → clockIn.action        打卡
```

加密也挖出来了：前端 `Encrypt()` 是 **AES-128-CBC，key=iv=`apexinfoapexinfo`**，Pkcs7 + Base64。

两个必须踩准的坑（都写进代码了）：

| 坑 | 踩错的报错 |
|---|---|
| `param` 要**双重** URL 编码（axios 二次编码、服务端只解一层） | `打卡地点校验发生异常` |
| `range` 传 **JSON 字符串**，不是数组 | `当前点不在选定的范围区域内` |

完整的接口、字段、围栏几何见 [`tools/docs/api.md`](tools/docs/api.md)。

---

## 运行时序

```
1. 找模拟器（没开就 MuMuManager launch，最多等 120s）
2. adb root → 拉 App 的 WebView Cookies 库 → 解析出两域 cookie
3. cookie 换 token → init 取今日计划
4. 已签到 / way=3            → 退出 0（零写请求）
5. 不在 21:00-23:59          → 退出 3（调度器按 10 分钟重试）
6. 逐个校区试围栏             → 命中才继续，否则退出 4
7. clockIn 提交
8. 失败且像是会话问题         → 唤醒 App 重建会话 → 再试一次
```

计划任务配了 3 次重试、间隔 10 分钟，叠加 21:30 触发后的几个重试点，都赶在 22:30 迟到线之前。

### 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含「本来就不用签」「已签过」） |
| 1 | 失败 |
| 2 | 参数错误 |
| 3 | 不在签到时段 |
| 4 | 坐标不在围栏内 |
| 5 | 会话/凭据问题 |

---

## 查状态要看对地方

**不要看 App 页面。** 那个 H5 是 SPA，进页面只请求一次 `init.action`，之后不轮询——打完卡它还显示「未签到」。

```bash
node tools/fzu.mjs status
```

```
  姓名     张三
  学号     2023000000
  班级     2023级本科某某专业01班
  日期     2026-11-01
  时段     21:00 - 23:59（迟到线 22:30）
  状态     ✔ SUCCESS  2026-11-01 22:12:16 已签到
  位置     旗山校区 福建省福州市闽侯县上街镇学园路2号
  校区     旗山校区#2
           旗山校区围栏 lng 119.186648~119.206454 / lat 26.047018~26.067868（2 块）
```

---

## 依赖与移植性（**装之前先读这节**）

这套东西不是开箱即用的通用件，它建立在几个假设上：

| 假设 | 为什么依赖它 | 换环境怎么办 |
|---|---|---|
| **有一个登录着的模拟器** | cookie 由 App 的一键登录维持，本项目只"借"它 | 真机也行 —— 改 `config.emulator.adb` 指向那个设备的 adb，`cookieDb` 路径不变；不需要 root 的替代方案见下 |
| **adb 能拿到 root** | 读 `/data/data/<pkg>/app_webview/` 需要 | 免 root：用 `adb backup` 或让 App 自己导出（见「免 root」一节） |
| **服务端接口没改** | 一切基于 2026-11 的实测 | 改了就看 [`tools/docs/api.md`](tools/docs/api.md) 重新对一遍，结构都在里面 |
| **Node 22.5+** | `node:sqlite` 读 cookie 库 | 低版本会降级成二进制扫描，可能漏 cookie |
| **Windows**（脚本层） | `scripts/install-task.ps1` 用计划任务 | Linux/macOS 换成 `cron` / `launchd`，只跑 `node tools/fzu.mjs run` 一条 |

**不依赖什么**：没有数据库、没有守护进程、没有框架、没有云服务、没有第三方 npm 包（零依赖）。
状态全在 `~/.fzu-night-signin/` 下几个普通文件里，人随时能打开看。

> ⚠️ 已知硬缺口：**电脑关机/睡眠的那天不会打卡**。任务只能在用户登录桌面时跑（模拟器要图形会话）。
> 要彻底摆脱这个前提，就得把 `cookies` 那一步换成自己走 SSO 登录 —— 那需要你的学号密码，本项目刻意不做。

---

## 免 root 的做法（可选）

不想给模拟器 root 的话，cookie 库拿不到，但可以让 App 把会话暴露出来：

1. App 是 Flutter 壳 + H5，H5 的 cookie 走系统 WebView。**开一次 USB 调试 + `chrome://inspect`**
   能看到 WebView 的 cookie（需要 App 开了 `setWebContentsDebuggingEnabled`，本项目没有验证过这条路）。
2. 更稳的：自己用浏览器登录 `sso.fzu.edu.cn`，把 `yzsxg.fzu.edu.cn` / `sso.fzu.edu.cn` 两域 cookie
   导出成 `--jar` 认的格式：

```json
{
  "yzsxg.fzu.edu.cn": ["JSESSIONID=…", "web_route=…"],
  "sso.fzu.edu.cn": ["SESSION=…", "SOURCEID_TGC=…", "rg_objectid=…"]
}
```

然后 `node tools/fzu.mjs sign --jar=my-cookies.json --no-adb`。

代价是 cookie 会过期，得手动续。

---

## 目录

```
lib/
  crypto.mjs    前端加密的等价实现（AES-128-CBC / key=iv）
  http.mjs      零依赖 HTTP + cookie 罐
  api.mjs       五个接口 + 打卡请求体组装
  state.mjs     纯判定：状态/时间窗/迟到/围栏
  adb.mjs       设备发现、cookie 拉取、会话预热
  sign.mjs      编排：判定 → 提交 → 回执
  config.mjs    配置与路径
tools/
  fzu.mjs       主入口（fzu-signin <command>）
  commands/     sign / status / run / cookies / doctor
  verify/       selftest
  lib/          参数解析、日志、运行时准备
  docs/api.md   接口与字段说明
scripts/
  install-task.ps1   Windows 计划任务
examples/
  config.example.json
```

---

## 许可

MIT（见 [`LICENSE`](LICENSE)）。第三方与免责见 [`NOTICE.md`](NOTICE.md)。

本项目是**个人自用工具的公开版**，与福州大学及高德均无隶属关系；
它用**你自己的账号**做考勤，后果自负。别拿它代签别人。
