<#
.SYNOPSIS
  注册 Windows 计划任务：每天 21:30 自动跑 fzu-signin run

.DESCRIPTION
  为什么用计划任务而不是常驻进程：一天只需要跑一两次，没必要挂后台。
  任务设为「仅在用户登录时运行」—— 模拟器需要图形会话。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Time 21:20
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -Uninstall
  powershell -ExecutionPolicy Bypass -File scripts\install-task.ps1 -RunNow
#>
param(
    [string]$Time = "21:30",
    [string]$TaskName = "FZU晚点名签到",
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

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 20) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 10)

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "✔ 计划任务已注册: $TaskName  每天 $Time"
Write-Host "  node: $Node"
Write-Host "  入口: $Entry run"
Write-Host ""
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-List
Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object NextRunTime | Format-List

if ($RunNow) {
    Write-Host "立即试跑一次…"
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 8
    Get-ScheduledTaskInfo -TaskName $TaskName | Select-Object LastRunTime, LastTaskResult | Format-List
}
