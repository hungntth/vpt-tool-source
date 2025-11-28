Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool SetWindowText(IntPtr hWnd, string lpString);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
$processId = 9800
$newTitle = "CB"
$found = $false
[Win32]::EnumWindows({
  param($hWnd, $lParam)
  $length = [Win32]::GetWindowTextLength($hWnd)
  if ($length -gt 0) {
    $sb = New-Object System.Text.StringBuilder($length + 1)
    [Win32]::GetWindowText($hWnd, $sb, $sb.Capacity) | Out-Null
    $windowTitle = $sb.ToString()
    $windowPid = 0
    [Win32]::GetWindowThreadProcessId($hWnd, [ref]$windowPid) | Out-Null
    if ($windowTitle -like "*Adobe Flash Player*" -and $windowPid -eq $processId) {
      [Win32]::SetWindowText($hWnd, $newTitle) | Out-Null
      $found = $true
      return $false
    }
  }
  return $true
}, 0) | Out-Null
if ($found) { Write-Output "SUCCESS" } else { Write-Output "NOTFOUND" }