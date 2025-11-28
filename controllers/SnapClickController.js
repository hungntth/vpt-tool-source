const { exec } = require('child_process');
const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const ScriptHelper = require('./helpers/ScriptHelper');

class SnapClickController {
  constructor(ipcMain, mainWindow, appDir) {
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    this.scriptHelper = new ScriptHelper(appDir);
    this.snapClickProcess = null;
    this.snapClickScriptPath = null;
    this.snapClickTarget = null;
    this.snapPoints = []; // Lưu các điểm đã chọn: [{ offsetX, offsetY, imagePath, selection }]
    this.snapConfigPath = path.join(this.appDir, 'snap-config.json');
    this.snapConfig = this.loadSnapConfig();
    this.selectorWindow = null;
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle('snap-detect-window', async (event, coords) => {
      return await this.detectWindow(coords);
    });

    ipcMain.handle('snap-capture-window', async (event, windowInfo) => {
      return await this.captureWindow(windowInfo);
    });

    ipcMain.handle('snap-save-point', (event, point) => {
      return this.saveSnapPoint(point);
    });

    ipcMain.handle('snap-load-config', () => {
      return this.snapConfig;
    });

    ipcMain.handle('snap-delete-point', (event, index) => {
      return this.deleteSnapPoint(index);
    });

    ipcMain.handle('snap-start', async (event, config) => {
      return await this.startSnapClick(config);
    });

    ipcMain.handle('snap-stop', async () => {
      return await this.stopSnapClick();
    });

    // Xử lý lưu dữ liệu từ cửa sổ selector
    ipcMain.on('snap-selector-save', (event, data) => {
      this.handleSelectorSave(data);
    });
  }

  async detectWindow(coords = {}) {
    const { x, y } = coords;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { success: false, error: 'Tọa độ không hợp lệ.' };
    }

    const pointX = Math.round(x);
    const pointY = Math.round(y);

    const scriptContent = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapWindowFinder {
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
$point = New-Object SnapWindowFinder+POINT
$point.X = ${pointX}
$point.Y = ${pointY}
$handle = [SnapWindowFinder]::WindowFromPoint($point)
if ($handle -eq [IntPtr]::Zero) {
  Write-Output "NOTFOUND"
  exit
}
$GA_ROOT = 2
$root = [SnapWindowFinder]::GetAncestor($handle, $GA_ROOT)
if ($root -ne [IntPtr]::Zero) {
  $handle = $root
}
$pid = 0
[SnapWindowFinder]::GetWindowThreadProcessId($handle, [ref]$pid) | Out-Null
$length = [SnapWindowFinder]::GetWindowTextLength($handle)
if ($length -le 0) {
  $title = "Ứng dụng không tên"
} else {
  $sb = New-Object System.Text.StringBuilder($length + 1)
  [SnapWindowFinder]::GetWindowText($handle, $sb, $sb.Capacity) | Out-Null
  $title = $sb.ToString()
}
$result = [PSCustomObject]@{
  pid = $pid
  title = $title
  handle = $handle.ToInt64()
}
$result | ConvertTo-Json -Compress`;

    const scriptPath = this.scriptHelper.writeTempScript('snapDetectWindow', scriptContent);

    return await new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
        this.scriptHelper.cleanupTempScript(scriptPath);

        if (error) {
          console.error('Lỗi khi xác định ứng dụng:', stderr || error.message);
          resolve({ success: false, error: 'Không xác định được ứng dụng.' });
          return;
        }

        const output = stdout ? stdout.toString().trim() : '';
        if (!output || output === 'NOTFOUND') {
          resolve({ success: false, error: 'Không tìm thấy cửa sổ ở vị trí đã thả.' });
          return;
        }

        try {
          const parsed = JSON.parse(output);
          this.snapClickTarget = {
            pid: parsed.pid,
            title: parsed.title,
            handle: Number(parsed.handle) || parsed.handle
          };

          resolve({
            success: true,
            window: this.snapClickTarget
          });
        } catch (e) {
          console.error('Không parse được JSON trả về:', output);
          resolve({ success: false, error: 'Dữ liệu trả về không hợp lệ.' });
        }
      });
    });
  }

  async captureWindow(windowInfo) {
    if (!windowInfo || !windowInfo.handle) {
      return { success: false, error: 'Thiếu thông tin cửa sổ.' };
    }

    const handleValue = windowInfo.handle;
    const timestamp = Date.now();
    const imagePath = path.join(this.appDir, `snap-${timestamp}.png`);

    const escapedImagePath = imagePath.replace(/\\/g, '\\\\').replace(/\$/g, '`$').replace(/"/g, '`"');
    const scriptContent = `Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapCapture {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@
$handle = [IntPtr]${handleValue}
$rect = New-Object SnapCapture+RECT
if (-not [SnapCapture]::GetWindowRect($handle, [ref]$rect)) {
  Write-Output "ERROR: Cannot get window rect"
  exit 1
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Write-Output "ERROR: Invalid window size"
  exit 1
}
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
  $result = [SnapCapture]::PrintWindow($handle, $hdc, 0)
  if (-not $result) {
    Write-Output "ERROR: Cannot capture window"
    exit 1
  }
} finally {
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
}
$imagePath = "${escapedImagePath}"
$bitmap.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "SUCCESS"`;

    const scriptPath = this.scriptHelper.writeTempScript('snapCapture', scriptContent);

    return await new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
        this.scriptHelper.cleanupTempScript(scriptPath);

        if (error) {
          console.error('Lỗi khi chụp màn hình:', stderr || error.message);
          resolve({ success: false, error: 'Không thể chụp màn hình cửa sổ.' });
          return;
        }

        const output = stdout ? stdout.toString().trim() : '';
        if (output === 'SUCCESS' && fs.existsSync(imagePath)) {
          // Đọc file ảnh và chuyển thành base64 để gửi về frontend
          try {
            const imageBuffer = fs.readFileSync(imagePath);
            const base64Image = imageBuffer.toString('base64');
            const dataUrl = `data:image/png;base64,${base64Image}`;

            // Lấy window rect để trả về
            const rectScript = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class GetRect {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@
$handle = [IntPtr]${handleValue}
$rect = New-Object GetRect+RECT
if ([GetRect]::GetWindowRect($handle, [ref]$rect)) {
  $result = @{
    left = $rect.Left
    top = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  } | ConvertTo-Json -Compress
  Write-Output $result
} else {
  Write-Output "ERROR"
}`;
            
            const rectScriptPath = this.scriptHelper.writeTempScript('getWindowRect', rectScript);
            
            // Đợi lấy window rect trước khi resolve
            exec(`powershell -ExecutionPolicy Bypass -File "${rectScriptPath}"`, (rectError, rectStdout, rectStderr) => {
              this.scriptHelper.cleanupTempScript(rectScriptPath);
              
              let windowRect = { left: 0, top: 0, width: 0, height: 0 };
              if (!rectError && rectStdout && rectStdout.toString().trim() !== 'ERROR') {
                try {
                  windowRect = JSON.parse(rectStdout.toString().trim());
                } catch (e) {
                  console.warn('Không parse được window rect:', e);
                }
              }

              // Mở cửa sổ selector để chọn điểm
              this.openSelectorWindow(dataUrl, imagePath, windowRect);
              
              // Mở cửa sổ selector để chọn điểm
              this.openSelectorWindow(dataUrl, imagePath, windowRect);
              
              resolve({
                success: true,
                imagePath: imagePath,
                dataUrl: dataUrl,
                windowRect: windowRect
              });
            });
          } catch (e) {
            console.error('Lỗi khi đọc file ảnh:', e);
            resolve({ success: false, error: 'Không thể đọc file ảnh.' });
          }
        } else {
          resolve({ success: false, error: output || 'Không thể chụp màn hình.' });
        }
      });
    });
  }

  openSelectorWindow(imageDataUrl, imagePath, windowRect) {
    // Đóng cửa sổ cũ nếu có
    if (this.selectorWindow) {
      this.selectorWindow.close();
    }

    // Tạo cửa sổ mới
    this.selectorWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      title: 'Chọn điểm trên ảnh',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      },
      parent: this.mainWindow,
      modal: false
    });

    // Load file HTML
    this.selectorWindow.loadFile(path.join(this.appDir, 'views', 'snap-selector.html'));

    // Gửi dữ liệu ảnh khi cửa sổ sẵn sàng
    this.selectorWindow.webContents.once('did-finish-load', () => {
      this.selectorWindow.webContents.send('snap-image-data', {
        imageDataUrl: imageDataUrl,
        imagePath: imagePath,
        windowRect: windowRect
      });
    });

    // Xử lý khi cửa sổ đóng
    this.selectorWindow.on('closed', () => {
      this.selectorWindow = null;
    });
  }

  handleSelectorSave(data) {
    const { selection, points } = data;
    
    if (!points || points.length === 0) {
      if (this.mainWindow) {
        this.mainWindow.webContents.send('snap-selector-saved', {
          success: false,
          error: 'Chưa chọn điểm nào.'
        });
      }
      return;
    }

    // Lưu các điểm với thông tin selection
    const newPoints = points.map((point, index) => ({
      offsetX: point.offsetX,
      offsetY: point.offsetY,
      selection: selection || null,
      id: Date.now() + index
    }));

    // Thêm vào danh sách điểm
    this.snapPoints.push(...newPoints);
    this.persistSnapConfig();

    // Đóng cửa sổ selector
    if (this.selectorWindow) {
      this.selectorWindow.close();
    }

    // Thông báo về main window
    if (this.mainWindow) {
      this.mainWindow.webContents.send('snap-selector-saved', {
        success: true,
        points: newPoints,
        selection: selection
      });
    }
  }

  saveSnapPoint(point) {
    if (!point || typeof point.offsetX !== 'number' || typeof point.offsetY !== 'number') {
      return { success: false, error: 'Điểm không hợp lệ.' };
    }

    const snapPoint = {
      offsetX: Math.round(point.offsetX),
      offsetY: Math.round(point.offsetY),
      imagePath: point.imagePath || '',
      selection: point.selection || null,
      id: Date.now() + Math.floor(Math.random() * 1000)
    };

    this.snapPoints.push(snapPoint);
    this.persistSnapConfig();

    return { success: true, point: snapPoint };
  }

  deleteSnapPoint(index) {
    if (typeof index !== 'number' || index < 0 || index >= this.snapPoints.length) {
      return { success: false, error: 'Chỉ số không hợp lệ.' };
    }

    const deletedPoint = this.snapPoints.splice(index, 1)[0];
    
    // Xóa file ảnh nếu có
    if (deletedPoint.imagePath && fs.existsSync(deletedPoint.imagePath)) {
      try {
        fs.unlinkSync(deletedPoint.imagePath);
      } catch (e) {
        console.warn('Không thể xóa file ảnh:', e);
      }
    }

    this.persistSnapConfig();

    return { success: true, points: this.snapPoints };
  }

  loadSnapConfig() {
    try {
      if (fs.existsSync(this.snapConfigPath)) {
        const raw = fs.readFileSync(this.snapConfigPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.points)) {
          this.snapPoints = parsed.points;
        }
      }
    } catch (error) {
      console.warn('Không thể đọc cấu hình snap click:', error.message);
    }
    return {
      points: this.snapPoints
    };
  }

  persistSnapConfig() {
    try {
      fs.writeFileSync(this.snapConfigPath, JSON.stringify({
        points: this.snapPoints
      }, null, 2), 'utf8');
    } catch (error) {
      console.error('Không thể lưu cấu hình snap click:', error.message);
    }
  }

  async startSnapClick(config = {}) {
    if (!this.snapClickTarget || !this.snapClickTarget.handle) {
      return { success: false, error: 'Vui lòng chọn ứng dụng trước khi chạy snap click.' };
    }

    if (this.snapPoints.length === 0) {
      return { success: false, error: 'Chưa có điểm snap nào.' };
    }

    const interval = Math.max(500, Number(config.interval) || 2000);
    const handleValue = this.snapClickTarget.handle;
    const pointsJson = JSON.stringify(this.snapPoints.map(p => ({ offsetX: p.offsetX, offsetY: p.offsetY })))
      .replace(/"/g, '`"')
      .replace(/\$/g, '`$');

    const scriptContent = this.buildSnapClickScript(handleValue, interval, pointsJson);
    const scriptPath = this.scriptHelper.writeTempScript('snapClickRunner', scriptContent);
    this.snapClickScriptPath = scriptPath;

    return await new Promise((resolve) => {
      this.snapClickProcess = require('child_process').spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        cwd: this.appDir,
        windowsHide: true
      });

      this.snapClickProcess.stdout.on('data', (data) => {
        const message = data.toString().trim();
        if (!message) return;

        if (message === 'TARGET_LOST') {
          this.snapClickTarget = null;
          if (this.mainWindow) {
            this.mainWindow.webContents.send('snap-click-status', {
              running: false,
              message: 'Cửa sổ mục tiêu đã đóng hoặc không còn hợp lệ.',
              type: 'error',
              targetLost: true
            });
          }
          this.stopSnapClick({ silent: true });
        }
      });

      this.snapClickProcess.stderr.on('data', (data) => {
        console.error('Snap click stderr:', data.toString());
      });

      this.snapClickProcess.on('exit', (code) => {
        this.cleanupSnapClickProcess();
        if (this.mainWindow) {
          this.mainWindow.webContents.send('snap-click-status', {
            running: false,
            message: code === 0 ? 'Snap click đã dừng.' : 'Snap click dừng đột ngột.',
            type: code === 0 ? 'success' : 'error'
          });
        }
      });

      resolve({ success: true });
    });
  }

  buildSnapClickScript(handleValue, interval, pointsJson) {
    return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapClicker {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern IntPtr PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
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
}
"@
$handle = [IntPtr]${handleValue}
$points = ConvertFrom-Json "${pointsJson}"
if ($points.Count -eq 0) {
  Write-Output "NOPTS"
  exit
}
$loopInterval = ${interval}
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
while ($true) {
  if (-not [SnapClicker]::IsWindow($handle)) {
    Write-Output "TARGET_LOST"
    break
  }
  $rect = New-Object SnapClicker+RECT
  if (-not [SnapClicker]::GetWindowRect($handle, [ref]$rect)) {
    Start-Sleep -Milliseconds 300
    continue
  }
  foreach ($point in $points) {
    $screenPoint = New-Object SnapClicker+POINT
    $screenPoint.X = [int]($rect.Left + $point.offsetX)
    $screenPoint.Y = [int]($rect.Top + $point.offsetY)
    $clientPoint = $screenPoint
    [SnapClicker]::ScreenToClient($handle, [ref]$clientPoint) | Out-Null
    $clientX = $clientPoint.X
    $clientY = $clientPoint.Y
    if ($clientX -lt 0 -or $clientY -lt 0) {
      continue
    }
    $lParam = ($clientY -band 0xFFFF) -shl 16 -bor ($clientX -band 0xFFFF)
    [SnapClicker]::PostMessage($handle, $WM_LBUTTONDOWN, [IntPtr]1, [IntPtr]$lParam) | Out-Null
    Start-Sleep -Milliseconds 40
    [SnapClicker]::PostMessage($handle, $WM_LBUTTONUP, [IntPtr]0, [IntPtr]$lParam) | Out-Null
    Start-Sleep -Milliseconds 80
  }
  Start-Sleep -Milliseconds $loopInterval
}`;
  }

  async stopSnapClick(options = {}) {
    const silent = options && options.silent;
    if (this.snapClickProcess) {
      try {
        this.snapClickProcess.kill();
      } catch (error) {
        console.error('Không thể dừng snap click:', error);
      }
    }

    this.cleanupSnapClickProcess();

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send('snap-click-status', {
        running: false,
        message: 'Snap click đã dừng.',
        type: 'success'
      });
    }

    return { success: true };
  }

  cleanupSnapClickProcess() {
    if (this.snapClickProcess) {
      this.snapClickProcess.removeAllListeners();
      this.snapClickProcess = null;
    }

    this.scriptHelper.cleanupTempScript(this.snapClickScriptPath);
    this.snapClickScriptPath = null;
  }
}

module.exports = SnapClickController;

