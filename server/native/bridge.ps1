$csPath = Join-Path $PSScriptRoot "InputBridge.cs"
if (-not (Test-Path $csPath)) {
    Write-Error "Cannot find InputBridge.cs at $csPath"
    exit 1
}

$source = [System.IO.File]::ReadAllText($csPath, [System.Text.Encoding]::UTF8)
Add-Type -TypeDefinition $source -Language CSharp
[DuoTabKVM.Native.Host]::Run()
