const fs = require('fs');
const path = require('path');

class DataModel {
  constructor(dataFile) {
    this.dataFile = dataFile;
    this.initializeDataFile();
  }

  initializeDataFile() {
    if (!fs.existsSync(this.dataFile)) {
      fs.writeFileSync(this.dataFile, JSON.stringify([], null, 2), 'utf8');
    }
  }

  readData() {
    try {
      if (!fs.existsSync(this.dataFile)) {
        this.initializeDataFile();
      }
      const data = fs.readFileSync(this.dataFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Lỗi đọc file:', error);
      return [];
    }
  }

  writeData(data) {
    try {
      fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (error) {
      console.error('Lỗi ghi file:', error);
      return false;
    }
  }

  getAll() {
    return this.readData();
  }

  add(item) {
    const data = this.readData();
    const newItem = {
      id: Date.now(),
      stt: data.length + 1,
      ten: item.ten,
      link: item.link,
      targetWindow: item.targetWindow || null
    };
    data.push(newItem);
    // Cập nhật lại số thứ tự
    this.updateStt(data);
    this.writeData(data);
    return this.readData();
  }

  update(id, updates) {
    const data = this.readData();
    const index = data.findIndex(item => item.id === id);
    if (index !== -1) {
      data[index] = { ...data[index], ...updates };
      this.writeData(data);
      return this.readData();
    }
    return data;
  }

  delete(id) {
    const data = this.readData();
    const filtered = data.filter(item => item.id !== id);
    // Cập nhật lại số thứ tự
    this.updateStt(filtered);
    this.writeData(filtered);
    return this.readData();
  }

  updateStt(data) {
    data.forEach((item, index) => {
      item.stt = index + 1;
    });
  }

  findById(id) {
    const data = this.readData();
    return data.find(item => item.id === id);
  }
}

module.exports = DataModel;

