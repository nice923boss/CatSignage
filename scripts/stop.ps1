$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 兩種執行型態要用不同方式辨識：
#   打包版：進程名固定是 CatSignage.exe，安裝到哪裡都算數
#   開發版：進程名是通用的 electron.exe，只認可執行檔在這個專案底下的，才不會誤殺別的 Electron 程式
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Get-Targets {
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe' OR Name = 'CatSignage.exe'" |
        Where-Object {
            $_.Name -eq 'CatSignage.exe' -or
            ($_.ExecutablePath -and
             $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase))
        }
}

$targets = @(Get-Targets)
if ($targets.Count -eq 0) {
    Write-Host '沒有正在執行的 CatSignage。'
    exit 0
}

# 先結束主進程，否則它會立刻把 GPU 與網路子進程重新拉起來
$ids = $targets | ForEach-Object { $_.ProcessId }
$ordered = $targets | Sort-Object @{ Expression = { if ($ids -contains $_.ParentProcessId) { 1 } else { 0 } } }

foreach ($p in $ordered) {
    Write-Host ('結束進程 PID {0}（{1}）' -f $p.ProcessId, $p.Name)
    try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {}
}

# 確認真的結束，最多等 3 秒
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    if (@(Get-Targets).Count -eq 0) {
        Write-Host ('已結束 {0} 個進程。' -f $targets.Count)
        exit 0
    }
}

$remain = @(Get-Targets)
Write-Host ('仍有 {0} 個進程未結束，請手動確認。' -f $remain.Count)
exit 1
