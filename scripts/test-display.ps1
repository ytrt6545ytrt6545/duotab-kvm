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
    [PSCustomObject]@{
        DeviceName = $_.DeviceName
        Primary = $_.Primary
        X = $dm.dmPositionX
        Y = $dm.dmPositionY
        PhysicalWidth = $dm.dmPelsWidth
        PhysicalHeight = $dm.dmPelsHeight
        LogicalWidth = $_.Bounds.Width
        LogicalHeight = $_.Bounds.Height
        Success = $ok
    }
}
$screens | ConvertTo-Json -Compress
