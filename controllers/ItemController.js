class ItemController {
  constructor(dataModel, ipcMain, mainWindow, appDir) {
    this.dataModel = dataModel;
    this.mainWindow = mainWindow;
    this.appDir = appDir;
    this.setupIPC(ipcMain);
  }

  setupIPC(ipcMain) {
    ipcMain.handle('get-data', () => {
      return this.dataModel.getAll();
    });

    ipcMain.handle('add-item', (event, item) => {
      return this.dataModel.add(item);
    });

    ipcMain.handle('update-item', (event, id, updates) => {
      return this.dataModel.update(id, updates);
    });

    ipcMain.handle('delete-item', (event, id) => {
      return this.dataModel.delete(id);
    });

    ipcMain.handle('update-window-title', (event, title) => {
      if (this.mainWindow) {
        this.mainWindow.setTitle(title);
      }
    });
  }
}

module.exports = ItemController;
