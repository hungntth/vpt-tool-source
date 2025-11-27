Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoWindowFinderByPid {
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
$targetPid = 195308
$foundWindow = $null
[AutoWindowFinderByPid]::EnumWindows({
  param($hWnd, $lParam)
  $windowPid = 0
  [AutoWindowFinderByPid]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) | Out-Null
  if ($windowPid -eq $targetPid) {
    $length = [AutoWindowFinderByPid]::GetWindowTextLength($hWnd)
    $title = ""
    if ($length -gt 0) {
      $sb = New-Object System.Text.StringBuilder($length + 1)
      [AutoWindowFinderByPid]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
      $title = $sb.ToString()
    }
    $foundWindow = [PSCustomObject]@{
      pid = $windowPid
      title = $title
      handle = $hWnd.ToInt64()
    }
    return $false
  }
  return $true
}, 0) | Out-Null
if ($foundWindow) { $foundWindow | ConvertTo-Json -Compress } else { Write-Output "NOTFOUND" }