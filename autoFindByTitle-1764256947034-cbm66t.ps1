Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoWindowFinderByTitle {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
$keyword = "hehe 1"
$foundWindow = $null
[AutoWindowFinderByTitle]::EnumWindows({
  param($hWnd, $lParam)
  $length = [AutoWindowFinderByTitle]::GetWindowTextLength($hWnd)
  if ($length -gt 0) {
    $sb = New-Object System.Text.StringBuilder($length + 1)
    [AutoWindowFinderByTitle]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $windowTitle = $sb.ToString()
    if ($windowTitle -like "*$keyword*") {
      $pid = 0
      [AutoWindowFinderByTitle]::GetWindowThreadProcessId($hWnd, [ref]$pid) | Out-Null
      $foundWindow = [PSCustomObject]@{
        pid = $pid
        title = $windowTitle
        handle = $hWnd.ToInt64()
      }
      return $false
    }
  }
  return $true
}, 0) | Out-Null
if ($foundWindow) { $foundWindow | ConvertTo-Json -Compress } else { Write-Output "NOTFOUND" }