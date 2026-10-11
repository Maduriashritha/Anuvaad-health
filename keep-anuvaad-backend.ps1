$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$starter = Join-Path $root 'scripts/start-anuvaad.ps1'
while ($true) {
    $client = [System.Net.Sockets.TcpClient]::new()
    $isRunning = $false
    try {
        $connect = $client.ConnectAsync('127.0.0.1', 3002)
        if ($connect.Wait(700) -and $client.Connected) { $isRunning = $true }
    } catch { } finally { $client.Dispose() }
    if ($isRunning) { Start-Sleep -Seconds 3; continue }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $starter
    Start-Sleep -Seconds 2
}
