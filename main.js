const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const DataModel = require('./models/DataModel');
const ItemController = require('./controllers/ItemController');

let mainWindow;
let itemController;

// Đường dẫn file lưu trữ dữ liệu
const DATA_FILE = path.join(__dirname, 'data.json');

// URL mặc định của game Flash
const FLASH_GAME_URL = 'https://main.vpt100.pages.dev/s/s100/GameLoader.swf?user=aacckjb2@gmail.com&pass=4fd6f740af148c3d0055eeedd8806c47';

function createWindow() {
  // Tạo cửa sổ chính với kích thước nhỏ hơn
  mainWindow = new BrowserWindow({
    width: 460,
    height: 460,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'assets/icons/icon.ico'),
    title: 'VPT TOOLS'
  });

  // Load file HTML từ views
  mainWindow.loadFile(path.join(__dirname, 'views', 'index.html'));

  // Khởi tạo Model và Controller
  const dataModel = new DataModel(DATA_FILE);
  itemController = new ItemController(dataModel, ipcMain, mainWindow, __dirname);

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Không kill flash process khi đóng ứng dụng để flash chạy độc lập
  });
}

// Khi ứng dụng sẵn sàng
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Đóng ứng dụng khi tất cả cửa sổ đóng (trên macOS)
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Không kill flash process để flash chạy độc lập
    app.quit();
  }
});

// Không kill flash process khi ứng dụng thoát để flash chạy độc lập
