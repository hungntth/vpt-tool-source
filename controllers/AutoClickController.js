const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const ScriptHelper = require('./helpers/ScriptHelper');

class AutoClickController {
  constructor(ipcMain, mainWindow, appDir) {
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    this.scriptHelper = new ScriptHelper(appDir);
    this.autoClickProcess = null;
    this.autoClickScriptPath = null;
    this.autoClickTarget = null;
    this.autoClickProcesses = {}; // Lưu auto process cho từng item: { itemId: { process, scriptPath, targetWindow } }
    this.autoConfigPath = path.join(this.appDir, 'auto-config.json');
    this.autoClickConfig = this.loadAutoClickConfig();
    this.autoProfilesPath = path.join(this.appDir, 'auto-profiles.json');
    this.autoProfiles = this.loadAutoProfilesFromDisk();
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle('auto-load-config', () => this.autoClickConfig);
    ipcMain.handle('auto-save-config', (event, partialConfig) => this.saveAutoClickConfig(partialConfig || {}));
    ipcMain.handle('auto-list-profiles', () => this.autoProfiles);
    ipcMain.handle('auto-save-profile', (event, profile) => this.saveAutoProfile(profile || {}));
    ipcMain.handle('auto-delete-profile', (event, profileName) => this.deleteAutoProfile(profileName));
    ipcMain.handle('auto-target-by-title', async (event, title) => this.detectAutoWindowByTitle(title));
    ipcMain.handle('auto-target-by-pid', async (event, pid) => this.detectAutoWindowByPid(pid));
    ipcMain.handle('auto-detect-window', async (event, coords) => {
      return await this.detectAutoClickWindow(coords);
    });
    ipcMain.handle('auto-compute-point', async (event, coords) => {
      return await this.computeAutoClickPoint(coords);
    });
    ipcMain.handle('auto-start', async (event, config) => {
      return await this.startAutoClick(config);
    });
    ipcMain.handle('auto-start-for-item', async (event, itemId, config) => {
      return await this.startAutoClickForItem(itemId, config);
    });
    ipcMain.handle('auto-stop-for-item', async (event, itemId) => {
      return await this.stopAutoClickForItem(itemId);
    });
    ipcMain.handle('auto-stop', async () => {
      return await this.stopAutoClick();
    });
  }

  async detectAutoClickWindow(coords = {}) {
    const { x, y } = coords;
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { success: false, error: 'Tọa độ không hợp lệ.' };
    }

    const pointX = Math.round(x);
    const pointY = Math.round(y);

    const scriptContent = `Add-Type @"
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
$point.X = ${pointX}
$point.Y = ${pointY}
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
$result | ConvertTo-Json -Compress`;

    const scriptPath = this.scriptHelper.writeTempScript('detectWindow', scriptContent);

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

        let parsed;
        try {
          parsed = JSON.parse(output);
        } catch (e) {
          console.error('Không parse được JSON trả về:', output);
          resolve({ success: false, error: 'Dữ liệu trả về không hợp lệ.' });
          return;
        }

        this.autoClickTarget = {
          pid: parsed.pid,
          title: parsed.title,
          handle: Number(parsed.handle) || parsed.handle
        };

        resolve({
          success: true,
          window: this.autoClickTarget
        });
      });
    });
  }

  async detectAutoWindowByTitle(title) {
    const keyword = (title || '').trim();
    if (!keyword) {
      return { success: false, error: 'Thiếu tên định danh để tìm ứng dụng.' };
    }

    const escapedTitle = keyword.replace(/"/g, '`"').replace(/\$/g, '`$');

    const scriptContent = `Add-Type @"
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
$keyword = "${escapedTitle}"
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
if ($foundWindow) { $foundWindow | ConvertTo-Json -Compress } else { Write-Output "NOTFOUND" }`;

    const scriptPath = this.scriptHelper.writeTempScript('autoFindByTitle', scriptContent);

    return await new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
        this.scriptHelper.cleanupTempScript(scriptPath);

        if (error) {
          console.error('Lỗi khi tìm ứng dụng theo tên:', stderr || error.message);
          resolve({ success: false, error: 'Không tìm được ứng dụng theo tên.' });
          return;
        }

        const output = stdout ? stdout.toString().trim() : '';
        if (!output || output === 'NOTFOUND') {
          resolve({ success: false, error: 'Không tìm thấy cửa sổ trùng tên.' });
          return;
        }

        try {
          const parsed = JSON.parse(output);
          this.autoClickTarget = {
            pid: parsed.pid,
            title: parsed.title,
            handle: Number(parsed.handle) || parsed.handle
          };

          resolve({
            success: true,
            window: this.autoClickTarget
          });
        } catch (err) {
          console.error('Không parse được kết quả tìm cửa sổ:', output);
          resolve({ success: false, error: 'Dữ liệu trả về không hợp lệ.' });
        }
      });
    });
  }

  async detectAutoWindowByPid(pid) {
    const processId = Number(pid);
    if (!processId || !Number.isInteger(processId) || processId <= 0) {
      return { success: false, error: 'PID không hợp lệ.' };
    }

    const scriptContent = `Add-Type @"
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
$targetPid = ${processId}
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
if ($foundWindow) { $foundWindow | ConvertTo-Json -Compress } else { Write-Output "NOTFOUND" }`;

    const scriptPath = this.scriptHelper.writeTempScript('autoFindByPid', scriptContent);

    return await new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
        this.scriptHelper.cleanupTempScript(scriptPath);

        if (error) {
          console.error('Lỗi khi tìm ứng dụng theo PID:', stderr || error.message);
          resolve({ success: false, error: 'Không tìm được ứng dụng theo PID.' });
          return;
        }

        const output = stdout ? stdout.toString().trim() : '';
        if (!output || output === 'NOTFOUND') {
          resolve({ success: false, error: 'Không tìm thấy cửa sổ với PID này.' });
          return;
        }

        try {
          const parsed = JSON.parse(output);
          this.autoClickTarget = {
            pid: parsed.pid,
            title: parsed.title,
            handle: Number(parsed.handle) || parsed.handle
          };

          resolve({
            success: true,
            window: this.autoClickTarget
          });
        } catch (err) {
          console.error('Không parse được kết quả tìm cửa sổ theo PID:', output);
          resolve({ success: false, error: 'Dữ liệu trả về không hợp lệ.' });
        }
      });
    });
  }

  async computeAutoClickPoint(coords = {}) {
    const { x, y } = coords;
    if (!this.autoClickTarget || typeof x !== 'number' || typeof y !== 'number') {
      return { success: false, error: 'Thiếu thông tin ứng dụng hoặc tọa độ.' };
    }

    const screenX = Math.round(x);
    const screenY = Math.round(y);
    const handleValue = this.autoClickTarget.handle;

    const scriptContent = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoPointResolver {
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
$rect = New-Object AutoPointResolver+RECT
if (-not [AutoPointResolver]::GetWindowRect($handle, [ref]$rect)) {
  Write-Output "NOTFOUND"
  exit
}
$offsetX = ${screenX} - $rect.Left
$offsetY = ${screenY} - $rect.Top
if ($offsetX -lt 0 -or $offsetY -lt 0) {
  Write-Output "OUTSIDE"
  exit
}
$point = [PSCustomObject]@{
  offsetX = $offsetX
  offsetY = $offsetY
  screenX = ${screenX}
  screenY = ${screenY}
}
$point | ConvertTo-Json -Compress`;

    const scriptPath = this.scriptHelper.writeTempScript('resolvePoint', scriptContent);

    return await new Promise((resolve) => {
      exec(`powershell -ExecutionPolicy Bypass -File "${scriptPath}"`, (error, stdout, stderr) => {
        this.scriptHelper.cleanupTempScript(scriptPath);

        if (error) {
          console.error('Lỗi khi tính điểm auto:', stderr || error.message);
          resolve({ success: false, error: 'Không xác định được điểm auto.' });
          return;
        }

        const output = stdout ? stdout.toString().trim() : '';
        if (!output || output === 'NOTFOUND') {
          resolve({ success: false, error: 'Không lấy được kích thước cửa sổ.' });
          return;
        }

        if (output === 'OUTSIDE') {
          resolve({ success: false, error: 'Điểm thả nằm ngoài cửa sổ.' });
          return;
        }

        try {
          const point = JSON.parse(output);
          resolve({ success: true, point });
        } catch (e) {
          console.error('Không parse được JSON điểm auto:', output);
          resolve({ success: false, error: 'Dữ liệu điểm không hợp lệ.' });
        }
      });
    });
  }

  async startAutoClick(config = {}) {
    if (!this.autoClickTarget || !this.autoClickTarget.handle) {
      return { success: false, error: 'Vui lòng chọn ứng dụng trước khi chạy auto.' };
    }

    const points = Array.isArray(config.points) ? config.points : [];
    if (points.length === 0) {
      return { success: false, error: 'Chưa có điểm auto nào.' };
    }

    const sanitizedPoints = this.normalizeAutoPoints(points);

    if (sanitizedPoints.length === 0) {
      return { success: false, error: 'Điểm auto không hợp lệ.' };
    }

    const interval = Math.max(200, Number(config.interval) || 1000);

    // Dừng tiến trình hiện tại (nếu có)
    await this.stopAutoClick({ silent: true });

    const pointsJson = JSON.stringify(sanitizedPoints)
      .replace(/"/g, '`"')
      .replace(/\$/g, '`$');
    const scriptContent = this.buildAutoClickScript(this.autoClickTarget.handle, interval, pointsJson);
    const scriptPath = this.scriptHelper.writeTempScript('autoClickRunner', scriptContent);
    this.autoClickScriptPath = scriptPath;
    this.saveAutoClickConfig({
      points: sanitizedPoints,
      interval
    });

    return await new Promise((resolve) => {
      this.autoClickProcess = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        cwd: this.appDir,
        windowsHide: true
      });

      this.autoClickProcess.stdout.on('data', (data) => {
        const message = data.toString().trim();
        if (!message) return;

        if (message === 'TARGET_LOST') {
          this.autoClickTarget = null;
          if (this.mainWindow) {
            this.mainWindow.webContents.send('auto-click-status', {
              running: false,
              message: 'Cửa sổ mục tiêu đã đóng hoặc không còn hợp lệ.',
              type: 'error',
              targetLost: true
            });
          }
          this.stopAutoClick({ silent: true });
        }
      });

      this.autoClickProcess.stderr.on('data', (data) => {
        console.error('Auto click stderr:', data.toString());
      });

      this.autoClickProcess.on('exit', (code) => {
        this.cleanupAutoClickProcess();
        if (this.mainWindow) {
          this.mainWindow.webContents.send('auto-click-status', {
            running: false,
            message: code === 0 ? 'Auto click đã dừng.' : 'Auto click dừng đột ngột.',
            type: code === 0 ? 'success' : 'error'
          });
        }
      });

      resolve({ success: true });
    });
  }

  buildAutoClickScript(handleValue, interval, pointsJson) {
    return `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoClicker {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ScreenToClient(IntPtr hWnd, ref POINT lpPoint);
  [DllImport("user32.dll")]
  public static extern IntPtr PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
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
  if (-not [AutoClicker]::IsWindow($handle)) {
    Write-Output "TARGET_LOST"
    break
  }
  $rect = New-Object AutoClicker+RECT
  if (-not [AutoClicker]::GetWindowRect($handle, [ref]$rect)) {
    Start-Sleep -Milliseconds 300
    continue
  }
  foreach ($point in $points) {
    $screenPoint = New-Object AutoClicker+POINT
    $screenPoint.X = [int]($rect.Left + $point.offsetX)
    $screenPoint.Y = [int]($rect.Top + $point.offsetY)
    $clientPoint = $screenPoint
    [AutoClicker]::ScreenToClient($handle, [ref]$clientPoint) | Out-Null
    $clientX = $clientPoint.X
    $clientY = $clientPoint.Y
    if ($clientX -lt 0 -or $clientY -lt 0) {
      continue
    }
    $lParam = ($clientY -band 0xFFFF) -shl 16 -bor ($clientX -band 0xFFFF)
    [AutoClicker]::PostMessage($handle, $WM_LBUTTONDOWN, [IntPtr]1, [IntPtr]$lParam) | Out-Null
    Start-Sleep -Milliseconds 40
    [AutoClicker]::PostMessage($handle, $WM_LBUTTONUP, [IntPtr]0, [IntPtr]$lParam) | Out-Null
    Start-Sleep -Milliseconds 80
  }
  Start-Sleep -Milliseconds $loopInterval
}`;
  }

  async stopAutoClick(options = {}) {
    const silent = options && options.silent;
    if (this.autoClickProcess) {
      try {
        this.autoClickProcess.kill();
      } catch (error) {
        console.error('Không thể dừng auto click:', error);
      }
    }

    this.cleanupAutoClickProcess();

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send('auto-click-status', {
        running: false,
        message: 'Auto click đã dừng.',
        type: 'success'
      });
    }

    return { success: true };
  }

  async startAutoClickForItem(itemId, config = {}) {
    if (!config.targetWindow || !config.targetWindow.handle) {
      return { success: false, error: 'Thiếu thông tin cửa sổ đích.' };
    }

    const points = Array.isArray(config.points) ? config.points : [];
    if (points.length === 0) {
      return { success: false, error: 'Chưa có điểm auto nào.' };
    }

    const sanitizedPoints = this.normalizeAutoPoints(points);
    if (sanitizedPoints.length === 0) {
      return { success: false, error: 'Điểm auto không hợp lệ.' };
    }

    const interval = Math.max(200, Number(config.interval) || 1000);

    // Dừng auto cũ của item này nếu có
    await this.stopAutoClickForItem(itemId, { silent: true });

    const pointsJson = JSON.stringify(sanitizedPoints)
      .replace(/"/g, '`"')
      .replace(/\$/g, '`$');
    const scriptContent = this.buildAutoClickScript(config.targetWindow.handle, interval, pointsJson);
    const scriptPath = this.scriptHelper.writeTempScript(`autoClickRunner-${itemId}`, scriptContent);

    return await new Promise((resolve) => {
      const process = spawn('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
        cwd: this.appDir,
        windowsHide: true
      });

      // Lưu thông tin process cho item này
      this.autoClickProcesses[itemId] = {
        process,
        scriptPath,
        targetWindow: config.targetWindow
      };

      process.stdout.on('data', (data) => {
        const message = data.toString().trim();
        if (!message) return;

        if (message === 'TARGET_LOST') {
          if (this.mainWindow) {
            this.mainWindow.webContents.send('auto-click-status-for-item', {
              itemId,
              running: false,
              message: 'Cửa sổ mục tiêu đã đóng hoặc không còn hợp lệ.',
              type: 'error',
              targetLost: true
            });
          }
          this.stopAutoClickForItem(itemId, { silent: true });
        }
      });

      process.stderr.on('data', (data) => {
        console.error(`Auto click stderr cho item ${itemId}:`, data.toString());
      });

      process.on('exit', (code) => {
        this.cleanupAutoClickProcessForItem(itemId);
        if (this.mainWindow) {
          this.mainWindow.webContents.send('auto-click-status-for-item', {
            itemId,
            running: false,
            message: code === 0 ? 'Auto click đã dừng.' : 'Auto click dừng đột ngột.',
            type: code === 0 ? 'success' : 'error'
          });
        }
      });

      resolve({ success: true });
    });
  }

  async stopAutoClickForItem(itemId, options = {}) {
    const silent = options && options.silent;
    const itemProcess = this.autoClickProcesses[itemId];
    
    if (!itemProcess) {
      // Nếu không có process, vẫn trả về success để cập nhật UI
      if (!silent && this.mainWindow) {
        this.mainWindow.webContents.send('auto-click-status-for-item', {
          itemId,
          running: false,
          message: 'Auto click đã dừng.',
          type: 'success'
        });
      }
      return { success: true };
    }
    
    if (itemProcess.process) {
      try {
        itemProcess.process.kill();
        console.log(`Đã kill process cho item ${itemId}`);
      } catch (error) {
        console.error(`Không thể dừng auto click cho item ${itemId}:`, error);
      }
    }

    this.cleanupAutoClickProcessForItem(itemId);

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send('auto-click-status-for-item', {
        itemId,
        running: false,
        message: 'Auto click đã dừng.',
        type: 'success'
      });
    }

    return { success: true };
  }

  cleanupAutoClickProcessForItem(itemId) {
    const itemProcess = this.autoClickProcesses[itemId];
    if (itemProcess) {
      if (itemProcess.process) {
        itemProcess.process.removeAllListeners();
      }
      if (itemProcess.scriptPath) {
        this.scriptHelper.cleanupTempScript(itemProcess.scriptPath);
      }
      delete this.autoClickProcesses[itemId];
    }
  }

  cleanupAutoClickProcess() {
    if (this.autoClickProcess) {
      this.autoClickProcess.removeAllListeners();
      this.autoClickProcess = null;
    }

    this.scriptHelper.cleanupTempScript(this.autoClickScriptPath);
    this.autoClickScriptPath = null;
  }

  loadAutoProfilesFromDisk() {
    try {
      if (fs.existsSync(this.autoProfilesPath)) {
        const raw = fs.readFileSync(this.autoProfilesPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed
            .map((profile) => this.normalizeAutoProfile(profile))
            .filter(Boolean);
        }
      }
    } catch (error) {
      console.warn('Không thể đọc danh sách quy trình auto:', error.message);
    }
    return [];
  }

  normalizeAutoProfile(profile) {
    if (!profile || typeof profile.name !== 'string') {
      return null;
    }
    const name = profile.name.trim();
    if (!name) {
      return null;
    }
    const points = this.normalizeAutoPoints(profile.points || []);
    if (!points.length) {
      return null;
    }
    return {
      name,
      interval: Math.max(200, Number(profile.interval) || 1200),
      points
    };
  }

  persistAutoProfiles() {
    try {
      fs.writeFileSync(this.autoProfilesPath, JSON.stringify(this.autoProfiles, null, 2), 'utf8');
    } catch (error) {
      console.error('Không thể lưu danh sách quy trình auto:', error.message);
    }
  }

  saveAutoProfile(payload = {}) {
    const name = (payload.name || '').trim();
    if (!name) {
      return { success: false, error: 'Tên quy trình không hợp lệ.' };
    }
    const points = this.normalizeAutoPoints(payload.points || []);
    if (!points.length) {
      return { success: false, error: 'Quy trình cần ít nhất một điểm auto.' };
    }
    const interval = Math.max(200, Number(payload.interval) || 1000);
    const profile = { name, interval, points };

    const existingIndex = this.autoProfiles.findIndex(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex >= 0) {
      this.autoProfiles[existingIndex] = profile;
    } else {
      this.autoProfiles.push(profile);
    }

    this.persistAutoProfiles();
    return { success: true, profiles: this.autoProfiles };
  }

  deleteAutoProfile(profileName) {
    if (!profileName) {
      return { success: false, error: 'Thiếu tên quy trình.' };
    }

    const before = this.autoProfiles.length;
    this.autoProfiles = this.autoProfiles.filter(
      (profile) => profile.name.toLowerCase() !== String(profileName).toLowerCase()
    );

    if (this.autoProfiles.length === before) {
      return { success: false, error: 'Không tìm thấy quy trình cần xóa.' };
    }

    this.persistAutoProfiles();
    return { success: true, profiles: this.autoProfiles };
  }

  loadAutoClickConfig() {
    try {
      if (fs.existsSync(this.autoConfigPath)) {
        const raw = fs.readFileSync(this.autoConfigPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          interval: Number(parsed.interval) || 1200,
          points: Array.isArray(parsed.points) ? this.normalizeAutoPoints(parsed.points) : []
        };
      }
    } catch (error) {
      console.warn('Không thể đọc cấu hình auto click:', error.message);
    }
    return {
      interval: 1200,
      points: []
    };
  }

  normalizeAutoPoints(points) {
    return points
      .map((point) => ({
        offsetX: Number(point.offsetX),
        offsetY: Number(point.offsetY)
      }))
      .filter((point) => Number.isFinite(point.offsetX) && Number.isFinite(point.offsetY));
  }

  saveAutoClickConfig(partial = {}) {
    const nextConfig = {
      ...this.autoClickConfig,
      ...partial
    };

    if (partial.interval !== undefined) {
      nextConfig.interval = Math.max(200, Number(partial.interval) || 1200);
    } else {
      nextConfig.interval = Math.max(200, Number(nextConfig.interval) || 1200);
    }

    if (partial.points) {
      nextConfig.points = this.normalizeAutoPoints(partial.points);
    } else if (!Array.isArray(nextConfig.points)) {
      nextConfig.points = [];
    }

    this.autoClickConfig = nextConfig;

    try {
      fs.writeFileSync(this.autoConfigPath, JSON.stringify(this.autoClickConfig, null, 2), 'utf8');
    } catch (error) {
      console.error('Không thể lưu cấu hình auto click:', error.message);
    }

    return this.autoClickConfig;
  }
}

module.exports = AutoClickController;

