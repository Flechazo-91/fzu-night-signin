# =============================================================================
# 一键发布到 GitHub
#
# 两种认证方式，任选其一：
#
#   A) SSH（推荐，本机已有 key 的话）
#      1) 把这个公钥加到 https://github.com/settings/keys
#      2) powershell -ExecutionPolicy Bypass -File scripts\publish.ps1
#
#   B) HTTPS + Personal Access Token
#      powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -Token ghp_xxx
#      （token 需要 repo 权限：https://github.com/settings/tokens）
#
# 脚本做的事：确认分支 → 建仓库（HTTPS 方式）→ 配 remote → push
# =============================================================================
param(
    [string]$Owner = "Flechazo-91",
    [string]$Repo  = "fzu-night-signin",
    [string]$Token = "",
    [switch]$Private,
    [switch]$SkipCreate
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Git  = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $Git) { $Git = "D:\tools\git\cmd\git.exe" }

Push-Location $Root
try {
    # ── 0. 基本检查 ──────────────────────────────────────────
    & $Git rev-parse --git-dir | Out-Null
    $branch = (& $Git rev-parse --abbrev-ref HEAD).Trim()
    $commits = (& $Git rev-list --count HEAD).Trim()
    Write-Host "仓库: $Root"
    Write-Host "分支: $branch   提交数: $commits"

    if ([int]$commits -lt 1) { throw "还没有任何提交" }

    $dirty = (& $Git status --porcelain) -join ''
    if ($dirty) {
        Write-Host "! 工作区有未提交改动，先提交" -ForegroundColor Yellow
        & $Git add -A
        & $Git -c core.hooksPath=.githooks commit -m "chore: 发布前整理" | Out-Null
    }

    # ── 1. 选认证方式 ────────────────────────────────────────
    if ($Token) {
        $env:GIT_TERMINAL_PROMPT = "0"
        $remoteUrl = "https://$Token@github.com/$Owner/$Repo.git"

        if (-not $SkipCreate) {
            Write-Host "`n创建仓库 $Owner/$Repo …"
            $body = @{
                name        = $Repo
                description = "福大晚点名签到：直接调服务端打卡接口，每晚 21:30 自动完成。不伪造 GPS、不 hook 高德、不跑 UI 自动化。"
                private     = [bool]$Private
                has_issues  = $true
                has_wiki    = $false
            } | ConvertTo-Json
            try {
                $r = Invoke-RestMethod -Uri "https://api.github.com/user/repos" -Method Post `
                    -Headers @{ Authorization = "token $Token"; "User-Agent" = "fzu-night-signin" } `
                    -ContentType "application/json" -Body $body
                Write-Host "✔ 仓库已创建: $($r.html_url)"
            } catch {
                $msg = $_.ErrorDetails.Message
                if ($msg -match 'already exists') { Write-Host "仓库已存在，继续推送" }
                else { throw "建仓库失败: $msg" }
            }
        }
    }
    else {
        Write-Host "`n使用 SSH 认证" -ForegroundColor Cyan
        $pub = "$env:USERPROFILE\.ssh\id_ed25519_github.pub"
        if (Test-Path $pub) {
            Write-Host "本机公钥（需要已加到 https://github.com/settings/keys）："
            Write-Host ("  " + (Get-Content $pub -Raw).Trim()) -ForegroundColor DarkGray
        }
        $remoteUrl = "git@github.com:$Owner/$Repo.git"
    }

    # ── 2. 配 remote ─────────────────────────────────────────
    $existing = (& $Git remote) -split "`n" | ForEach-Object { $_.Trim() }
    if ($existing -contains "origin") { & $Git remote remove origin }
    & $Git remote add origin $remoteUrl
    Write-Host "`nremote: origin → $($remoteUrl -replace 'https://[^@]+@', 'https://***@')"

    # ── 3. 推 ───────────────────────────────────────────────
    Write-Host "`n推送中…"
    & $Git push -u origin $branch
    if ($LASTEXITCODE -ne 0) { throw "push 失败（退出码 $LASTEXITCODE）" }

    Write-Host "`n✔ 发布完成: https://github.com/$Owner/$Repo"
    Write-Host "  打 tag: $Git tag -a v1.0.0 -m 'v1.0.0' && $Git push origin v1.0.0"
}
finally {
    Pop-Location
}
