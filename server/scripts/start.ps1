# ============================================================================
# KidsEnglish 日常启动脚本（deploy.ps1 之后的日常入口）
# ----------------------------------------------------------------------------
# Shell   : Windows PowerShell 5.1 兼容
# 用法    : powershell -ExecutionPolicy Bypass -File server\scripts\start.ps1
#           可选参数: -Port 8000
# 行为    : 复用 deploy.ps1 建好的 venv；库已存在时跳过 migrate 前置步骤，
#           直接核对 alembic head 一致性（不一致才补跑 upgrade，幂等）。
#           服务在前台运行（本窗口保留即服务在线；Ctrl+C 或关窗即停止）。
# 幂等性  : 服务已运行（healthz 200）则提示并直接退出，不抢端口。
# 红线    : 只绑定 127.0.0.1 回环；禁公网暴露（同 deploy.ps1）。
# 首次使用: 请先运行 deploy.ps1（本脚本不建 venv、不装依赖）。
# ============================================================================
param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

# ---- 步骤 0: 路径定位 ----------------------------------------------------
$ServerRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path (Join-Path $ServerRoot ".venv") "Scripts\python.exe"
$DataDir    = Join-Path $ServerRoot "data"
$BindHost   = "127.0.0.1"   # 写死回环；禁 0.0.0.0（家庭局域网威胁模型）

Write-Host "=== KidsEnglish 启动（server 根: $ServerRoot）==="

# ---- 步骤 1: 环境检查（不重建，缺了就指回 deploy.ps1）--------------------
if (-not (Test-Path $VenvPython)) {
    Write-Error "未找到 venv（$VenvPython）。首次部署请先运行: powershell -ExecutionPolicy Bypass -File server\scripts\deploy.ps1"
    exit 1
}

# ---- 步骤 2: 已在运行？→ 幂等退出 ----------------------------------------
$HealthUrl = "http://${BindHost}:${Port}/healthz"
try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) {
        Write-Host "服务已在运行（healthz 200，$HealthUrl），本次不重复启动。"
        exit 0
    }
} catch { }

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Error "端口 $Port 已被其他程序占用（且不是 KidsEnglish）。请用 -Port 换端口或释放该端口。"
    exit 1
}

# ---- 步骤 3: 库存在性 + alembic head 一致性（不盲目 migrate）--------------
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
Push-Location $ServerRoot
try {
    # 库已存在 → 只核对 head；一致则跳过 migrate（日常启动零写库动作）。
    & $VenvPython -c "from alembic.config import Config; from alembic.script import ScriptDirectory; from alembic.runtime.migration import MigrationContext; from sqlalchemy import create_engine; import sys; from app.config import Settings; head = ScriptDirectory.from_config(Config('alembic.ini')).get_current_head(); engine = create_engine(Settings().database_url); current = MigrationContext.configure(engine.connect()).get_current_revision(); engine.dispose(); print(f'head={head} db={current}'); sys.exit(0 if current == head else 2)"
    $headCheck = $LASTEXITCODE
    if ($headCheck -eq 2) {
        # 库落后于代码（升级后首次启动）→ 实跑 upgrade head（幂等，数据保留）
        Write-Host "[步骤3] 数据库版本落后于代码，执行 alembic upgrade head ..."
        & $VenvPython -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { Write-Error "数据库迁移失败"; exit 1 }
    }
    elseif ($headCheck -ne 0) {
        Write-Error "数据库版本核对失败（数据目录或库文件异常？）。请先运行 deploy.ps1 修复。"
        exit 1
    }
    else {
        Write-Host "[步骤3] 数据库版本一致，跳过 migrate。"
    }
}
finally {
    Pop-Location
}

# ---- 步骤 4: 前台启动（单 worker 固化）------------------------------------
# G4 Standards #3 固化: SQLite + StaticPool 单写拓扑（app/db.py）＝单进程内
# 写操作天然串行；多 worker ＝ 多进程并发写 SQLite → 锁冲突/数据损坏。
# --workers 1 写死，禁改。
Write-Host "[步骤4] 启动服务: http://${BindHost}:${Port}  （Ctrl+C 或关闭本窗口即停止）"
& $VenvPython -m uvicorn app.main:app --host $BindHost --port $Port --workers 1
