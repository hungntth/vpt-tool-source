Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoWindowFinder {
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT Point);
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public struct POINT {
    public int X;
    public int Y;
  }
}
"@
$point = New-Object AutoWindowFinder+POINT
$point.X = 806
$point.Y = 483
$handle = [AutoWindowFinder]::WindowFromPoint($point)
if ($handle -eq [IntPtr]::Zero) {
  Write-Output "NOTFOUND"
  exit
}
$GA_ROOT = 2
$root = [AutoWindowFinder]::GetAncestor($handle, $GA_ROOT)
if ($root -ne [IntPtr]::Zero) {
  $handle = $root
}
$pid = 0
[AutoWindowFinder]::GetWindowThreadProcessId($handle, [ref]$pid) | Out-Null
$length = [AutoWindowFinder]::GetWindowTextLength($handle)
if ($length -le 0) {
  $title = "Ứng dụng không tên"
} else {
  $sb = New-Object System.Text.StringBuilder($length + 1)
  [AutoWindowFinder]::GetWindowText($handle, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
}
$result = [PSCustomObject]@{
  pid = $pid
  title = $title
  handle = $handle.ToInt64()
}
$result | ConvertTo-Json -Compress