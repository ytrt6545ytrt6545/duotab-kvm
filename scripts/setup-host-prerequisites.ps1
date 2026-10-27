# =========================================================
# DuoTab-KVM 新桌機環境一鍵配置與防火牆開通嚮導
# 編碼規範: UTF-8 with BOM, 繁體中文 (台灣)
# =========================================================
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "DuoTab-KVM 新主機環境配置嚮導"

Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   ⚡ DuoTab-KVM 新主機 (PC/桌機) 一鍵環境檢測與配置嚮導" -ForegroundColor Yellow
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""

$baseDir = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$baseDir\server\index.mjs")) {
    $baseDir = $PSScriptRoot
}

# 1. 檢測 Node.js 執行環境
Write-Host "[1/4] 檢測 Node.js 執行環境..." -NoNewline
try {
    $nodeVer = & node -v 2>$null
    if ($nodeVer) {
        Write-Host " [OK] 已安裝 ($nodeVer)" -ForegroundColor Green
    } else {
        throw "Node.js not found"
    }
} catch {
    Write-Host " [未安裝]" -ForegroundColor Red
    Write-Host "   ⚠️ 尚未檢測到 Node.js，正在嘗試透過 winget 安裝 LTS 版本..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        Write-Host "   🟢 Node.js 安裝完成！請重新開啟本視窗以套用環境變數。" -ForegroundColor Green
    } catch {
        Write-Host "   ❌ 自動安裝失敗，請至官網下載安裝 Node.js LTS: https://nodejs.org/" -ForegroundColor Red
    }
}

# 2. 檢測 FFmpeg 硬體加速/轉碼引擎
Write-Host "[2/4] 檢測 FFmpeg 影像引擎..." -NoNewline
try {
    $ffVer = & ffmpeg -version 2>$null
    if ($ffVer) {
        Write-Host " [OK] 已安裝" -ForegroundColor Green
    } else {
        throw "FFmpeg not found"
    }
} catch {
    Write-Host " [未安裝]" -ForegroundColor Red
    Write-Host "   ⚠️ 尚未檢測到 FFmpeg，正在嘗試透過 winget 安裝..." -ForegroundColor Yellow
    try {
        winget install Gyan.FFmpeg --silent --accept-package-agreements --accept-source-agreements
        Write-Host "   🟢 FFmpeg 安裝完成！" -ForegroundColor Green
    } catch {
        Write-Host "   ❌ 請手動下載 FFmpeg 並加入 PATH: https://www.gyan.dev/ffmpeg/builds/" -ForegroundColor Red
    }
}

# 3. 檢測與就地編譯 InputBridge.exe (Win32 原生輸入穿透橋)
Write-Host "[3/4] 檢測 InputBridge 原生輸入橋樑..." -NoNewline
$bridgeExe = Join-Path $baseDir "server\native\InputBridge.exe"
$bridgeCs = Join-Path $baseDir "server\native\InputBridge.cs"

if (Test-Path $bridgeExe) {
    Write-Host " [OK] 已就緒" -ForegroundColor Green
} elseif (Test-Path $bridgeCs) {
    Write-Host " [需要編譯]" -ForegroundColor Yellow
    Write-Host "   🔨 正在調用 Windows 內建 C# 編譯器 (csc.exe) 進行原生編譯..." -ForegroundColor Cyan
    $csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) {
        $csc = "C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
    }
    
    if (Test-Path $csc) {
        & $csc /nologo /optimize /platform:anycpu /out:"$bridgeExe" "$bridgeCs"
        if ($LASTEXITCODE -eq 0) {
            Write-Host "   🟢 InputBridge.exe 原生編譯成功！" -ForegroundColor Green
        } else {
            Write-Host "   ❌ InputBridge 編譯失敗 (Exit Code: $LASTEXITCODE)" -ForegroundColor Red
        }
    } else {
        Write-Host "   ❌ 找不到 .NET Framework 編譯器，請確認已啟用 .NET Framework 4.8。" -ForegroundColor Red
    }
} else {
    Write-Host "   ⚠️ 找不到 InputBridge 原始碼檔案。" -ForegroundColor Yellow
}

# 4. 配置 Windows 防火牆 (放行 5858 與 5859，確保局域網與手機秒連)
Write-Host "[4/4] 檢查 Windows 防火牆通訊埠規則..." -NoNewline
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($isAdmin) {
    try {
        # 移除舊規則 (若有)
        netsh advfirewall firewall delete rule name="DuoTab-KVM Server" >$null 2>&1
        # 建立放行規則
        netsh advfirewall firewall add rule name="DuoTab-KVM Server (TCP 5858-5859)" dir=in action=allow protocol=TCP localport=5858,5859 >$null 2>&1
        netsh advfirewall firewall add rule name="DuoTab-KVM Server (UDP 5858)" dir=in action=allow protocol=UDP localport=5858 >$null 2>&1
        Write-Host " [OK] 已自動放行 Port 5858 與 5859！" -ForegroundColor Green
    } catch {
        Write-Host " [失敗] 無法自動建立防火牆規則" -ForegroundColor Yellow
    }
} else {
    Write-Host " [略過 (非管理員身分)]" -ForegroundColor Yellow
    Write-Host "   💡 提示: 若手機搜尋不到，請右鍵點擊 Setup-New-PC.bat 選擇「以系統管理員身分執行」以自動放行防火牆。" -ForegroundColor DarkGray
}

# 顯示本機區網 IP
Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "   🌟 本機可供平板連線的區域網路 IP 位址：" -ForegroundColor Yellow
$ips = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi*", "乙太網路*", "Ethernet*", "WLAN*" -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "169.254*" -and $_.IPAddress -ne "127.0.0.1" }
if ($ips) {
    foreach ($ip in $ips) {
        Write-Host "   👉 IP 位址: " -NoNewline
        Write-Host "$($ip.IPAddress)" -ForegroundColor Green -NoNewline
        Write-Host " (介面: $($ip.InterfaceAlias))" -ForegroundColor Gray
    }
} else {
    Write-Host "   (請確保本機已連線至 Wi-Fi 或有線區域網路)" -ForegroundColor DarkGray
}
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "🎉 新桌機環境已準備就緒！平時只要點擊 Start-DuoTab.bat 即可啟動服務！" -ForegroundColor Green
Write-Host "按任意鍵結束本視窗..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
