const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const ScriptHelper = require("./helpers/ScriptHelper");

class FlashController {
  constructor(ipcMain, mainWindow, appDir) {
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    this.scriptHelper = new ScriptHelper(appDir);
    this.flashProcess = null;
    this.flashProcessesByTen = {}; // Lưu PID theo tên định danh
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle("play-flash", (event, url, ten) => {
      this.openFlashPlayer(url, ten);
    });

    ipcMain.handle("get-flash-pid-by-ten", (event, ten) => {
      return this.flashProcessesByTen[ten] || null;
    });

    ipcMain.handle("find-pid-by-title", async (event, title) => {
      return await this.findPidByTitle(title);
    });
  }

  openFlashPlayer(url, ten = null) {
    const flashExePath = path.join(this.appDir, "flash.exe");

    // Kiểm tra xem file flash.exe có tồn tại không
    if (!fs.existsSync(flashExePath)) {
      console.error("Không tìm thấy file flash.exe");
      if (this.mainWindow) {
        this.mainWindow.webContents.send(
          "flash-error",
          "Không tìm thấy file flash.exe"
        );
      }
      return;
    }

    // Lưu tên định danh vào biến local để dùng trong callback
    const tenDinhDanh = ten;

    // Chạy Flash Player với URL
    this.flashProcess = spawn(flashExePath, [url], {
      cwd: this.appDir,
      detached: true,
      stdio: "ignore",
    });

    this.flashProcess.on("error", (error) => {
      console.error("Lỗi khi chạy Flash Player:", error);
      if (this.mainWindow) {
        this.mainWindow.webContents.send("flash-error", error.message);
      }
    });

    const processPid = this.flashProcess.pid;

    this.flashProcess.on("exit", (code) => {
      console.log(`Flash Player đã đóng với mã: ${code}`);
      // Xóa PID khỏi danh sách khi process đóng
      if (tenDinhDanh && this.flashProcessesByTen[tenDinhDanh] === processPid) {
        delete this.flashProcessesByTen[tenDinhDanh];
        console.log(
          `Đã xóa PID ${processPid} khỏi danh sách cho tên định danh: ${tenDinhDanh}`
        );
      }
      this.flashProcess = null;
    });

    // Cho phép Flash Player chạy độc lập
    this.flashProcess.unref();

    // Lưu PID theo tên định danh
    if (tenDinhDanh && processPid) {
      this.flashProcessesByTen[tenDinhDanh] = processPid;
      console.log(`Đã lưu PID ${processPid} cho tên định danh: ${tenDinhDanh}`);
    }

    // Thay đổi tiêu đề cửa sổ Flash Player ngay khi mở (thử nhiều lần với interval ngắn)
    if (tenDinhDanh) {
      // Thử đổi tên ngay sau một khoảng thời gian ngắn
      setTimeout(() => {
        this.changeFlashWindowTitleImmediately(tenDinhDanh);
      }, 100);
    }
  }

  changeFlashWindowTitleImmediately(newTitle) {
    const processId = this.flashProcess ? this.flashProcess.pid : null;

    if (!processId) {
      console.log("Không tìm thấy process ID của Flash Player");
      return;
    }

    // Thử đổi tên ngay với interval ngắn hơn và nhiều lần thử hơn để đổi tên nhanh nhất
    let attempts = 0;
    const maxAttempts = 30; // Tối đa 1.5 giây (30 * 50ms)
    const interval = 50; // Kiểm tra mỗi 50ms để nhanh hơn

    const tryChangeTitle = () => {
      attempts++;

      if (attempts > maxAttempts) {
        console.log("Không tìm thấy cửa sổ Flash Player sau nhiều lần thử");
        return;
      }

      // Kiểm tra xem process còn chạy không
      try {
        process.kill(processId, 0); // Signal 0 chỉ kiểm tra, không kill
      } catch (e) {
        // Process đã đóng
        return;
      }

      this.changeFlashWindowTitle(newTitle, processId, (success) => {
        if (!success && attempts < maxAttempts) {
          // Nếu chưa thành công và chưa hết số lần thử, thử lại
          setTimeout(tryChangeTitle, interval);
        } else if (success) {
          console.log(
            "Đã thay đổi tiêu đề cửa sổ Flash Player thành:",
            newTitle
          );
        }
      });
    };

    // Bắt đầu thử ngay lập tức
    tryChangeTitle();
  }

  changeFlashWindowTitle(newTitle, processId, callback) {
    if (!processId) {
      processId = this.flashProcess ? this.flashProcess.pid : null;
    }

    if (!processId) {
      if (callback) callback(false);
      return;
    }

    // Tạo PowerShell script để thay đổi tiêu đề cửa sổ
    const escapedTitle = newTitle.replace(/"/g, '`"').replace(/\$/g, "`$");

    const powershellScript = `Add-Type @"
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
$processId = ${processId}
$newTitle = "${escapedTitle}"
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
if ($found) { Write-Output "SUCCESS" } else { Write-Output "NOTFOUND" }`;

    // Sử dụng ScriptHelper để tạo file tạm
    const scriptPath = this.scriptHelper.writeTempScript(
      "changeWindowTitle",
      powershellScript
    );

    // Chạy PowerShell script
    exec(
      `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
      (error, stdout, stderr) => {
        // Xóa file script tạm
        this.scriptHelper.cleanupTempScript(scriptPath);

        const success = stdout && stdout.toString().trim() === "SUCCESS";
        if (callback) {
          callback(success);
        } else if (success) {
          console.log(
            "Đã thay đổi tiêu đề cửa sổ Flash Player thành:",
            newTitle
          );
        }
      }
    );
  }

  async findPidByTitle(title) {
    const keyword = (title || "").trim();
    if (!keyword) {
      return { success: false, error: "Thiếu tên định danh để tìm PID." };
    }

    const escapedTitle = keyword.replace(/"/g, '`"').replace(/\$/g, "`$");

    // Sử dụng PowerShell command để tìm PID theo MainWindowTitle
    const powershellCommand = `Get-Process | Where-Object { $_.MainWindowTitle -like "*${escapedTitle}*" } | Select-Object -First 1 Id, ProcessName, MainWindowTitle | ConvertTo-Json -Compress`;

    return await new Promise((resolve) => {
      exec(
        `powershell -ExecutionPolicy Bypass -Command "${powershellCommand}"`,
        (error, stdout, stderr) => {
          if (error) {
            console.error("Lỗi khi tìm PID theo tên:", stderr || error.message);
            resolve({ success: false, error: "Không tìm được PID theo tên." });
            return;
          }

          const output = stdout ? stdout.toString().trim() : "";
          if (!output) {
            resolve({
              success: false,
              error: "Không tìm thấy process với tên định danh này.",
            });
            return;
          }

          try {
            const parsed = JSON.parse(output);
            if (parsed && parsed.Id) {
              resolve({
                success: true,
                pid: parsed.Id,
                processName: parsed.ProcessName,
                windowTitle: parsed.MainWindowTitle,
              });
            } else {
              resolve({ success: false, error: "Không tìm thấy PID hợp lệ." });
            }
          } catch (err) {
            console.error("Không parse được kết quả tìm PID:", output);
            resolve({ success: false, error: "Dữ liệu trả về không hợp lệ." });
          }
        }
      );
    });
  }
}

module.exports = FlashController;
