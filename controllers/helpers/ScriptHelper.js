const path = require("path");
const fs = require("fs");
const { app } = require("electron");

class ScriptHelper {
  constructor(appDir) {
    this.appDir = appDir;
    // Sử dụng userData để lưu script tạm (writable khi build)
    this.tempDir = app.getPath("userData");
    // Tạo thư mục nếu chưa có
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  writeTempScript(prefix, content) {
    const safePrefix = prefix || "script";
    const fileName = `${safePrefix}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.ps1`;
    // Lưu vào userData thay vì appDir
    const scriptPath = path.join(this.tempDir, fileName);
    fs.writeFileSync(scriptPath, content, "utf8");
    return scriptPath;
  }

  cleanupTempScript(scriptPath) {
    if (!scriptPath) return;
    try {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    } catch (error) {
      console.warn("Không thể xóa script tạm:", scriptPath);
    }
  }
}

module.exports = ScriptHelper;
