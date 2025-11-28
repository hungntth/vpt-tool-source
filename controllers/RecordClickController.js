const { spawn } = require('child_process');
const ScriptHelper = require('./helpers/ScriptHelper');

class RecordClickController {
  constructor(ipcMain, mainWindow, appDir) {
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    this.scriptHelper = new ScriptHelper(appDir);
    this.recordClickProcess = null;
    this.recordClickScriptPath = null;
    this.recordClickTarget = null;
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle('record-click-start', async (event, config) => {
      return await this.startRecordClick(config);
    });

    ipcMain.handle('record-click-stop', async () => {
      return await this.stopRecordClick();
    });
  }

  async startRecordClick(config = {}) {
    if (!config.targetWindow || !config.targetWindow.handle) {
      return { success: false, error: 'Thiếu thông tin cửa sổ đích.' };
    }

    // Dừng record cũ nếu có
    await this.stopRecordClick({ silent: true });

    this.recordClickTarget = {
      pid: config.targetWindow.pid,
      title: config.targetWindow.title,
      handle: Number(config.targetWindow.handle) || config.targetWindow.handle
    };

    console.log('Starting record click for window:', this.recordClickTarget);
    const handleValue = this.recordClickTarget.handle;
    const scriptContent = this.buildRecordClickScript(handleValue);

    const scriptPath = this.scriptHelper.writeTempScript('recordClick', scriptContent);
    this.recordClickScriptPath = scriptPath;
    console.log('Record click script path:', scriptPath);

    return await new Promise((resolve) => {
      this.recordClickProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        cwd: this.appDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.recordClickProcess.stdout.on('data', (data) => {
        const message = data.toString().trim();
        if (!message) return;

        // Xử lý từng dòng (có thể có nhiều dòng)
        const lines = message.split('\n').filter(line => line.trim());
        lines.forEach(line => {
          try {
            const parsed = JSON.parse(line.trim());
            if (parsed.type === 'click' && parsed.point) {
              // Gửi điểm click về renderer process
              console.log('Recorded click point:', parsed.point);
              if (this.mainWindow) {
                this.mainWindow.webContents.send('record-click-point', {
                  point: parsed.point
                });
              }
            } else if (parsed.type === 'error') {
              console.error('Record click error:', parsed.message);
              if (this.mainWindow) {
                this.mainWindow.webContents.send('record-click-error', {
                  message: parsed.message
                });
              }
            } else if (parsed.type === 'info') {
              console.log('Record click info:', parsed.message);
            }
          } catch (e) {
            // Không phải JSON, có thể là debug message
            console.log('Record click output:', line);
          }
        });
      });

      this.recordClickProcess.stderr.on('data', (data) => {
        const errorMsg = data.toString();
        console.error('Record click stderr:', errorMsg);
        // Gửi lỗi về renderer nếu có
        if (this.mainWindow && errorMsg.trim()) {
          this.mainWindow.webContents.send('record-click-error', {
            message: errorMsg.trim()
          });
        }
      });

      this.recordClickProcess.on('exit', (code) => {
        this.cleanupRecordClickProcess();
        if (code !== 0 && code !== null) {
          console.log('Record click process exited with code:', code);
        }
      });

      resolve({ success: true });
    });
  }

  buildRecordClickScript(handleValue) {
    return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RecordClicker {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);
  [DllImport("user32.dll")]
  public static extern bool UnhookWindowsHookEx(IntPtr hHook);
  [DllImport("user32.dll")]
  public static extern IntPtr CallNextHookEx(IntPtr hHook, int nCode, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT Point);
  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);
  [DllImport("user32.dll")]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetModuleHandle(string lpModuleName);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  public struct POINT {
    public int X;
    public int Y;
  }
  public struct MSLLHOOKSTRUCT {
    public POINT pt;
    public uint mouseData;
    public uint flags;
    public uint time;
    public IntPtr dwExtraInfo;
  }
  public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);
  public const int WH_MOUSE_LL = 14;
  public const int WM_LBUTTONDOWN = 0x0201;
  public const uint GA_ROOT = 2;
}
"@
$script:handle = [IntPtr]${handleValue}
$script:hook = [IntPtr]::Zero
$script:rect = New-Object RecordClicker+RECT
$script:hookProc = [RecordClicker+LowLevelMouseProc]{
  param($nCode, $wParam, $lParam)
  if ($nCode -ge 0 -and $wParam.ToInt32() -eq [RecordClicker]::WM_LBUTTONDOWN) {
    try {
      $hookStruct = [System.Runtime.InteropServices.Marshal]::PtrToStructure($lParam, [Type][RecordClicker+MSLLHOOKSTRUCT])
      $clickX = $hookStruct.pt.X
      $clickY = $hookStruct.pt.Y
      $clickPoint = New-Object RecordClicker+POINT
      $clickPoint.X = $clickX
      $clickPoint.Y = $clickY
      $clickedWindow = [RecordClicker]::WindowFromPoint($clickPoint)
      if ($clickedWindow -ne [IntPtr]::Zero) {
        $rootWindow = [RecordClicker]::GetAncestor($clickedWindow, [RecordClicker]::GA_ROOT)
        if ($rootWindow.ToInt64() -eq $script:handle.ToInt64()) {
          if ([RecordClicker]::GetWindowRect($script:handle, [ref]$script:rect)) {
            $clientPoint = $clickPoint
            [RecordClicker]::ScreenToClient($script:handle, [ref]$clientPoint) | Out-Null
            $offsetX = $clientPoint.X
            $offsetY = $clientPoint.Y
            if ($offsetX -ge 0 -and $offsetY -ge 0) {
              $result = @{
                type = "click"
                point = @{
                  offsetX = $offsetX
                  offsetY = $offsetY
                  screenX = $clickX
                  screenY = $clickY
                }
              } | ConvertTo-Json -Compress
              [Console]::Out.WriteLine($result)
            }
          }
        }
      }
    } catch {
      # Bỏ qua lỗi
    }
  }
  return [RecordClicker]::CallNextHookEx($script:hook, $nCode, $wParam, $lParam)
}
Add-Type -AssemblyName System.Windows.Forms
$script:hook = [RecordClicker]::SetWindowsHookEx([RecordClicker]::WH_MOUSE_LL, $script:hookProc, [RecordClicker]::GetModuleHandle($null), 0)
if ($script:hook -eq [IntPtr]::Zero) {
  $errorMsg = "Không thể thiết lập hook. Mã lỗi: " + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $error = @{
    type = "error"
    message = $errorMsg
  } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($error)
  exit 1
}
$initMsg = @{
  type = "info"
  message = "Hook đã được thiết lập thành công"
} | ConvertTo-Json -Compress
[Console]::Out.WriteLine($initMsg)
try {
  while ($true) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 50
    if (-not [RecordClicker]::IsWindow($script:handle)) {
      $closeMsg = @{
        type = "info"
        message = "Cửa sổ đã đóng"
      } | ConvertTo-Json -Compress
      [Console]::Out.WriteLine($closeMsg)
      break
    }
  }
} catch {
  $error = @{
    type = "error"
    message = $_.Exception.Message
  } | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($error)
} finally {
  if ($script:hook -ne [IntPtr]::Zero) {
    [RecordClicker]::UnhookWindowsHookEx($script:hook) | Out-Null
  }
}`;
  }

  async stopRecordClick(options = {}) {
    const silent = options && options.silent;
    if (this.recordClickProcess) {
      try {
        this.recordClickProcess.kill();
      } catch (error) {
        console.error('Không thể dừng record click:', error);
      }
    }

    this.cleanupRecordClickProcess();

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send('record-click-stopped', {
        success: true
      });
    }

    return { success: true };
  }

  cleanupRecordClickProcess() {
    if (this.recordClickProcess) {
      this.recordClickProcess.removeAllListeners();
      this.recordClickProcess = null;
    }

    this.scriptHelper.cleanupTempScript(this.recordClickScriptPath);
    this.recordClickScriptPath = null;
    this.recordClickTarget = null;
  }
}

module.exports = RecordClickController;

