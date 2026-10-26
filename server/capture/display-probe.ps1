# DuoTab-KVM 實體螢幕拓撲探針 (Win32 EnumDisplaySettings)
# 繞過 Windows DPI 縮放虛擬化，精準讀取顯示卡真實硬體解析度 (如 1920x1080)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string dmFormName;
    public short dmLogPixels;
    public short dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
}

public class DisplayHelper {
    [DllImport("user32.dll")]
    public static extern bool EnumDisplaySettings(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode);
}
'@

Add-Type -AssemblyName System.Windows.Forms
$screens = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    $dm = New-Object DEVMODE
    $dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)
    $ok = [DisplayHelper]::EnumDisplaySettings($_.DeviceName, -1, [ref]$dm)
    
    # 優先取用實體像素 (dmPelsWidth/Height)，若失敗則回退邏輯像素
    $pWidth = if ($ok -and $dm.dmPelsWidth -gt 0) { $dm.dmPelsWidth } else { $_.Bounds.Width }
    $pHeight = if ($ok -and $dm.dmPelsHeight -gt 0) { $dm.dmPelsHeight } else { $_.Bounds.Height }
    $posX = if ($ok) { $dm.dmPositionX } else { $_.Bounds.X }
    $posY = if ($ok) { $dm.dmPositionY } else { $_.Bounds.Y }

    [PSCustomObject]@{
        DeviceName = $_.DeviceName
        Primary = $_.Primary
        X = $posX
        Y = $posY
        Width = $pWidth
        Height = $pHeight
    }
}
$screens | ConvertTo-Json -Compress
