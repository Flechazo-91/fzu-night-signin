<#
.SYNOPSIS
  注册 Windows 计划任务：每天 21:30 自动跑 fzu-signin run（带多个兜底时间点）

.DESCRIPTION
  为什么用计划任务而不是常驻进程：一天只需要跑一两次，没必要挂后台。
  任务设为「仅在用户登录时运行」—— 模拟器需要图形会话。

  为什么有多个时间点：2026-11-08 那次任务进程被系统强杀（0xC000013A），
  只注册一个 21:30 的话，死了当天就彻底没戏。现在是
  21:30 → 22:00 → 22:25 → 23:20 四个点，每次都跑同一个幂等脚本：
  已签到就零写请求直接退出，没签到就补上。22:25 那次还能赶在迟到线前。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Time 21:20
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -ExtraTimes "22:00,22:25,23:20"
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -RunNow
#>
param(
    [string]$Time = "21:30",
    [string]$TaskName = "FZU晚点名签到",
    [string]$ExtraTimes = "",
    [switch]$Uninstall,
    [switch]$RunNow
)

$ErrorActionPreference = "Stop"

# 项目根 = 本脚本的上一级
$Root  = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $Root "tools\fzu.mjs"

# 优先用仓库自带的 node（如果放了 bin\node.exe），否则退回系统 node
$Bundled = Join-Path $Root "bin\node.exe"
if (Test-Path $Bundled) {
    $Node = $Bundled
} else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "找不到 node：请安装 Node 22.5+，或把 node.exe 放到 $Root\bin\"
    }
    $Node = $cmd.Source
}

if ($Uninstall) {
    $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($t) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "已删除计划任务: $TaskName"
    } else {
        Write-Host "没有找到计划任务: $TaskName"
    }
    return
}

if (-not (Test-Path $Entry)) { throw "缺少入口脚本: $Entry" }

$action = New-ScheduledTaskAction `
    -Execute $Node `
    -Argument "`"$Entry`" run" `
    -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Daily -At $Time

# 多时间点兜底：21:30 失败还有 22:00 / 22:25 / 23:20 三次机会
# run.mjs 是幂等的——已签到就零写请求退出，不会重复打卡
$spec = $Time + ',' + $(if ($ExtraTimes -and $ExtraTimes.Trim()) { $ExtraTimes } else { '22:00,22:25,23:20' })
$triggers = @()
foreach ($piece in ($spec -split ',')) {
    $v = "$piece".Trim()
    if ($v -and -not ($triggers | Where-Object { $_.StartBoundary -like "*T$($v):00" })) {
        $triggers += (New-ScheduledTaskTrigger -Daily -At $v)
    }
}

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 12) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
    -Settings $settings -Principal $principal -Force | Out-Null

$allTimes = ($spec -split ',' | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) -join ' / '
Write-Host "✔ 计划任务已注册: $TaskName  每天 $allTimes"
Write-Host "  node: $Node"
Write-Host "  入口: $Entry run"
Write-Host "  兜底逻辑: 已签到则零写请求直接退出（幂等）"
Write-Host ""
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-List
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object NextRunTime | Format-List

if ($RunNow) {
    Write-Host "立即试跑一次…"
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 8
    Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult | Format-List
}
