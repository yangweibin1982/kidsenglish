# ============================================================================
# KidsEnglish 自托管一键部署（家庭自用，非商业化分发）
# ----------------------------------------------------------------------------
# Shell   : Windows PowerShell 5.1（Windows 10/11 自带；本脚本不依赖 PS7 特性）
# 用法    : powershell -ExecutionPolicy Bypass -File server\scripts\deploy.ps1
#           可选参数: -Port 8000（服务端口，默认 8000）
# 幂等性  : 重复运行安全——venv 复用、pip 已装即跳过、alembic 已在 head 则
#           no-op、令牌已存在绝不覆盖、权限重设幂等、服务已运行则跳过启动。
# 红线    : 服务只绑定 127.0.0.1 回环。家庭局域网威胁模型——本脚本与文档
#           不提供、不支持任何公网暴露（路由器端口转发 / 0.0.0.0 绑定 / 云部署）。
# ============================================================================
param(
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

# ---- 步骤 0: 路径定位 ----------------------------------------------------
# （整段复制执行时，先手动设定 $Port = 8000 与 $ServerRoot = "E:\kidsenglish\server"）
$ServerRoot = Split-Path -Parent $PSScriptRoot      # .../server
$RepoRoot   = Split-Path -Parent $ServerRoot        # 仓库根
$VenvDir    = Join-Path $ServerRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$DataDir    = Join-Path $ServerRoot "data"
$TokenFile  = Join-Path $DataDir "family_token"
$LogFile    = Join-Path $DataDir "server.out.log"
$ErrFile    = Join-Path $DataDir "server.err.log"
$BindHost   = "127.0.0.1"   # 写死回环；禁改 0.0.0.0（威胁模型越界＝WRONG 条件）

Write-Host "=== KidsEnglish 部署开始（server 根: $ServerRoot）==="

# ---- 步骤 1: 检查 python（仅 venv 缺失时需要系统 python）------------------
if (-not (Test-Path $VenvPython)) {
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCmd) {
        Write-Error "未找到 python。请先安装 Python 3.11+ 并勾选 'Add to PATH'，然后重跑本脚本。"
        exit 1
    }
    $pyVerOut = (& python --version 2>&1 | Out-String).Trim()
    Write-Host "检测到 $pyVerOut"
    if ($pyVerOut -match "(\d+)\.(\d+)") {
        $pyMajor = [int]$Matches[1]; $pyMinor = [int]$Matches[2]
        if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 10)) {
            Write-Error "需要 Python >= 3.10（实测锁定 3.11），当前: $pyVerOut"
            exit 1
        }
        if ($pyMajor -eq 3 -and $pyMinor -eq 10) {
            Write-Warning "当前 Python 3.10 可用但未经实测（依赖以 3.11 锁定），建议升级 3.11。"
        }
    }
}
else {
    Write-Host "[步骤1] 复用既有 venv: $VenvDir"
}

# ---- 步骤 2: 建/复用 venv -------------------------------------------------
if (-not (Test-Path $VenvPython)) {
    Write-Host "[步骤2] 创建 venv ..."
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Write-Error "venv 创建失败"; exit 1 }
    Write-Host "[步骤2] venv 创建完成: $VenvDir"
}

# ---- 步骤 3: 安装依赖（幂等：已满足则快速跳过）----------------------------
Write-Host "[步骤3] pip install -r requirements.txt ..."
& $VenvPython -m pip install --disable-pip-version-check -q `
    -r (Join-Path $ServerRoot "requirements.txt")
if ($LASTEXITCODE -ne 0) { Write-Error "依赖安装失败"; exit 1 }
Write-Host "[步骤3] 依赖就绪"

# ---- 步骤 4: 数据目录 + alembic upgrade head（对真实库实跑，幂等）---------
# 数据库迁移纪律：部署必须实跑 upgrade head；已在 head 时 alembic 自动 no-op。
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}
Write-Host "[步骤4] alembic upgrade head（真实库: $($DataDir)\kidsenglish.db）..."
Push-Location $ServerRoot
try {
    & $VenvPython -m alembic upgrade head
    if ($LASTEXITCODE -ne 0) { Write-Error "数据库迁移失败"; exit 1 }
    & $VenvPython -c "from alembic.config import Config; from alembic.script import ScriptDirectory; print('alembic head =', ScriptDirectory.from_config(Config('alembic.ini')).get_current_head())"
    if ($LASTEXITCODE -ne 0) { Write-Error "版本核对失败"; exit 1 }
}
finally {
    Pop-Location
}

# ---- 步骤 5: family token（不覆盖已有）+ 文件权限收紧 ---------------------
# 令牌生成复用 app.auth.ensure_family_token（独占创建，绝不覆盖既有令牌）。
Write-Host "[步骤5] family token ..."
Push-Location $ServerRoot
try {
    & $VenvPython -c "from app.config import Settings; from app.auth import ensure_family_token; ensure_family_token(Settings())"
    if ($LASTEXITCODE -ne 0) { Write-Error "令牌生成/读取失败"; exit 1 }
}
finally {
    Pop-Location
}
if (-not (Test-Path $TokenFile)) { Write-Error "令牌文件未落盘: $TokenFile"; exit 1 }
Write-Host "[步骤5] 令牌文件: $TokenFile（已存在则未覆盖）"
Write-Host ("[步骤5] 令牌内容（配置设备时使用，请勿外传）: " + (Get-Content -Raw $TokenFile).Trim())

# G4 Standards #4：令牌是家庭唯一凭据，收紧到仅当前用户可读写。
# /inheritance:r 断开父目录继承；/grant:r 重设授权（重复运行幂等）。
# SYSTEM 保留：Windows 备份/文件历史等服务以 SYSTEM 运行，仍限本机、不扩网络面。
Write-Host "[步骤5] icacls 收紧令牌文件权限 ..."
icacls $TokenFile /inheritance:r /grant:r "${env:USERNAME}:F" /grant:r "SYSTEM:F"
if ($LASTEXITCODE -ne 0) { Write-Error "令牌权限收紧失败"; exit 1 }
Write-Host "[步骤5] 权限收紧完成（仅 $env:USERNAME 与 SYSTEM）"

# ---- 步骤 6: 启动服务（单 worker 固化）------------------------------------
# G4 Standards #3 固化: SQLite + StaticPool 单写拓扑（app/db.py）＝全应用共享
# 一条连接，写操作在进程内天然串行。多 worker ＝ 多进程各持连接并发写 SQLite
# → 锁冲突/数据损坏，故 --workers 1 写死，禁改；扩容需换 Postgres 级方案，
# 不在本项目威胁模型内。
$HealthUrl = "http://${BindHost}:${Port}/healthz"

# 6a. 已在运行？→ 幂等跳过（不重复起进程、不抢端口）
$healthOk = $false
try {
    $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
    if ($resp.StatusCode -eq 200) { $healthOk = $true }
} catch { }

if ($healthOk) {
    $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidHint = if ($listen) { $listen.OwningProcess } else { "未知" }
    Write-Host "[步骤6] 服务已在运行（healthz 200，PID=$pidHint），跳过启动。"
    Write-Host "        如需加载新代码（升级后），请先停止旧进程再重跑本脚本（停止方法见 docs/deploy.md）。"
    Write-Host "=== 部署完成（幂等跳过启动）==="
    exit 0
}
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Error "端口 $Port 已被其他程序占用（且不是 KidsEnglish）。请用 -Port 换端口，或释放该端口后重试。"
    exit 1
}

# 6b. 后台启动：uvicorn 单进程，日志落 data\server.out.log / server.err.log
#     （Start-Process 重定向每次启动覆盖旧日志；最新日志即最近一次运行）
Write-Host "[步骤6] 启动 uvicorn（--workers 1 固化）..."
$proc = Start-Process -FilePath $VenvPython `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", $BindHost, "--port", "$Port", "--workers", "1") `
    -WorkingDirectory $ServerRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrFile `
    -PassThru

# 6c. healthz 探活（最长等 30 秒）
$deadline = (Get-Date).AddSeconds(30)
$up = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) { break }
    try {
        $resp = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200) { $up = $true; break }
    } catch { }
}

if (-not $up) {
    Write-Host "=== 启动失败，错误日志尾部: ==="
    if (Test-Path $ErrFile) { Get-Content $ErrFile -Tail 20 }
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
    exit 1
}

Write-Host "=== 部署完成 ==="
Write-Host "  服务地址 : $HealthUrl （status ok）"
Write-Host "  进程 PID : $($proc.Id)（uvicorn，参数含 --workers 1）"
Write-Host "  令牌文件 : $TokenFile"
Write-Host "  日志文件 : $LogFile / $ErrFile"
Write-Host "  停止方法 : 见 docs/deploy.md（一行 Stop-Process）"
