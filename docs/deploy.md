# KidsEnglish 服务器部署与运维清单（家庭自托管）

> 威胁模型：**家庭局域网 / 本机回环 / USB 隧道**。服务只绑定 `127.0.0.1`，
> 数据只落自家电脑本地磁盘（`server/data/`）。本文档与部署脚本**均不提供、
> 不支持任何公网暴露**——路由器端口转发、`0.0.0.0` 绑定、云服务器部署一律
> 不在支持范围（已知边界：令牌是全家唯一凭据、未分人分权，公网暴露＝任何人
> 拿令牌即可读写全部孩子数据，故按设计禁绝）。

本文所有命令的运行环境＝**Windows PowerShell 5.1**（Windows 10/11 自带，
开始菜单搜 "PowerShell" 即可）。可整段复制执行。

---

## 一、前置

| 项 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | Windows 10/11 | 脚本用 icacls/Get-NetTCPConnection，Windows 自带 |
| Python | 3.10+（实测锁定 3.11） | 安装时勾选 "Add python.exe to PATH" |
| 磁盘 | 数百 MB 级 | venv＋依赖＋词包数据 |
| 端口 | 默认 `8000`（仅回环） | 换端口：脚本加 `-Port 9000` |
| 仓库 | 本仓库一份本地副本 | 脚本按仓库内相对路径自定位 |

首次部署（除 Python 本体外全自动，一次跑通）：

```powershell
# 一键部署：建/复用 venv → 装依赖 → 数据库迁移 → 生成令牌并收紧权限 → 启动 → 健康探活
powershell -ExecutionPolicy Bypass -File E:\kidsenglish\server\scripts\deploy.ps1
```

日常启动（不装依赖、不重复迁移，前台运行，关窗即停）：

```powershell
# 日常启动：核对数据库版本一致后直接拉起服务
powershell -ExecutionPolicy Bypass -File E:\kidsenglish\server\scripts\start.ps1
```

---

## 二、连接（令牌与设备）

### 2.1 家庭令牌

- 位置：`server/data/family_token`（首次部署自动生成；已存在则**绝不覆盖**）。
- 权限：部署脚本已用 `icacls` 收紧为**仅当前用户＋SYSTEM** 可读写（NTFS ACL；
  Windows 下 `os.chmod` 只切只读位，故收紧走 icacls 而非 chmod）。
- 查看令牌：

```powershell
# 打印当前令牌（配置设备时用，勿截图外传）
Get-Content E:\kidsenglish\server\data\family_token
```

- **换发流程**（怀疑泄露/换全家密码时）：重命名旧令牌文件 → 重启服务（自动
  生成新令牌）→ 所有设备更新令牌。旧令牌即刻失效（服务端只认新文件内容）。

```powershell
# 换发三步：改名留底 → 重启 → 读新令牌
Rename-Item E:\kidsenglish\server\data\family_token family_token.bak
# 重启：先停止旧进程（见「五、常见故障」的停止命令），再跑 start.ps1 或 deploy.ps1
powershell -ExecutionPolicy Bypass -File E:\kidsenglish\server\scripts\start.ps1
Get-Content E:\kidsenglish\server\data\family_token
```

### 2.2 设备连接（Android 应用壳）

默认路径＝**USB 隧道（adb reverse）**：设备经 USB 连电脑，壳内应用访问
`http://localhost:8000` 即隧道回环到电脑本机服务，零公网、零局域网暴露。

```powershell
# 每次连设备跑一次（设备经 USB 已连接、已开 USB 调试）；拔插后失效需重跑
adb reverse tcp:8000 tcp:8000
```

- 应用侧服务器地址默认 `http://localhost:8000`（可经构建期 `VITE_SERVER_URL`
  注入覆盖）；家庭令牌经构建期 `VITE_FAMILY_TOKEN` 注入（客户端配置面，
  见 `client/app/src/store/profile.ts`）。
- CORS 白名单现状：服务端只接受 `https://localhost`（Capacitor 原生壳）与
  `http://localhost:5173`（Vite 开发服务器）两个 origin。
- **新设备 origin 如何加白**：只允许改 `server/app/config.py` 的
  `DEFAULT_CORS_ORIGINS` 常量（或经 `Settings(cors_origins=...)` 注入），
  改完重启服务生效。禁任何 "临时关掉 CORS/允许任意 origin" 的做法。
- 局域网 IP 直连：**不在默认部署面**。当前部署只绑回环；跨设备请走上面的
  adb reverse。局域网/内网隧道（如 Tailscale）属进阶场景，需同时调整绑定与
  origin 白名单并自行评估内网信任面，本文档不展开、脚本不提供。

---

## 三、备份

全部状态都在一个目录：`server/data/`（SQLite 主库 `kidsenglish.db`＋WAL/SHM
伴随文件＋令牌＋词包）。备份＝冷拷贝该目录。

```powershell
# 1) 停止服务（冷备前提，见「五」的停止命令；或临时用 start.ps1 窗口 Ctrl+C）
# 2) 整目录冷拷贝（日期后缀，多版本留存）
$stamp = Get-Date -Format yyyyMMdd-HHmmss
Copy-Item -Recurse E:\kidsenglish\server\data "E:\backup\kidsenglish-data-$stamp"
# 3) 重新启动服务
powershell -ExecutionPolicy Bypass -File E:\kidsenglish\server\scripts\start.ps1
```

- **停机窗口建议**：备份务必在服务停止后进行（热拷贝可能截断 WAL 事务）；
  全程约 1-2 分钟。恢复＝把备份目录内容拷回 `server/data/`（先停服务）。
- 令牌文件随目录一起备份；只恢复了部分文件时，保证 `family_token` 与
  `kidsenglish.db` 同批恢复即可。

---

## 四、升级

升级＝拉新代码 → 重跑部署脚本。`deploy.ps1` 幂等：venv 复用、依赖按需增量装、
`alembic upgrade head` 只补落后版本、令牌不覆盖、权限重设无害。

```powershell
# 1) 停止旧进程（新代码需重启才生效；停止命令见「五」）
# 2) 拉取新代码
cd E:\kidsenglish ; git pull
# 3) 重跑一键部署（幂等，自动补迁移）
powershell -ExecutionPolicy Bypass -File E:\kidsenglish\server\scripts\deploy.ps1
```

- 迁移有真实库保障：脚本对 `server/data/kidsenglish.db` 实跑
  `alembic upgrade head`（遵守数据库迁移纪律），失败即中止不半启动。
- 升级不换令牌、不动孩子数据。

---

## 五、日志与常见故障

- 日志位置（deploy.ps1 后台启动时）：`server/data/server.out.log`（标准输出）
  与 `server/data/server.err.log`（标准错误）；**每次启动覆盖旧日志**。
  `start.ps1` 前台启动时日志直接打在当前窗口。

**停止服务**（deploy.ps1 启动的后台进程）：

```powershell
# 找到 8000 端口的监听进程并停止（先看 PID 确认是 python 再停）
$conn = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($conn) { Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" | Select-Object ProcessId, CommandLine ; Stop-Process -Id $conn.OwningProcess -Force }
```

| 症状 | 排查与处理 |
| --- | --- |
| 部署脚本报 "端口 8000 已被其他程序占用" | 别的程序占了 8000：`Get-NetTCPConnection -LocalPort 8000 -State Listen` 看 PID → `Get-CimInstance Win32_Process -Filter "ProcessId=<PID>"` 看是谁；换端口 `deploy.ps1 -Port 9000` 或关掉占用者 |
| 部署脚本报 "未找到 python" | 安装 Python 3.11+，重开 PowerShell 再跑（PATH 才会刷新） |
| healthz 探活失败（30 秒超时） | 看 `server/data/server.err.log` 尾部：依赖缺＝重跑 deploy.ps1；`alembic` 报错＝按日志修复后重跑 |
| 设备连不上（应用内同步失败） | ① 电脑服务在跑吗：浏览器开 `http://127.0.0.1:8000/healthz` 应显示 `{"status":"ok"}`；② adb reverse 重跑了吗：拔插 USB 后需重新执行；③ 令牌对吗：对照 `server/data/family_token` 与设备构建配置 |
| 同步返回 401 | 令牌不匹配：换发过令牌后设备侧需更新 `VITE_FAMILY_TOKEN` 并重新构建 |
| 启动慢/内存占用 | 本机单进程 uvicorn＋SQLite 常驻约百 MB 级 RAM；若整机吃紧，关服后再跑（数据不丢，WAL 自动恢复） |
| 误删/损坏 `kidsenglish.db` | 用「三、备份」的最近备份整目录恢复（先停服务） |

---

## 附：单 worker 约束（为什么不能多开）

服务端是 SQLite＋StaticPool 单写拓扑（`server/app/db.py`）：整个应用共享**一条**
数据库连接，写操作在单进程内天然串行。多个 worker＝多个进程各持连接并发写
SQLite，会撞锁甚至损坏数据。因此启动参数写死 `--workers 1`（deploy.ps1 与
start.ps1 均已固化），**不要改大**；将来真要多机/多实例，需先换 Postgres 级
数据库方案，不在本项目范围内。
