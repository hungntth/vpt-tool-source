const path = require('path');
const fs = require('fs');

class ScriptHelper {
  constructor(appDir) {
    this.appDir = appDir;
  }

  writeTempScript(prefix, content) {
    const safePrefix = prefix || 'script';
    const fileName = `${safePrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`;
    const scriptPath = path.join(this.appDir, fileName);
    fs.writeFileSync(scriptPath, content, 'utf8');
    return scriptPath;
  }

  cleanupTempScript(scriptPath) {
    if (!scriptPath) return;
    try {
      if (fs.existsSync(scriptPath)) {
        fs.unlinkSync(scriptPath);
      }
    } catch (error) {
      console.warn('Không thể xóa script tạm:', scriptPath);
    }
  }
}

module.exports = ScriptHelper;

