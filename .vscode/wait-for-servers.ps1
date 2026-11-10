# Waits (up to 60s) until the backend and frontend accept connections, before VS Code opens the browser.
# Checks both IPv4 and IPv6 loopback: uvicorn listens on 127.0.0.1, Vite on ::1.
function Test-Port($port) {
    foreach ($addr in "127.0.0.1", "::1") {
        $c = New-Object System.Net.Sockets.TcpClient($(if ($addr -eq "::1") { "InterNetworkV6" } else { "InterNetwork" }))
        try { if ($c.ConnectAsync($addr, $port).Wait(500) -and $c.Connected) { return $true } } catch {} finally { $c.Dispose() }
    }
    return $false
}

$deadline = (Get-Date).AddSeconds(60)
foreach ($p in 8000, 5173) {
    while (-not (Test-Port $p)) {
        if ((Get-Date) -gt $deadline) {
            Write-Host "Server is not running on port $p."
            Write-Host "Start the servers first with Ctrl+Shift+B (Run Tagseed), then press F5 again."
            exit 1
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "OK  port $p"
}
