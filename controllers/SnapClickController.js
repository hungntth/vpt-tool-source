const { exec } = require("child_process");
const { BrowserWindow, app } = require("electron");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const ScriptHelper = require("./helpers/ScriptHelper");

class SnapClickController {
  constructor(ipcMain, mainWindow, appDir) {
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    // Lưu snap folder và config vào userData thay vì appDir (writable khi build)
    const userDataPath = app.getPath("userData");
    this.snapDir = path.join(userDataPath, "snap");
    // Tạo folder snap nếu chưa có
    if (!fs.existsSync(this.snapDir)) {
      fs.mkdirSync(this.snapDir, { recursive: true });
      console.log("[SnapClickController] Đã tạo folder snap:", this.snapDir);
    }
    this.scriptHelper = new ScriptHelper(appDir);
    this.snapClickProcess = null;
    this.snapClickScriptPath = null;
    this.snapClickTarget = null;
    this.snapPoints = []; // Lưu các điểm đã chọn: [{ offsetX, offsetY, imagePath, selection, templateImagePath }]
    this.snapClickProcesses = {}; // Lưu snap process cho từng item: { itemId: { process, scriptPath, targetWindow } }
    this.snapConfigPath = path.join(userDataPath, "snap-config.json");
    this.snapConfig = this.loadSnapConfig();
    this.snapProfilesPath = path.join(userDataPath, "snap-profiles.json");
    this.snapProfiles = this.loadSnapProfilesFromDisk();
    this.selectorWindow = null;
    this.snapEngine = "legacy";
    this.sharpLoopActive = false;
    this.sharpLoopTimeout = null;
    this.sharpLoopConfig = null;
    this.sharpTemplateCache = new Map();
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle("snap-detect-window", async (event, coords) => {
      return await this.detectWindow(coords);
    });

    ipcMain.handle("snap-capture-window", async (event, windowInfo) => {
      return await this.captureWindow(windowInfo);
    });

    ipcMain.handle("snap-save-point", (event, point) => {
      return this.saveSnapPoint(point);
    });

    ipcMain.handle("snap-load-config", () => {
      return this.snapConfig;
    });

    ipcMain.handle("snap-delete-point", (event, index) => {
      return this.deleteSnapPoint(index);
    });

    ipcMain.handle("snap-edit-point", (event, index, pointData) => {
      return this.editSnapPoint(index, pointData);
    });

    ipcMain.handle("snap-get-point", (event, index) => {
      return this.getSnapPoint(index);
    });

    ipcMain.handle(
      "snap-open-selector-with-image",
      async (event, imagePath) => {
        return await this.openSelectorWithImage(imagePath);
      }
    );

    ipcMain.handle("snap-save-profile", (event, payload) => {
      return this.saveSnapProfile(payload);
    });

    ipcMain.handle("snap-load-profiles", () => {
      return { success: true, profiles: this.snapProfiles };
    });

    ipcMain.handle("snap-load-profile", (event, profileName) => {
      return this.loadSnapProfile(profileName);
    });

    ipcMain.handle("snap-delete-profile", (event, profileName) => {
      return this.deleteSnapProfile(profileName);
    });

    ipcMain.handle("snap-start-for-item", async (event, itemId, config) => {
      return await this.startSnapClickForItem(itemId, config);
    });

    ipcMain.handle("snap-stop-for-item", async (event, itemId) => {
      return await this.stopSnapClickForItem(itemId);
    });

    ipcMain.handle("snap-start", async (event, config) => {
      return await this.startSnapClick(config);
    });

    ipcMain.handle("snap-stop", async () => {
      return await this.stopSnapClick();
    });

    // Xử lý lưu dữ liệu từ cửa sổ selector
    ipcMain.on("snap-selector-save", (event, data) => {
      this.handleSelectorSave(data);
    });

    // Xử lý edit point - nhận edit request và mở selector với dữ liệu cũ
    ipcMain.on("snap-selector-edit", (event, data) => {
      this.handleSelectorEdit(data);
    });
  }

  async detectWindow(coords = {}) {
    const { x, y } = coords;
    if (typeof x !== "number" || typeof y !== "number") {
      return { success: false, error: "Tọa độ không hợp lệ." };
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

    const scriptPath = this.scriptHelper.writeTempScript(
      "snapDetectWindow",
      scriptContent
    );

    return await new Promise((resolve) => {
      exec(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        (error, stdout, stderr) => {
          this.scriptHelper.cleanupTempScript(scriptPath);

          if (error) {
            console.error(
              "Lỗi khi xác định ứng dụng:",
              stderr || error.message
            );
            resolve({ success: false, error: "Không xác định được ứng dụng." });
            return;
          }

          const output = stdout ? stdout.toString().trim() : "";
          if (!output || output === "NOTFOUND") {
            resolve({
              success: false,
              error: "Không tìm thấy cửa sổ ở vị trí đã thả.",
            });
            return;
          }

          try {
            const parsed = JSON.parse(output);
            this.snapClickTarget = {
              pid: parsed.pid,
              title: parsed.title,
              handle: Number(parsed.handle) || parsed.handle,
            };

            resolve({
              success: true,
              window: this.snapClickTarget,
            });
          } catch (e) {
            console.error("Không parse được JSON trả về:", output);
            resolve({ success: false, error: "Dữ liệu trả về không hợp lệ." });
          }
        }
      );
    });
  }

  async captureWindow(windowInfo) {
    if (!windowInfo || !windowInfo.handle) {
      return { success: false, error: "Thiếu thông tin cửa sổ." };
    }

    const handleValue = windowInfo.handle;
    const timestamp = Date.now();
    const imagePath = path.join(this.snapDir, `snap-${timestamp}.png`);

    const escapedImagePath = imagePath
      .replace(/\\/g, "\\\\")
      .replace(/\$/g, "`$")
      .replace(/"/g, '`"');
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

    const scriptPath = this.scriptHelper.writeTempScript(
      "snapCapture",
      scriptContent
    );

    return await new Promise((resolve) => {
      exec(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        (error, stdout, stderr) => {
          this.scriptHelper.cleanupTempScript(scriptPath);

          if (error) {
            console.error("Lỗi khi chụp màn hình:", stderr || error.message);
            resolve({
              success: false,
              error: "Không thể chụp màn hình cửa sổ.",
            });
            return;
          }

          const output = stdout ? stdout.toString().trim() : "";
          if (output === "SUCCESS" && fs.existsSync(imagePath)) {
            // Đọc file ảnh và chuyển thành base64 để gửi về frontend
            try {
              const imageBuffer = fs.readFileSync(imagePath);
              const base64Image = imageBuffer.toString("base64");
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

              const rectScriptPath = this.scriptHelper.writeTempScript(
                "getWindowRect",
                rectScript
              );

              // Đợi lấy window rect trước khi resolve
              exec(
                `powershell -ExecutionPolicy Bypass -File "${rectScriptPath}"`,
                (rectError, rectStdout, rectStderr) => {
                  this.scriptHelper.cleanupTempScript(rectScriptPath);

                  let windowRect = { left: 0, top: 0, width: 0, height: 0 };
                  if (rectError) {
                    console.error(
                      "[SnapClickController] Lỗi khi lấy window rect:",
                      rectError
                    );
                    console.error("[SnapClickController] stderr:", rectStderr);
                  } else if (
                    rectStdout &&
                    rectStdout.toString().trim() !== "ERROR"
                  ) {
                    try {
                      windowRect = JSON.parse(rectStdout.toString().trim());
                      console.log(
                        "[SnapClickController] Đã lấy window rect:",
                        windowRect
                      );
                    } catch (e) {
                      console.error(
                        "[SnapClickController] Không parse được window rect:",
                        e
                      );
                      console.error(
                        "[SnapClickController] stdout:",
                        rectStdout.toString()
                      );
                    }
                  } else {
                    console.warn(
                      "[SnapClickController] Không lấy được window rect, sử dụng giá trị mặc định"
                    );
                  }

                  // Mở cửa sổ selector để chọn điểm
                  try {
                    // Nếu đang edit, gửi thông tin edit
                    let editData = null;
                    if (
                      typeof this.editingIndex === "number" &&
                      this.editingIndex >= 0 &&
                      this.editingIndex < this.snapPoints.length
                    ) {
                      const editPoint = this.snapPoints[this.editingIndex];
                      editData = {
                        offsetX: editPoint.offsetX,
                        offsetY: editPoint.offsetY,
                        selections:
                          editPoint.selections ||
                          (editPoint.selection ? [editPoint.selection] : []),
                      };
                    }
                    this.openSelectorWindow(
                      dataUrl,
                      imagePath,
                      windowRect,
                      editData
                    );
                  } catch (error) {
                    console.error(
                      "[SnapClickController] Lỗi khi mở cửa sổ selector:",
                      error
                    );
                  }

                  resolve({
                    success: true,
                    imagePath: imagePath,
                    dataUrl: dataUrl,
                    windowRect: windowRect,
                  });
                }
              );
            } catch (e) {
              console.error("Lỗi khi đọc file ảnh:", e);
              resolve({ success: false, error: "Không thể đọc file ảnh." });
            }
          } else {
            resolve({
              success: false,
              error: output || "Không thể chụp màn hình.",
            });
          }
        }
      );
    });
  }

  async openSelectorWithImage(imagePath) {
    try {
      if (!imagePath || !fs.existsSync(imagePath)) {
        return { success: false, error: "Ảnh không tồn tại." };
      }

      // Đọc file ảnh và chuyển thành base64
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString("base64");
      const dataUrl = `data:image/png;base64,${base64Image}`;

      // Lấy editData từ editingPoint nếu đang edit
      let windowRect = { left: 0, top: 0, width: 0, height: 0 };
      let editData = null;

      if (this.editingPoint && typeof this.editingIndex === "number") {
        editData = {
          offsetX: this.editingPoint.offsetX,
          offsetY: this.editingPoint.offsetY,
          selections:
            this.editingPoint.selections ||
            (this.editingPoint.selection ? [this.editingPoint.selection] : []),
        };
      }

      this.openSelectorWindow(dataUrl, imagePath, windowRect, editData);
      return { success: true };
    } catch (error) {
      console.error(
        "[SnapClickController] Lỗi khi mở selector với ảnh:",
        error
      );
      return { success: false, error: error.message };
    }
  }

  openSelectorWindow(imageDataUrl, imagePath, windowRect, editData = null) {
    try {
      console.log("[SnapClickController] Mở cửa sổ selector:", {
        hasImageDataUrl: !!imageDataUrl,
        imageDataUrlLength: imageDataUrl?.length,
        imagePath: imagePath,
        windowRect: windowRect,
        isEdit: !!editData,
      });

      // Đóng cửa sổ cũ nếu có
      if (this.selectorWindow) {
        console.log("[SnapClickController] Đóng cửa sổ selector cũ");
        this.selectorWindow.close();
      }

      if (!imageDataUrl) {
        console.error(
          "[SnapClickController] Lỗi: Không có imageDataUrl để gửi"
        );
        return;
      }

      const htmlPath = path.join(this.appDir, "views", "snap-selector.html");
      if (!fs.existsSync(htmlPath)) {
        console.error(
          "[SnapClickController] Lỗi: Không tìm thấy file HTML:",
          htmlPath
        );
        return;
      }

      // Tạo cửa sổ mới
      this.selectorWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: editData ? "Chỉnh sửa điểm trên ảnh" : "Chọn điểm trên ảnh",
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
        parent: this.mainWindow,
        modal: false,
      });

      console.log("[SnapClickController] Đã tạo cửa sổ selector");

      // Load file HTML
      this.selectorWindow.loadFile(htmlPath);

      // Xử lý lỗi khi load file
      this.selectorWindow.webContents.on(
        "did-fail-load",
        (event, errorCode, errorDescription, validatedURL) => {
          console.error("[SnapClickController] Lỗi khi load file HTML:", {
            errorCode: errorCode,
            errorDescription: errorDescription,
            validatedURL: validatedURL,
          });
        }
      );

      // Gửi dữ liệu ảnh khi cửa sổ sẵn sàng
      this.selectorWindow.webContents.once("did-finish-load", () => {
        try {
          console.log(
            "[SnapClickController] Cửa sổ đã load xong, gửi dữ liệu ảnh"
          );
          this.selectorWindow.webContents.send("snap-image-data", {
            imageDataUrl: imageDataUrl,
            imagePath: imagePath,
            windowRect: windowRect,
            editData: editData, // Gửi thông tin edit nếu có
          });
          console.log("[SnapClickController] Đã gửi dữ liệu ảnh thành công");
        } catch (error) {
          console.error(
            "[SnapClickController] Lỗi khi gửi dữ liệu ảnh:",
            error
          );
        }
      });

      // Xử lý khi cửa sổ đóng
      this.selectorWindow.on("closed", () => {
        console.log("[SnapClickController] Cửa sổ selector đã đóng");
        this.selectorWindow = null;
      });

      // Xử lý console log từ renderer process để debug
      this.selectorWindow.webContents.on(
        "console-message",
        (event, level, message, line, sourceId) => {
          const levelName =
            ["", "INFO", "WARNING", "ERROR"][level] || "UNKNOWN";
          console.log(`[Snap Selector Renderer ${levelName}]`, message);
        }
      );
    } catch (error) {
      console.error(
        "[SnapClickController] Lỗi trong openSelectorWindow:",
        error
      );
    }
  }

  async generateTemplateWithSharp(sourcePath, selection, outputPath) {
    if (!sourcePath || !selection || !fs.existsSync(sourcePath)) {
      throw new Error("Ảnh nguồn hoặc vùng chọn không hợp lệ");
    }

    const rect = this.normalizeSelectionRect(selection);
    if (!rect) {
      throw new Error("Không xác định được toạ độ vùng chọn");
    }

    this.invalidateSharpCache(outputPath);

    await sharp(sourcePath)
      .extract(rect)
      .grayscale()
      .normalize()
      .sharpen()
      .toFile(outputPath);

    return outputPath;
  }

  handleSelectorEdit(data) {
    const { point, index } = data;
    if (!point || typeof index !== "number") {
      return;
    }

    // Lưu thông tin edit để sử dụng khi save (chưa xóa point cũ)
    this.editingIndex = index;
    this.editingPoint = point;
  }

  handleSelectorSave(data) {
    const { points, imagePath } = data;

    if (!points || points.length === 0) {
      if (this.mainWindow) {
        this.mainWindow.webContents.send("snap-selector-saved", {
          success: false,
          error: "Chưa chọn điểm nào.",
        });
      }
      return;
    }

    // Lưu template images cho mỗi selection của mỗi điểm - xử lý async
    const processPoints = async () => {
      const newPoints = [];

      for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
        const point = points[pointIndex];
        const selections = Array.isArray(point.selections)
          ? point.selections
          : [];

        // Tạo template images cho mỗi selection
        const templateImagePaths = [];
        for (let selIndex = 0; selIndex < selections.length; selIndex++) {
          const selection = selections[selIndex];
          if (selection && imagePath && fs.existsSync(imagePath)) {
            try {
              // Cắt ảnh template từ khu vực selection
              const templatePath = path.join(
                this.snapDir,
                `template-${Date.now()}-${pointIndex}-${selIndex}.png`
              );
              await this.generateTemplateWithSharp(
                imagePath,
                selection,
                templatePath
              );
              templateImagePaths.push({
                selection: selection,
                templateImagePath: templatePath,
              });
            } catch (error) {
              console.error(
                `[SnapClickController] Lỗi khi cắt ảnh template cho selection ${selIndex}:`,
                error
              );
            }
          }
        }

        // Lưu điểm với thông tin selections và template images
        newPoints.push({
          offsetX: point.offsetX,
          offsetY: point.offsetY,
          selections: templateImagePaths, // Mảng {selection, templateImagePath}
          imagePath: imagePath || null, // Lưu imagePath gốc
          id: Date.now() + pointIndex,
        });
      }

      // Nếu đang edit, thay thế point cũ
      if (
        typeof this.editingIndex === "number" &&
        this.editingIndex >= 0 &&
        this.editingIndex < this.snapPoints.length
      ) {
        const oldPoint = this.snapPoints[this.editingIndex];
        // Xóa template cũ nếu có
        if (oldPoint.selections && Array.isArray(oldPoint.selections)) {
          oldPoint.selections.forEach((sel) => {
            if (sel.templateImagePath && fs.existsSync(sel.templateImagePath)) {
              try {
                fs.unlinkSync(sel.templateImagePath);
              } catch (e) {
                console.warn("Không thể xóa template cũ:", e);
              }
            }
            if (sel && sel.templateImagePath) {
              this.invalidateSharpCache(sel.templateImagePath);
            }
          });
        } else if (
          oldPoint.templateImagePath &&
          fs.existsSync(oldPoint.templateImagePath)
        ) {
          // Backward compatibility
          try {
            fs.unlinkSync(oldPoint.templateImagePath);
          } catch (e) {
            console.warn("Không thể xóa template cũ:", e);
          }
          this.invalidateSharpCache(oldPoint.templateImagePath);
        }
        // Thay thế point cũ bằng point mới
        this.snapPoints.splice(this.editingIndex, 1, ...newPoints);
        this.editingIndex = undefined;
        this.editingPoint = undefined;
      } else {
        // Thêm vào danh sách điểm
        this.snapPoints.push(...newPoints);
      }
      this.persistSnapConfig();

      // Đóng cửa sổ selector
      if (this.selectorWindow) {
        this.selectorWindow.close();
      }

      // Thông báo về main window
      if (this.mainWindow) {
        this.mainWindow.webContents.send("snap-selector-saved", {
          success: true,
          points: newPoints,
        });
      }
    };

    processPoints().catch((error) => {
      console.error("[SnapClickController] Lỗi khi xử lý lưu điểm:", error);
      if (this.mainWindow) {
        this.mainWindow.webContents.send("snap-selector-saved", {
          success: false,
          error: "Lỗi khi lưu điểm: " + error.message,
        });
      }
    });
  }

  saveSnapPoint(point) {
    if (
      !point ||
      typeof point.offsetX !== "number" ||
      typeof point.offsetY !== "number"
    ) {
      return { success: false, error: "Điểm không hợp lệ." };
    }

    const snapPoint = {
      offsetX: Math.round(point.offsetX),
      offsetY: Math.round(point.offsetY),
      imagePath: point.imagePath || "",
      selection: point.selection || null,
      id: Date.now() + Math.floor(Math.random() * 1000),
    };

    this.snapPoints.push(snapPoint);
    this.persistSnapConfig();

    return { success: true, point: snapPoint };
  }

  deleteSnapPoint(index) {
    if (
      typeof index !== "number" ||
      index < 0 ||
      index >= this.snapPoints.length
    ) {
      return { success: false, error: "Chỉ số không hợp lệ." };
    }

    const deletedPoint = this.snapPoints.splice(index, 1)[0];

    // Xóa file ảnh nếu có
    if (deletedPoint.imagePath && fs.existsSync(deletedPoint.imagePath)) {
      try {
        fs.unlinkSync(deletedPoint.imagePath);
      } catch (e) {
        console.warn("Không thể xóa file ảnh:", e);
      }
    }

    // Xóa file template nếu có
    if (
      deletedPoint.templateImagePath &&
      fs.existsSync(deletedPoint.templateImagePath)
    ) {
      try {
        fs.unlinkSync(deletedPoint.templateImagePath);
      } catch (e) {
        console.warn("Không thể xóa file template:", e);
      }
    }
    if (deletedPoint.templateImagePath) {
      this.invalidateSharpCache(deletedPoint.templateImagePath);
    }

    if (deletedPoint.selections && Array.isArray(deletedPoint.selections)) {
      deletedPoint.selections.forEach((sel) => {
        if (sel?.templateImagePath && fs.existsSync(sel.templateImagePath)) {
          try {
            fs.unlinkSync(sel.templateImagePath);
          } catch (e) {
            console.warn("Không thể xóa file template:", e);
          }
        }
        if (sel?.templateImagePath) {
          this.invalidateSharpCache(sel.templateImagePath);
        }
      });
    }

    this.persistSnapConfig();

    return { success: true, points: this.snapPoints };
  }

  getSnapPoint(index) {
    if (
      typeof index !== "number" ||
      index < 0 ||
      index >= this.snapPoints.length
    ) {
      return { success: false, error: "Chỉ số không hợp lệ." };
    }

    return { success: true, point: this.snapPoints[index] };
  }

  editSnapPoint(index, pointData) {
    if (
      typeof index !== "number" ||
      index < 0 ||
      index >= this.snapPoints.length
    ) {
      return { success: false, error: "Chỉ số không hợp lệ." };
    }

    if (
      !pointData ||
      typeof pointData.offsetX !== "number" ||
      typeof pointData.offsetY !== "number"
    ) {
      return { success: false, error: "Dữ liệu điểm không hợp lệ." };
    }

    const point = this.snapPoints[index];
    point.offsetX = Math.round(pointData.offsetX);
    point.offsetY = Math.round(pointData.offsetY);

    // Cập nhật selection và template nếu có
    if (pointData.selection) {
      point.selection = pointData.selection;
    }

    if (pointData.templateImagePath) {
      // Xóa template cũ nếu có
      if (point.templateImagePath && fs.existsSync(point.templateImagePath)) {
        try {
          fs.unlinkSync(point.templateImagePath);
        } catch (e) {
          console.warn("Không thể xóa template cũ:", e);
        }
      }
      point.templateImagePath = pointData.templateImagePath;
    }

    this.persistSnapConfig();

    return { success: true, point: point };
  }

  loadSnapConfig() {
    try {
      if (fs.existsSync(this.snapConfigPath)) {
        const raw = fs.readFileSync(this.snapConfigPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.points)) {
          this.snapPoints = parsed.points;
        }
      }
    } catch (error) {
      console.warn("Không thể đọc cấu hình snap click:", error.message);
    }
    return {
      points: this.snapPoints,
    };
  }

  persistSnapConfig() {
    try {
      fs.writeFileSync(
        this.snapConfigPath,
        JSON.stringify(
          {
            points: this.snapPoints,
          },
          null,
          2
        ),
        "utf8"
      );
    } catch (error) {
      console.error("Không thể lưu cấu hình snap click:", error.message);
    }
  }

  async startSnapClick(config = {}) {
    if (!this.snapClickTarget || !this.snapClickTarget.handle) {
      return {
        success: false,
        error: "Vui lòng chọn ứng dụng trước khi chạy snap click.",
      };
    }

    if (this.snapPoints.length === 0) {
      return { success: false, error: "Chưa có điểm snap nào." };
    }

    const engine = config && config.engine === "legacy" ? "legacy" : "sharp";
    this.snapEngine = engine;

    if (engine === "legacy") {
      return await this.startSnapClickLegacy(config);
    }

    return await this.startSharpSnapClick(config);
  }

  async startSnapClickLegacy(config = {}) {
    if (!this.snapClickTarget || !this.snapClickTarget.handle) {
      return {
        success: false,
        error: "Vui lòng chọn ứng dụng trước khi chạy snap click.",
      };
    }

    if (this.snapPoints.length === 0) {
      return { success: false, error: "Chưa có điểm snap nào." };
    }

    const interval = Math.max(500, Number(config.interval) || 2000);
    const handleValue = this.snapClickTarget.handle;
    // Gửi cả thông tin selections (mảng) cho mỗi điểm
    const pointsData = this.snapPoints.map((p) => {
      // Backward compatibility: nếu có selection đơn, chuyển thành mảng
      let selections = [];
      if (p.selections && Array.isArray(p.selections)) {
        selections = p.selections;
      } else if (p.selection && p.templateImagePath) {
        selections = [
          { selection: p.selection, templateImagePath: p.templateImagePath },
        ];
      }
      return {
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        selections: selections,
      };
    });
    const pointsJson = JSON.stringify(pointsData)
      .replace(/"/g, '`"')
      .replace(/\$/g, "`$");

    const scriptContent = this.buildSnapClickScript(
      handleValue,
      interval,
      pointsJson
    );
    const scriptPath = this.scriptHelper.writeTempScript(
      "snapClickRunner",
      scriptContent
    );
    this.snapClickScriptPath = scriptPath;

    return await new Promise((resolve) => {
      this.snapClickProcess = require("child_process").spawn(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
        {
          cwd: this.appDir,
          windowsHide: true,
        }
      );

      this.snapClickProcess.stdout.on("data", (data) => {
        const message = data.toString().trim();
        if (!message) return;

        // Log tất cả output để debug
        const lines = message.split("\n").filter((l) => l.trim());
        lines.forEach((line) => {
          if (line.includes("ERROR:") || line.includes("FATAL_ERROR")) {
            console.error("[SnapClickController] Script error:", line);
          } else if (
            line.includes("Handle:") ||
            line.includes("Loaded") ||
            line.includes("Starting") ||
            line.includes("Snap dir:")
          ) {
            console.log("[SnapClickController] Script info:", line);
          }
        });

        if (message === "TARGET_LOST") {
          this.snapClickTarget = null;
          if (this.mainWindow) {
            this.mainWindow.webContents.send("snap-click-status", {
              running: false,
              message: "Cửa sổ mục tiêu đã đóng hoặc không còn hợp lệ.",
              type: "error",
              targetLost: true,
            });
          }
          this.stopSnapClick({ silent: true });
        } else if (message === "NOPTS") {
          console.warn("[SnapClickController] No points to process");
          this.stopSnapClick({ silent: true });
        }
      });

      this.snapClickProcess.stderr.on("data", (data) => {
        const errorMsg = data.toString();
        console.error("[SnapClickController] Snap click stderr:", errorMsg);

        // Nếu có lỗi nghiêm trọng, thông báo cho user
        if (
          errorMsg.includes("FATAL_ERROR") ||
          errorMsg.includes("Cannot compile") ||
          errorMsg.includes("Cannot load")
        ) {
          if (this.mainWindow) {
            this.mainWindow.webContents.send("snap-click-status", {
              running: false,
              message: "Lỗi nghiêm trọng: " + errorMsg.split("\n")[0],
              type: "error",
            });
          }
          this.stopSnapClick({ silent: true });
        }
      });

      this.snapClickProcess.on("exit", (code, signal) => {
        console.log("[SnapClickController] Snap click process exited:", {
          code,
          signal,
        });
        this.cleanupSnapClickProcess();
        if (this.mainWindow) {
          let message = "Snap click đã dừng.";
          if (code !== 0 && code !== null) {
            message = `Snap click dừng đột ngột (code: ${code}${
              signal ? ", signal: " + signal : ""
            }).`;
          }
          this.mainWindow.webContents.send("snap-click-status", {
            running: false,
            message: message,
            type: code === 0 ? "success" : "error",
          });
        }
      });

      this.snapClickProcess.on("error", (error) => {
        console.error("[SnapClickController] Snap click process error:", error);
        if (this.mainWindow) {
          this.mainWindow.webContents.send("snap-click-status", {
            running: false,
            message: "Lỗi khi khởi động snap click: " + error.message,
            type: "error",
          });
        }
        this.cleanupSnapClickProcess();
      });

      resolve({ success: true });
    });
  }

  async startSharpSnapClick(config = {}) {
    if (!this.snapClickTarget || !this.snapClickTarget.handle) {
      return {
        success: false,
        error: "Vui lòng chọn ứng dụng trước khi chạy snap click.",
      };
    }

    if (this.snapPoints.length === 0) {
      return { success: false, error: "Chưa có điểm snap nào." };
    }

    if (this.snapClickProcess) {
      const prevEngine = this.snapEngine;
      this.snapEngine = "legacy";
      await this.stopSnapClick({ silent: true });
      this.snapEngine = prevEngine;
    }

    const interval = Math.max(500, Number(config.interval) || 2000);
    const similarityThreshold =
      typeof config.similarityThreshold === "number"
        ? Math.max(0, Math.min(1, config.similarityThreshold))
        : 0.85;

    await this.stopSharpSnapClick({ silent: true });

    this.sharpLoopConfig = {
      interval,
      similarityThreshold,
    };
    this.sharpLoopActive = true;

    this.runSharpLoop().catch((error) => {
      console.error("[SnapClickController] Sharp loop failure:", error);
    });

    if (this.mainWindow) {
      this.mainWindow.webContents.send("snap-click-status", {
        running: true,
        message: "Snap click đang chạy bằng engine Sharp.",
        type: "success",
      });
    }

    return { success: true, engine: "sharp" };
  }

  async stopSharpSnapClick(options = {}) {
    const silent = options && options.silent;
    this.sharpLoopActive = false;
    if (this.sharpLoopTimeout) {
      clearTimeout(this.sharpLoopTimeout);
      this.sharpLoopTimeout = null;
    }
    this.sharpLoopConfig = null;

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send("snap-click-status", {
        running: false,
        message: "Snap click Sharp đã dừng.",
        type: "success",
      });
    }
  }

  async runSharpLoop() {
    if (!this.sharpLoopActive) {
      return;
    }

    if (!this.snapClickTarget || !this.snapClickTarget.handle) {
      console.warn(
        "[SnapClickController] Không còn target cho Sharp loop, dừng."
      );
      await this.stopSharpSnapClick();
      return;
    }

    const handleValue = this.snapClickTarget.handle;

    try {
      const capture = await this.captureWindowSnapshot(handleValue);
      if (!capture) {
        throw new Error("Không chụp được cửa sổ mục tiêu.");
      }

      const matches = [];
      for (const point of this.snapPoints) {
        try {
          const shouldClick = await this.evaluatePointWithSharp(point, capture);
          if (shouldClick) {
            matches.push({
              offsetX: Math.round(point.offsetX),
              offsetY: Math.round(point.offsetY),
            });
          }
        } catch (error) {
          console.error(
            "[SnapClickController] Lỗi khi đánh giá point với Sharp:",
            error
          );
        }
      }

      if (matches.length > 0) {
        await this.dispatchSharpClicks(handleValue, matches);
      }
    } catch (error) {
      console.error(
        "[SnapClickController] Sharp loop error:",
        error.message || error
      );
    } finally {
      if (this.sharpLoopActive) {
        const delay = this.sharpLoopConfig?.interval || 500; // OPTIMIZATION: Giảm từ 2000ms xuống 500ms
        this.sharpLoopTimeout = setTimeout(() => {
          this.runSharpLoop().catch((err) => {
            console.error(
              "[SnapClickController] Sharp loop scheduling error:",
              err
            );
          });
        }, delay);
      }
    }
  }

  async evaluatePointWithSharp(point, capture) {
    const selections = this.getPointSelections(point);
    if (selections.length === 0) {
      return true;
    }

    const threshold = this.sharpLoopConfig?.similarityThreshold ?? 0.85;

    for (const selectionInfo of selections) {
      const similarity = await this.compareSelectionWithSharp(
        selectionInfo,
        capture
      );
      if (similarity >= threshold) {
        return true;
      }
    }

    return false;
  }

  getPointSelections(point) {
    if (!point) {
      return [];
    }

    if (Array.isArray(point.selections) && point.selections.length > 0) {
      return point.selections;
    }

    if (point.selection && point.templateImagePath) {
      return [
        {
          selection: point.selection,
          templateImagePath: point.templateImagePath,
        },
      ];
    }

    return [];
  }

  async compareSelectionWithSharp(selectionInfo, capture) {
    if (
      !selectionInfo ||
      !selectionInfo.selection ||
      !selectionInfo.templateImagePath
    ) {
      return 0;
    }

    const template = await this.loadSharpTemplate(
      selectionInfo.templateImagePath
    );
    if (!template) {
      return 0;
    }

    const rect = this.normalizeSelectionRect(selectionInfo.selection, {
      width: capture.width,
      height: capture.height,
    });

    if (!rect) {
      return 0;
    }

    let pipeline = sharp(capture.buffer).extract(rect).grayscale().normalize();

    if (rect.width !== template.width || rect.height !== template.height) {
      pipeline = pipeline.resize(template.width, template.height, {
        fit: "fill",
      });
    }

    const { data } = await pipeline.raw().toBuffer({ resolveWithObject: true });
    return this.calculateSharpSimilarity(data, template.data);
  }

  calculateSharpSimilarity(bufferA, bufferB, threshold = 0.7) {
    if (!bufferA || !bufferB || bufferA.length === 0 || bufferB.length === 0) {
      return 0;
    }

    let a = bufferA;
    let b = bufferB;

    if (bufferA.length !== bufferB.length) {
      const minLength = Math.min(bufferA.length, bufferB.length);
      if (minLength === 0) {
        return 0;
      }
      a = bufferA.subarray(0, minLength);
      b = bufferB.subarray(0, minLength);
    }

    const maxDiff = a.length * 255;
    // OPTIMIZATION: Early exit - tính ngưỡng diff tối đa cho phép
    const maxAllowedDiff = maxDiff * (1 - threshold);

    let diff = 0;
    // OPTIMIZATION: Sample mỗi 2 pixels để tăng tốc (stride = 2)
    // Với ảnh lớn, sampling giảm 50% thời gian mà vẫn giữ độ chính xác
    const stride = a.length > 10000 ? 2 : 1;

    for (let i = 0; i < a.length; i += stride) {
      diff += Math.abs(a[i] - b[i]);

      // OPTIMIZATION: Early exit - dừng ngay khi diff vượt ngưỡng
      if (diff > maxAllowedDiff) {
        return 0; // Chắc chắn không match, không cần so sánh tiếp
      }
    }

    // Scale diff nếu đã dùng sampling
    if (stride > 1) {
      diff = diff * stride;
    }

    return maxDiff === 0 ? 0 : 1 - diff / maxDiff;
  }

  async loadSharpTemplate(templatePath) {
    if (!templatePath || !fs.existsSync(templatePath)) {
      return null;
    }

    if (this.sharpTemplateCache.has(templatePath)) {
      return this.sharpTemplateCache.get(templatePath);
    }

    try {
      const { data, info } = await sharp(templatePath)
        .grayscale()
        .normalize()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const cache = {
        data,
        width: info.width,
        height: info.height,
        channels: info.channels,
      };

      this.sharpTemplateCache.set(templatePath, cache);
      return cache;
    } catch (error) {
      console.error(
        "[SnapClickController] Không thể load template Sharp:",
        error.message || error
      );
      return null;
    }
  }

  async captureWindowSnapshot(handleValue) {
    const capturePath = path.join(
      this.snapDir,
      `sharp-capture-${Date.now()}-${Math.floor(Math.random() * 10000)}.png`
    );
    const escapedCapturePath = capturePath
      .replace(/\\/g, "\\\\")
      .replace(/\$/g, "`$")
      .replace(/"/g, '`"');

    const scriptContent = `Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapSharpCapture {
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
$rect = New-Object SnapSharpCapture+RECT
if (-not [SnapSharpCapture]::GetWindowRect($handle, [ref]$rect)) {
  Write-Output "ERROR:RECT"
  exit 1
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Write-Output "ERROR:SIZE"
  exit 1
}
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()
try {
  if (-not [SnapSharpCapture]::PrintWindow($handle, $hdc, 0)) {
    Write-Output "ERROR:CAPTURE"
    exit 1
  }
} finally {
  $graphics.ReleaseHdc($hdc)
  $graphics.Dispose()
}
$ms = New-Object System.IO.MemoryStream
$bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
$bytes = $ms.ToArray()
$ms.Dispose()
$imagePath = "${escapedCapturePath}"
[System.IO.File]::WriteAllBytes($imagePath, $bytes)
$result = [PSCustomObject]@{
  width = $width
  height = $height
  path = $imagePath
} | ConvertTo-Json -Compress
Write-Output $result`;

    const scriptPath = this.scriptHelper.writeTempScript(
      "snapSharpCapture",
      scriptContent
    );

    return await new Promise((resolve) => {
      exec(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        (error, stdout, stderr) => {
          this.scriptHelper.cleanupTempScript(scriptPath);

          const cleanupCapture = () => {
            if (fs.existsSync(capturePath)) {
              try {
                fs.unlinkSync(capturePath);
              } catch (cleanupError) {
                console.warn(
                  "[SnapClickController] Không thể xoá capture tạm:",
                  cleanupError.message
                );
              }
            }
          };

          if (error) {
            console.error(
              "[SnapClickController] Lỗi capture Sharp:",
              stderr || error.message
            );
            cleanupCapture();
            resolve(null);
            return;
          }

          const output = stdout ? stdout.toString().trim() : "";
          if (!output || output.startsWith("ERROR")) {
            cleanupCapture();
            resolve(null);
            return;
          }

          try {
            const parsed = JSON.parse(output);
            if (!parsed || !parsed.path || !fs.existsSync(parsed.path)) {
              cleanupCapture();
              resolve(null);
              return;
            }
            const buffer = fs.readFileSync(parsed.path);
            resolve({
              buffer,
              width: parsed.width,
              height: parsed.height,
            });
          } catch (e) {
            console.error(
              "[SnapClickController] Không parse được dữ liệu capture Sharp:",
              e
            );
            resolve(null);
          } finally {
            cleanupCapture();
          }
        }
      );
    });
  }

  async dispatchSharpClicks(handleValue, points) {
    if (!points || points.length === 0) {
      return;
    }

    const payload = JSON.stringify(
      points.map((p) => ({
        offsetX: Math.round(p.offsetX),
        offsetY: Math.round(p.offsetY),
      }))
    )
      .replace(/"/g, '`"')
      .replace(/\$/g, "`$");

    const scriptContent = `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SnapSharpClicker {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
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
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$points = ConvertFrom-Json "${payload}"
if (-not $points) {
  exit 0
}
$rect = New-Object SnapSharpClicker+RECT
if (-not [SnapSharpClicker]::GetWindowRect($handle, [ref]$rect)) {
  Write-Output "ERROR:RECT"
  exit 1
}
foreach ($point in $points) {
  $screenX = [int]($rect.Left + $point.offsetX)
  $screenY = [int]($rect.Top + $point.offsetY)
  $clientPoint = New-Object SnapSharpClicker+POINT
  $clientPoint.X = $screenX
  $clientPoint.Y = $screenY
  [SnapSharpClicker]::ScreenToClient($handle, [ref]$clientPoint) | Out-Null
  if ($clientPoint.X -lt 0 -or $clientPoint.Y -lt 0) {
    continue
  }
  $lParam = ($clientPoint.Y -band 0xFFFF) -shl 16 -bor ($clientPoint.X -band 0xFFFF)
  [SnapSharpClicker]::PostMessage($handle, $WM_LBUTTONDOWN, [IntPtr]1, [IntPtr]$lParam) | Out-Null
  Start-Sleep -Milliseconds 40
  [SnapSharpClicker]::PostMessage($handle, $WM_LBUTTONUP, [IntPtr]0, [IntPtr]$lParam) | Out-Null
  Start-Sleep -Milliseconds 80
}
Write-Output "DONE"`;

    const scriptPath = this.scriptHelper.writeTempScript(
      "snapSharpClicker",
      scriptContent
    );

    await new Promise((resolve) => {
      exec(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}"`,
        (error, stdout, stderr) => {
          this.scriptHelper.cleanupTempScript(scriptPath);
          if (error) {
            console.error(
              "[SnapClickController] Lỗi gửi click Sharp:",
              stderr || error.message
            );
          }
          resolve();
        }
      );
    });
  }

  buildSnapClickScript(handleValue, interval, pointsJson) {
    const snapDirEscaped = this.snapDir
      .replace(/\\/g, "\\\\")
      .replace(/\$/g, "`$")
      .replace(/"/g, '`"');

    // Escape C# code để dùng trong PowerShell here-string
    const csharpCode = `using System;
using System.Runtime.InteropServices;
using System.Drawing;
public class SnapClicker {
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);
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
  public static double CompareBitmaps(Bitmap source, Bitmap template, int threshold = 10) {
    if (source.Width < template.Width || source.Height < template.Height) {
      return 0.0;
    }
    int matchCount = 0;
    int totalPixels = template.Width * template.Height;
    for (int y = 0; y < template.Height; y++) {
      for (int x = 0; x < template.Width; x++) {
        Color sourceColor = source.GetPixel(x, y);
        Color templateColor = template.GetPixel(x, y);
        int diffR = Math.Abs(sourceColor.R - templateColor.R);
        int diffG = Math.Abs(sourceColor.G - templateColor.G);
        int diffB = Math.Abs(sourceColor.B - templateColor.B);
        if (diffR <= threshold && diffG <= threshold && diffB <= threshold) {
          matchCount++;
        }
      }
    }
    return (double)matchCount / totalPixels;
  }
}`.replace(/\$/g, "`$");

    return `try {
  Add-Type -AssemblyName System.Drawing -ErrorAction Stop
} catch {
  Write-Error "ERROR: Cannot load System.Drawing: $_"
  exit 1
}
$csharpCode = @'
${csharpCode}
'@
try {
  Add-Type -TypeDefinition $csharpCode -ReferencedAssemblies System.Drawing -ErrorAction Stop
} catch {
  Write-Error "ERROR: Cannot compile SnapClicker type: $_"
  exit 1
}
if (-not ([System.Management.Automation.PSTypeName]"SnapClicker").Type) {
  Write-Error "ERROR: SnapClicker type not found after compilation"
  exit 1
}
Write-Host "SnapClicker type loaded successfully"
function FindTemplateInWindow {
  param($handle, $templatePath, $searchRect)
  try {
    if (-not (Test-Path $templatePath)) {
      return $false
    }
    $rect = New-Object SnapClicker+RECT
    if (-not [SnapClicker]::GetWindowRect($handle, [ref]$rect)) {
      return $false
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      return $false
    }
    $bitmap = $null
    $graphics = $null
    $template = $null
    $templateBitmap = $null
    $cropped = $null
    try {
      $bitmap = New-Object System.Drawing.Bitmap($width, $height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $hdc = $graphics.GetHdc()
      try {
        $result = [SnapClicker]::PrintWindow($handle, $hdc, 0)
        if (-not $result) {
          return $false
        }
      } finally {
        $graphics.ReleaseHdc($hdc)
        $graphics.Dispose()
        $graphics = $null
      }
      $template = [System.Drawing.Image]::FromFile($templatePath)
      $templateBitmap = New-Object System.Drawing.Bitmap($template)
      
      # Lấy tọa độ từ searchRect (PowerShell có thể parse JSON với property name khác nhau)
      $searchX = 0
      $searchY = 0
      $searchWidth = 0
      $searchHeight = 0
      
      # Thử nhiều cách truy cập property (PowerShell JSON parsing)
      if ($searchRect.x -ne $null) {
        $searchX = [int]$searchRect.x
        $searchY = [int]$searchRect.y
        $searchWidth = [int]$searchRect.width
        $searchHeight = [int]$searchRect.height
      } elseif ($searchRect.X -ne $null) {
        $searchX = [int]$searchRect.X
        $searchY = [int]$searchRect.Y
        $searchWidth = [int]$searchRect.Width
        $searchHeight = [int]$searchRect.Height
      } else {
        # Thử convert sang hashtable
        $rectHash = $searchRect | ConvertTo-Json | ConvertFrom-Json
        if ($rectHash.x) {
          $searchX = [int]$rectHash.x
          $searchY = [int]$rectHash.y
          $searchWidth = [int]$rectHash.width
          $searchHeight = [int]$rectHash.height
        } else {
          return $false
        }
      }
      
      # Đảm bảo tọa độ hợp lệ
      $searchX = [Math]::Max(0, $searchX)
      $searchY = [Math]::Max(0, $searchY)
      $searchWidth = [Math]::Min($searchWidth, $bitmap.Width - $searchX)
      $searchHeight = [Math]::Min($searchHeight, $bitmap.Height - $searchY)
      
      # Kiểm tra kích thước
      if ($searchWidth -lt $templateBitmap.Width -or $searchHeight -lt $templateBitmap.Height) {
        return $false
      }
      
      # Crop vùng từ bitmap window theo selection
      $cropRect = New-Object System.Drawing.Rectangle($searchX, $searchY, $searchWidth, $searchHeight)
      $cropped = $bitmap.Clone($cropRect, $bitmap.PixelFormat)
      
      # So sánh template với vùng đã crop
      $similarity = [SnapClicker]::CompareBitmaps($cropped, $templateBitmap, 15)
      return $similarity -ge 0.85
    } finally {
      if ($cropped) { $cropped.Dispose() }
      if ($templateBitmap) { $templateBitmap.Dispose() }
      if ($template) { $template.Dispose() }
      if ($bitmap) { $bitmap.Dispose() }
    }
  } catch {
    return $false
  }
}
$ErrorActionPreference = "Continue"
try {
  $handle = [IntPtr]${handleValue}
  Write-Host "Handle: $handle"
  
  $pointsJsonStr = "${pointsJson}"
  Write-Host "Parsing points JSON (length: $($pointsJsonStr.Length))"
  $points = ConvertFrom-Json $pointsJsonStr
  if (-not $points) {
    Write-Error "ERROR: Cannot parse points JSON"
    exit 1
  }
  # ConvertFrom-Json có thể trả về object đơn nếu chỉ có 1 item, cần convert thành array
  if ($points -isnot [Array]) {
    $points = @($points)
  }
  if ($points.Count -eq 0) {
    Write-Output "NOPTS"
    exit 0
  }
  Write-Host "Loaded $($points.Count) points"
  # Debug: log structure của điểm đầu tiên
  if ($points.Count -gt 0) {
    $firstPoint = $points[0]
    Write-Host "First point structure: offsetX=$($firstPoint.offsetX), offsetY=$($firstPoint.offsetY)"
    if ($firstPoint.selections) {
      Write-Host "  Has $($firstPoint.selections.Count) selections"
      if ($firstPoint.selections.Count -gt 0) {
        $firstSel = $firstPoint.selections[0]
        Write-Host "  First selection: templatePath=$($firstSel.templateImagePath), hasSelection=$($firstSel.selection -ne $null)"
        if ($firstSel.selection) {
          Write-Host "    Selection: x=$($firstSel.selection.x), y=$($firstSel.selection.y), w=$($firstSel.selection.width), h=$($firstSel.selection.height)"
        }
      }
    } elseif ($firstPoint.templateImagePath) {
      Write-Host "  Has legacy templateImagePath and selection"
    }
  }
  
  $loopInterval = ${interval}
  $WM_LBUTTONDOWN = 0x0201
  $WM_LBUTTONUP = 0x0202
  $snapDir = "${snapDirEscaped}"
  Write-Host "Snap dir: $snapDir"
  Write-Host "Interval: $loopInterval ms"
  Write-Host "Starting main loop..."
} catch {
  Write-Error "ERROR: Initialization failed: $_"
  exit 1
}
try {
  while ($true) {
    try {
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
        try {
          $shouldClick = $false
          # Kiểm tra tất cả selections của điểm này (chỉ cần 1 match là đủ)
          if ($point.selections -and ($point.selections.Count -gt 0)) {
            foreach ($sel in $point.selections) {
              if ($sel.templateImagePath -and $sel.selection) {
                $templatePath = Join-Path $snapDir (Split-Path $sel.templateImagePath -Leaf)
                if (Test-Path $templatePath) {
                  # Đảm bảo selection là object hợp lệ
                  $selectionObj = $sel.selection
                  if ($selectionObj) {
                    $shouldClick = FindTemplateInWindow $handle $templatePath $selectionObj
                    if ($shouldClick) {
                      break  # Đã tìm thấy match, không cần kiểm tra tiếp
                    }
                  }
                }
              }
            }
          } elseif ($point.templateImagePath -and $point.selection) {
            # Backward compatibility: nếu có selection đơn
            $templatePath = Join-Path $snapDir (Split-Path $point.templateImagePath -Leaf)
            if (Test-Path $templatePath) {
              $selectionObj = $point.selection
              if ($selectionObj) {
                $shouldClick = FindTemplateInWindow $handle $templatePath $selectionObj
              }
            }
          }
          if (-not $shouldClick) {
            continue
          }
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
        } catch {
          # Bỏ qua lỗi ở từng point, tiếp tục với point tiếp theo
          continue
        }
      }
      Start-Sleep -Milliseconds $loopInterval
    } catch {
      # Nếu có lỗi trong vòng lặp chính, đợi một chút rồi tiếp tục
      Start-Sleep -Milliseconds 500
      continue
    }
  }
} catch {
  Write-Output "FATAL_ERROR: $_"
  exit 1
}`;
  }

  async stopSnapClick(options = {}) {
    if (this.snapEngine === "sharp") {
      await this.stopSharpSnapClick(options);
      return { success: true };
    }

    const silent = options && options.silent;
    if (this.snapClickProcess) {
      try {
        this.snapClickProcess.kill();
      } catch (error) {
        console.error("Không thể dừng snap click:", error);
      }
    }

    this.cleanupSnapClickProcess();

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send("snap-click-status", {
        running: false,
        message: "Snap click đã dừng.",
        type: "success",
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

  loadSnapProfilesFromDisk() {
    try {
      if (fs.existsSync(this.snapProfilesPath)) {
        const raw = fs.readFileSync(this.snapProfilesPath, "utf8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return parsed.filter(
            (p) => p && p.name && Array.isArray(p.points) && p.points.length > 0
          );
        }
      }
    } catch (error) {
      console.warn("Không thể đọc danh sách kịch bản snap:", error.message);
    }
    return [];
  }

  persistSnapProfiles() {
    try {
      fs.writeFileSync(
        this.snapProfilesPath,
        JSON.stringify(this.snapProfiles, null, 2),
        "utf8"
      );
    } catch (error) {
      console.error("Không thể lưu danh sách kịch bản snap:", error.message);
    }
  }

  saveSnapProfile(payload = {}) {
    const name = (payload.name || "").trim();
    if (!name) {
      return { success: false, error: "Tên kịch bản không hợp lệ." };
    }

    if (this.snapPoints.length === 0) {
      return { success: false, error: "Chưa có điểm snap nào để lưu." };
    }

    const interval = Math.max(500, Number(payload.interval) || 2000);

    // Lưu profile với tất cả thông tin points (bao gồm selections, imagePath)
    const profile = {
      name,
      interval,
      points: this.snapPoints.map((p) => {
        // Chuyển đổi selections thành format mới
        let selections = [];
        if (p.selections && Array.isArray(p.selections)) {
          selections = p.selections;
        } else if (p.selection && p.templateImagePath) {
          selections = [
            { selection: p.selection, templateImagePath: p.templateImagePath },
          ];
        }
        return {
          offsetX: p.offsetX,
          offsetY: p.offsetY,
          selections: selections,
          imagePath: p.imagePath || null,
        };
      }),
      targetWindow: this.snapClickTarget
        ? {
            pid: this.snapClickTarget.pid,
            title: this.snapClickTarget.title,
            handle: this.snapClickTarget.handle,
          }
        : null,
      createdAt: new Date().toISOString(),
    };

    const existingIndex = this.snapProfiles.findIndex(
      (item) => item.name.toLowerCase() === name.toLowerCase()
    );

    if (existingIndex >= 0) {
      this.snapProfiles[existingIndex] = profile;
    } else {
      this.snapProfiles.push(profile);
    }

    this.persistSnapProfiles();
    return { success: true, profiles: this.snapProfiles };
  }

  loadSnapProfile(profileName) {
    if (!profileName) {
      return { success: false, error: "Thiếu tên kịch bản." };
    }

    const profile = this.snapProfiles.find(
      (p) => p.name.toLowerCase() === String(profileName).toLowerCase()
    );

    if (!profile) {
      return { success: false, error: "Không tìm thấy kịch bản." };
    }

    // Load points vào snapPoints
    this.snapPoints = profile.points.map((p) => ({
      ...p,
      id: Date.now() + Math.random(), // Tạo ID mới
    }));

    // Load target window nếu có
    if (profile.targetWindow) {
      this.snapClickTarget = profile.targetWindow;
    }

    // Load interval vào config
    this.persistSnapConfig();

    return { success: true, profile };
  }

  deleteSnapProfile(profileName) {
    if (!profileName) {
      return { success: false, error: "Thiếu tên kịch bản." };
    }

    const before = this.snapProfiles.length;
    this.snapProfiles = this.snapProfiles.filter(
      (profile) =>
        profile.name.toLowerCase() !== String(profileName).toLowerCase()
    );

    if (this.snapProfiles.length === before) {
      return { success: false, error: "Không tìm thấy kịch bản cần xóa." };
    }

    this.persistSnapProfiles();
    return { success: true, profiles: this.snapProfiles };
  }

  async startSnapClickForItem(itemId, config = {}) {
    if (!config.targetWindow || !config.targetWindow.handle) {
      return { success: false, error: "Thiếu thông tin cửa sổ đích." };
    }

    const points = Array.isArray(config.points) ? config.points : [];
    if (points.length === 0) {
      return { success: false, error: "Chưa có điểm snap nào." };
    }

    const interval = Math.max(500, Number(config.interval) || 2000);
    const handleValue = config.targetWindow.handle;

    // Gửi cả thông tin selections (mảng) cho mỗi điểm
    const pointsData = points.map((p) => {
      // Backward compatibility: nếu có selection đơn, chuyển thành mảng
      let selections = [];
      if (p.selections && Array.isArray(p.selections)) {
        selections = p.selections;
      } else if (p.selection && p.templateImagePath) {
        selections = [
          { selection: p.selection, templateImagePath: p.templateImagePath },
        ];
      }
      return {
        offsetX: p.offsetX,
        offsetY: p.offsetY,
        selections: selections,
      };
    });
    const pointsJson = JSON.stringify(pointsData)
      .replace(/"/g, '`"')
      .replace(/\$/g, "`$");

    const scriptContent = this.buildSnapClickScript(
      handleValue,
      interval,
      pointsJson
    );
    const scriptPath = this.scriptHelper.writeTempScript(
      `snapClickRunner-${itemId}`,
      scriptContent
    );

    // Dừng snap cũ của item này nếu có
    await this.stopSnapClickForItem(itemId, { silent: true });

    return await new Promise((resolve) => {
      const process = require("child_process").spawn(
        "powershell",
        ["-ExecutionPolicy", "Bypass", "-File", scriptPath],
        {
          cwd: this.appDir,
          windowsHide: true,
        }
      );

      // Lưu thông tin process cho item này
      this.snapClickProcesses[itemId] = {
        process,
        scriptPath,
        targetWindow: config.targetWindow,
      };

      process.stdout.on("data", (data) => {
        const message = data.toString().trim();
        if (!message) return;

        if (message === "TARGET_LOST") {
          if (this.mainWindow) {
            this.mainWindow.webContents.send("snap-click-status-for-item", {
              itemId,
              running: false,
              message: "Cửa sổ mục tiêu đã đóng hoặc không còn hợp lệ.",
              type: "error",
              targetLost: true,
            });
          }
          this.stopSnapClickForItem(itemId, { silent: true });
        }
      });

      process.stderr.on("data", (data) => {
        console.error(
          `[SnapClickController] Snap click stderr cho item ${itemId}:`,
          data.toString()
        );
      });

      process.on("exit", (code, signal) => {
        this.cleanupSnapClickProcessForItem(itemId);
        if (this.mainWindow) {
          this.mainWindow.webContents.send("snap-click-status-for-item", {
            itemId,
            running: false,
            message:
              code === 0 ? "Snap click đã dừng." : "Snap click dừng đột ngột.",
            type: code === 0 ? "success" : "error",
          });
        }
      });

      resolve({ success: true });
    });
  }

  async stopSnapClickForItem(itemId, options = {}) {
    const silent = options && options.silent;
    const itemProcess = this.snapClickProcesses[itemId];

    if (itemProcess && itemProcess.process) {
      try {
        itemProcess.process.kill();
      } catch (error) {
        console.error(
          `[SnapClickController] Không thể dừng snap click cho item ${itemId}:`,
          error
        );
      }
    }

    this.cleanupSnapClickProcessForItem(itemId);

    if (!silent && this.mainWindow) {
      this.mainWindow.webContents.send("snap-click-status-for-item", {
        itemId,
        running: false,
        message: "Snap click đã dừng.",
        type: "success",
      });
    }

    return { success: true };
  }

  cleanupSnapClickProcessForItem(itemId) {
    const itemProcess = this.snapClickProcesses[itemId];
    if (itemProcess) {
      if (itemProcess.process) {
        itemProcess.process.removeAllListeners();
      }
      if (itemProcess.scriptPath) {
        this.scriptHelper.cleanupTempScript(itemProcess.scriptPath);
      }
      delete this.snapClickProcesses[itemId];
    }
  }

  normalizeSelectionRect(selection, bounds = null) {
    if (!selection) {
      return null;
    }

    const extractNumber = (obj, key) => {
      if (typeof obj[key] === "number") {
        return obj[key];
      }
      const upperKey = key.charAt(0).toUpperCase() + key.slice(1);
      if (typeof obj[upperKey] === "number") {
        return obj[upperKey];
      }
      return null;
    };

    const rawX = extractNumber(selection, "x");
    const rawY = extractNumber(selection, "y");
    const rawWidth = extractNumber(selection, "width");
    const rawHeight = extractNumber(selection, "height");

    if (
      rawX === null ||
      rawY === null ||
      rawWidth === null ||
      rawHeight === null
    ) {
      return null;
    }

    const maxWidth =
      typeof bounds?.width === "number"
        ? bounds.width
        : Number.POSITIVE_INFINITY;
    const maxHeight =
      typeof bounds?.height === "number"
        ? bounds.height
        : Number.POSITIVE_INFINITY;

    const left = Math.max(0, Math.floor(rawX));
    const top = Math.max(0, Math.floor(rawY));
    let width = Math.max(1, Math.floor(rawWidth));
    let height = Math.max(1, Math.floor(rawHeight));

    if (Number.isFinite(maxWidth)) {
      width = Math.min(width, Math.max(1, maxWidth - left));
    }
    if (Number.isFinite(maxHeight)) {
      height = Math.min(height, Math.max(1, maxHeight - top));
    }

    if (width <= 0 || height <= 0) {
      return null;
    }

    return { left, top, width, height };
  }

  invalidateSharpCache(templatePath) {
    if (!templatePath) {
      return;
    }
    this.sharpTemplateCache.delete(templatePath);
  }
}

module.exports = SnapClickController;
