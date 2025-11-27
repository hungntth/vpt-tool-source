const { ipcRenderer } = require('electron');

class App {
  constructor() {
    this.editingId = null;
    this.data = [];
    this.toastTimeout = null;
    this.toastEl = null;
    this.activeTab = 'links';
    this.autoState = {
      targetWindow: null,
      points: [],
      isRunning: false,
      draggingWindow: false,
      draggingPoint: false
    };
    this.autoElements = {};
    this.autoConfig = { interval: 1200, points: [] };
    this.autoProfiles = [];
    this.autoSelections = {};
    this.autoProfileName = '';
    this.dragGhostImage = null;
    this.itemAutoRunning = {}; // Lưu trạng thái running cho từng item: { itemId: true/false }
    this.init();
  }

  async init() {
    await this.loadData();
    this.cacheDomElements();
    await this.loadAutoConfig();
    await this.loadAutoProfiles();
    this.setupEventListeners();
    this.toastEl = document.getElementById('toast');
    
    // Đóng menu khi click ra ngoài
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.menu-wrapper')) {
        this.closeAllMenus();
      }
    });
  }

  cacheDomElements() {
    this.linksPanel = document.getElementById('linksPanel');
    this.linksFormWrapper = document.getElementById('linksFormWrapper');
    this.navLinksTab = document.getElementById('navLinksTab');
    this.navAutoTab = document.getElementById('navAutoTab');
    this.autoElements = {
      panel: document.getElementById('autoPanel'),
      pickWindowBtn: document.getElementById('autoPickWindowBtn'),
      pickPointBtn: document.getElementById('autoPickPointBtn'),
      clearPointsBtn: document.getElementById('autoClearPointsBtn'),
      pointsList: document.getElementById('autoPointsList'),
      targetInfo: document.getElementById('autoTargetInfo'),
      intervalInput: document.getElementById('autoInterval'),
      startBtn: document.getElementById('autoStartBtn'),
      stopBtn: document.getElementById('autoStopBtn'),
      profileNameInput: document.getElementById('autoProfileName'),
      saveProfileBtn: document.getElementById('autoSaveProfileBtn'),
      profilesList: document.getElementById('autoProfilesList')
    };
    this.dragGhostImage = this.createDragGhost();
  }

  async loadAutoConfig() {
    try {
      const config = await ipcRenderer.invoke('auto-load-config');
      if (config) {
        this.autoConfig = config;
        if (Array.isArray(config.points) && config.points.length > 0) {
          this.autoState.points = config.points.map((point) => this.transformSavedPoint(point));
          this.renderAutoPoints();
        }
        if (this.autoElements.intervalInput && config.interval) {
          this.autoElements.intervalInput.value = config.interval;
        }
        this.updateAutoTargetInfo();
      }
    } catch (error) {
      console.warn('Không thể tải cấu hình auto click:', error);
    }
  }

  async loadAutoProfiles() {
    try {
      const profiles = await ipcRenderer.invoke('auto-list-profiles');
      if (Array.isArray(profiles)) {
        this.autoProfiles = profiles;
      } else {
        this.autoProfiles = [];
      }
      this.syncAutoSelections();
      this.renderAutoProfiles();
      this.renderTable();
    } catch (error) {
      console.warn('Không thể tải danh sách quy trình auto:', error);
    }
  }

  createDragGhost() {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, 1, 1);
    }
    return canvas;
  }

  transformSavedPoint(point) {
    return {
      id: this.generatePointId(),
      offsetX: Number(point.offsetX) || 0,
      offsetY: Number(point.offsetY) || 0,
      screenX: Number(point.screenX) || 0,
      screenY: Number(point.screenY) || 0
    };
  }

  generatePointId() {
    return Date.now() + Math.floor(Math.random() * 1000);
  }

  setupEventListeners() {
    document.getElementById('itemForm').addEventListener('submit', (e) => {
      this.handleSubmit(e);
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      this.cancelEdit();
    });

    this.navLinksTab.addEventListener('click', () => this.switchTab('links'));
    this.navAutoTab.addEventListener('click', () => this.switchTab('auto'));

    this.setupAutoClickControls();

    // Lắng nghe thay đổi tên để cập nhật tab
    document.getElementById('ten').addEventListener('input', () => {
      if (this.editingId) {
        const ten = document.getElementById('ten').value.trim();
        if (ten) {
          ipcRenderer.invoke('update-window-title', `VPT TOOLS - ${ten}`);
        }
      }
    });
  }

  persistAutoConfig() {
    const intervalInput = this.autoElements.intervalInput;
    if (!intervalInput) return;

    const sanitizedInterval = Math.max(200, parseInt(intervalInput.value, 10) || 1000);
    intervalInput.value = sanitizedInterval;

    const payload = {
      points: this.autoState.points.map(({ offsetX, offsetY }) => ({ offsetX, offsetY })),
      interval: sanitizedInterval
    };

    ipcRenderer.invoke('auto-save-config', payload).catch((error) => {
      console.warn('Không thể lưu cấu hình auto:', error);
    });
  }

  handleIntervalChange() {
    this.persistAutoConfig();
  }

  switchTab(tab) {
    if (this.activeTab === tab) return;
    this.activeTab = tab;
    const showLinks = tab === 'links';
    this.linksPanel.classList.toggle('hidden', !showLinks);
    this.linksFormWrapper.classList.toggle('hidden', !showLinks);
    this.autoElements.panel.classList.toggle('hidden', showLinks);

    if (showLinks) {
      this.navLinksTab.classList.add('border-indigo-400', 'bg-indigo-500', 'text-white');
      this.navLinksTab.classList.remove('bg-indigo-50', 'text-indigo-600');
      this.navAutoTab.classList.remove('border-indigo-400', 'bg-indigo-500', 'text-white');
      this.navAutoTab.classList.add('bg-indigo-50', 'text-indigo-600');
    } else {
      this.navAutoTab.classList.add('border-indigo-400', 'bg-indigo-500', 'text-white');
      this.navAutoTab.classList.remove('bg-indigo-50', 'text-indigo-600');
      this.navLinksTab.classList.remove('border-indigo-400', 'bg-indigo-500', 'text-white');
      this.navLinksTab.classList.add('bg-indigo-50', 'text-indigo-600');
    }
  }

  setupAutoClickControls() {
    const {
      pickWindowBtn,
      pickPointBtn,
      clearPointsBtn,
      startBtn,
      stopBtn,
      intervalInput,
      saveProfileBtn,
      profileNameInput,
      profilesList
    } = this.autoElements;

    if (!pickWindowBtn) return; // Auto UI chưa render

    pickWindowBtn.addEventListener('dragstart', (event) => {
      this.autoState.draggingWindow = true;
      pickWindowBtn.classList.add('opacity-80');
      if (event?.dataTransfer && this.dragGhostImage) {
        event.dataTransfer.setDragImage(this.dragGhostImage, 0, 0);
      }
    });

    pickWindowBtn.addEventListener('dragend', async (event) => {
      pickWindowBtn.classList.remove('opacity-80');
      this.autoState.draggingWindow = false;
      await this.handleAutoWindowDrop(event);
    });

    pickPointBtn.addEventListener('dragstart', (event) => {
      if (pickPointBtn.disabled) {
        if (event?.preventDefault) event.preventDefault();
        return;
      }
      this.autoState.draggingPoint = true;
      pickPointBtn.classList.add('opacity-80');
      if (event?.dataTransfer && this.dragGhostImage) {
        event.dataTransfer.setDragImage(this.dragGhostImage, 0, 0);
      }
    });

    pickPointBtn.addEventListener('dragend', async (event) => {
      pickPointBtn.classList.remove('opacity-80');
      if (!this.autoState.draggingPoint) {
        return;
      }
      this.autoState.draggingPoint = false;
      await this.handleAutoPointDrop(event);
    });

    clearPointsBtn.addEventListener('click', () => {
      this.autoState.points = [];
      this.renderAutoPoints();
      this.persistAutoConfig();
    });

    startBtn.addEventListener('click', (e) => this.startAutoClick(e));
    stopBtn.addEventListener('click', (e) => this.stopAutoClick(e));

    if (intervalInput) {
      intervalInput.addEventListener('change', () => this.handleIntervalChange());
      intervalInput.addEventListener('blur', () => this.handleIntervalChange());
    }

    if (saveProfileBtn) {
      saveProfileBtn.addEventListener('click', () => this.saveCurrentProfile());
    }

    if (profileNameInput) {
      profileNameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.saveCurrentProfile();
        }
      });
    }

    if (profilesList) {
      profilesList.addEventListener('click', (event) => {
        const target = event.target;
        if (!target || !target.dataset) return;
        const index = Number(target.dataset.index);
        if (!Number.isInteger(index) || index < 0 || index >= this.autoProfiles.length) {
          return;
        }
        if (target.dataset.action === 'load-profile') {
          this.loadProfileFromList(index);
        } else if (target.dataset.action === 'delete-profile') {
          this.deleteProfileFromList(index);
        }
      });
    }

    ipcRenderer.on('auto-click-status', (_event, payload) => {
      if (typeof payload?.running === 'boolean') {
        this.autoState.isRunning = payload.running;
        this.toggleAutoButtons();
      }
      if (payload?.targetLost) {
        this.autoState.targetWindow = null;
        if (this.autoElements.pickPointBtn) {
          this.autoElements.pickPointBtn.disabled = true;
        }
        this.persistAutoConfig();
        this.updateAutoTargetInfo();
      }
      if (payload?.message) {
        this.showMessage(payload.message, payload.type || (payload.running ? 'success' : 'error'));
      }
    });

    // Listener cho auto click status của từng item
    ipcRenderer.on('auto-click-status-for-item', (_event, payload) => {
      if (payload?.itemId !== undefined) {
        this.itemAutoRunning[payload.itemId] = payload.running || false;
        this.renderTable(); // Cập nhật UI để hiển thị trạng thái
      }
      if (payload?.message) {
        const item = this.data.find(i => i.id === payload.itemId);
        const itemName = item ? item.ten : 'Item';
        this.showMessage(`[${itemName}] ${payload.message}`, payload.type || (payload.running ? 'success' : 'error'));
      }
    });
  }

  async loadData() {
    try {
      this.data = await ipcRenderer.invoke('get-data');
      this.renderTable();
    } catch (error) {
      this.showMessage('Lỗi khi tải dữ liệu: ' + error.message, 'error');
    }
  }

  renderTable() {
    const tbody = document.getElementById('tableBody');
    
    if (this.data.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-8 px-2.5 text-gray-500">
            <div class="text-2xl mb-2.5">📋</div>
            <p class="text-xs">Chưa có dữ liệu. Hãy thêm link mới!</p>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = this.data.map(item => {
      const escapedLink = item.link.replace(/'/g, "\\'");
      const selectedProfile = this.autoSelections[item.id] || '';
      const hasProfiles = this.autoProfiles.length > 0;
      const selectDisabledAttr = hasProfiles ? '' : 'disabled';
      const profileOptions = this.renderAutoOptions(selectedProfile);
      return `
      <tr class="hover:bg-gray-50">
        <td class="w-9 p-1.5 text-center font-semibold text-indigo-500">${item.stt}</td>
        <td class="w-20 max-w-20 p-1.5 overflow-hidden text-ellipsis whitespace-nowrap" title="${this.escapeHtml(item.ten)}">${this.escapeHtml(item.ten)}</td>
        <td class="max-w-[80px] p-1.5">
          ${item.targetWindow 
            ? `<button class="btn btn-icon w-full bg-green-500 hover:bg-green-600 text-white border-green-600" 
                      draggable="true"
                      title="Đã định vị ứng dụng"
                      ondragstart="app.handleTargetDragStart(event, ${item.id})"
                      ondragend="app.handleTargetDragEnd(event, ${item.id})"
                      style="cursor: grab;">🖥️</button>`
            : `<button class="btn btn-icon btn-secondary w-full" 
                      draggable="true"
                      title="Kéo sang ứng dụng để định vị"
                      ondragstart="app.handleTargetDragStart(event, ${item.id})"
                      ondragend="app.handleTargetDragEnd(event, ${item.id})"
                      style="cursor: grab;">🖥️</button>`
          }
        </td>
        <td class="max-w-[80px] p-1.5 overflow-hidden text-ellipsis whitespace-nowrap">
          <a href="${this.escapeHtml(item.link)}" target="_blank" title="${this.escapeHtml(item.link)}" class="text-indigo-500 no-underline hover:underline text-xs">
            ${this.escapeHtml(item.link.length > 30 ? item.link.substring(0, 30) + '...' : item.link)}
          </a>
        </td>
        <td class="w-16 text-center p-1.5">
          <button class="btn btn-icon btn-success" title="Chơi Flash" onclick="app.playFlash('${escapedLink}', '${this.escapeHtml(item.ten).replace(/'/g, "\\'")}')">
            ▶️
          </button>
        </td>
        <td class="w-24 text-center p-1.5">
          <div class="flex items-center gap-1 justify-center">
            <select class="auto-select" ${this.itemAutoRunning[item.id] ? 'disabled' : selectDisabledAttr} onchange="app.handleAutoProfileSelect(${item.id}, this.value)">
              ${profileOptions}
            </select>
            ${this.itemAutoRunning[item.id] 
              ? `<button class="btn btn-icon btn-danger" title="Dừng auto" onclick="app.stopProfileForItem(${item.id})">⏹</button>`
              : `<button class="btn btn-icon btn-primary" title="Chạy auto" ${selectDisabledAttr} onclick="app.runProfileForItem(${item.id})">⚡</button>`
            }
          </div>
        </td>
        <td class="w-8 p-1.5 relative">
          <div class="relative flex justify-center items-center menu-wrapper">
            <button class="menu-btn" onclick="app.toggleMenu(event, ${item.id})" title="Menu">⋮</button>
            <div class="absolute top-full right-0 bg-white border border-gray-300 rounded shadow-lg z-[100] min-w-20 mt-1 hidden" id="menu-${item.id}">
              <button class="menu-item rounded-t" onclick="app.editItem(${item.id}); app.closeAllMenus();">
                ✏️ Sửa
              </button>
              <button class="menu-item menu-item-danger rounded-b" onclick="app.deleteItem(${item.id}); app.closeAllMenus();">
                🗑️ Xóa
              </button>
            </div>
          </div>
        </td>
      </tr>
    `;
    }).join('');
  }

  async handleSubmit(e) {
    e.preventDefault();
    
    const ten = document.getElementById('ten').value.trim();
    const link = document.getElementById('link').value.trim();
    const pid = document.getElementById('pid') ? document.getElementById('pid').value.trim() : '';

    if (!ten || !link) {
      this.showMessage('Vui lòng điền đầy đủ thông tin!', 'error');
      return;
    }

    try {
      if (this.editingId) {
        // Cập nhật
        this.data = await ipcRenderer.invoke('update-item', this.editingId, { ten, link, pid });
        this.showMessage('Cập nhật thành công!', 'success');
        // Cập nhật tên tab
        ipcRenderer.invoke('update-window-title', `VPT TOOLS - ${ten}`);
        this.cancelEdit();
      } else {
        // Thêm mới
        this.data = await ipcRenderer.invoke('add-item', { ten, link, pid });
        this.showMessage('Thêm thành công!', 'success');
        document.getElementById('itemForm').reset();
      }
      this.renderTable();
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  async updateItemPid(itemId, pid) {
    try {
      const item = this.data.find(i => i.id === itemId);
      if (item) {
        this.data = await ipcRenderer.invoke('update-item', itemId, { pid: pid.trim() });
        console.log('Đã cập nhật PID:', pid, 'cho item:', itemId, 'Data mới:', this.data.find(i => i.id === itemId));
        this.renderTable();
      }
    } catch (error) {
      console.error('Lỗi khi cập nhật PID:', error);
    }
  }

  handleTargetDragStart(event, itemId) {
    event.dataTransfer.effectAllowed = 'copy';
    if (this.dragGhostImage) {
      event.dataTransfer.setDragImage(this.dragGhostImage, 0, 0);
    }
    event.currentTarget.classList.add('opacity-80');
  }

  async handleTargetDragEnd(event, itemId) {
    event.currentTarget.classList.remove('opacity-80');
    
    if (!event || (event.screenX === 0 && event.screenY === 0)) {
      return;
    }

    try {
      const result = await ipcRenderer.invoke('auto-detect-window', {
        x: event.screenX,
        y: event.screenY
      });

      if (result?.success && result.window) {
        // Lưu thông tin cửa sổ vào item
        await this.updateItemTargetWindow(itemId, result.window);
        this.showMessage('Đã định vị ứng dụng: ' + result.window.title, 'success');
      } else {
        this.showMessage('Không định vị được ứng dụng.', 'error');
      }
    } catch (error) {
      console.error('Lỗi khi định vị ứng dụng:', error);
      this.showMessage('Lỗi khi định vị ứng dụng: ' + error.message, 'error');
    }
  }

  async updateItemTargetWindow(itemId, targetWindow) {
    try {
      const item = this.data.find(i => i.id === itemId);
      if (item) {
        // Lưu thông tin cửa sổ dưới dạng JSON string
        const windowData = JSON.stringify({
          pid: targetWindow.pid,
          title: targetWindow.title,
          handle: targetWindow.handle
        });
        this.data = await ipcRenderer.invoke('update-item', itemId, { targetWindow: windowData });
        this.renderTable();
      }
    } catch (error) {
      console.error('Lỗi khi cập nhật cửa sổ đích:', error);
    }
  }

  editItem(id) {
    const item = this.data.find(i => i.id === id);
    if (item) {
      this.editingId = id;
      document.getElementById('ten').value = item.ten;
      document.getElementById('link').value = item.link;
      const pidInput = document.getElementById('pid');
      if (pidInput) {
        pidInput.value = item.pid || '';
      }
      document.getElementById('formTitle').textContent = '✏️ Sửa Link';
      document.getElementById('submitBtn').textContent = 'Cập nhật';
      document.getElementById('cancelBtn').classList.remove('hidden');
      // Cập nhật tên tab
      ipcRenderer.invoke('update-window-title', `VPT TOOLS - ${item.ten}`);
      document.getElementById('ten').focus();
    }
  }

  cancelEdit() {
    this.editingId = null;
    document.getElementById('itemForm').reset();
    document.getElementById('formTitle').textContent = '➕ Thêm Link Mới';
    document.getElementById('submitBtn').textContent = 'Thêm';
      document.getElementById('cancelBtn').classList.add('hidden');
    // Reset tên tab về mặc định
    ipcRenderer.invoke('update-window-title', 'VPT TOOLS');
  }

  toggleMenu(event, id) {
    event.stopPropagation();
    const menu = document.getElementById(`menu-${id}`);
    if (!menu) return;
    
    const isVisible = menu.classList.contains('block');
    
    // Đóng tất cả menu trước
    this.closeAllMenus();
    
    // Mở menu này nếu chưa mở
    if (!isVisible) {
      menu.classList.remove('hidden');
      menu.classList.add('block');
    }
  }

  closeAllMenus() {
    document.querySelectorAll('[id^="menu-"]').forEach(menu => {
      menu.classList.add('hidden');
      menu.classList.remove('block');
    });
  }

  async deleteItem(id) {
    if (confirm('Bạn có chắc chắn muốn xóa item này?')) {
      try {
        this.data = await ipcRenderer.invoke('delete-item', id);
        this.showMessage('Xóa thành công!', 'success');
        this.renderTable();
        if (this.editingId === id) {
          this.cancelEdit();
        }
      } catch (error) {
        this.showMessage('Lỗi: ' + error.message, 'error');
      }
    }
  }

  async playFlash(url, ten) {
    try {
      await ipcRenderer.invoke('play-flash', url, ten);
      this.showMessage('Đang mở Flash Player...', 'success');
    } catch (error) {
      this.showMessage('Không mở được Flash: ' + error.message, 'error');
    }
  }

  async handleAutoWindowDrop(event) {
    if (!event || (event.screenX === 0 && event.screenY === 0)) {
      this.showMessage('Không ghi nhận được vị trí thả chuột.', 'error');
      return;
    }

    try {
      const result = await ipcRenderer.invoke('auto-detect-window', {
        x: event.screenX,
        y: event.screenY
      });

      if (result?.success) {
        this.autoState.targetWindow = result.window;
        this.autoState.points = [];
        this.renderAutoPoints();
        this.updateAutoTargetInfo();
        this.persistAutoConfig();
        this.showMessage('Đã ghi nhận ứng dụng: ' + result.window.title, 'success');
      } else {
        this.showMessage(result?.error || 'Không xác định được ứng dụng.', 'error');
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  async handleAutoPointDrop(event) {
    if (!this.autoState.targetWindow) {
      this.showMessage('Vui lòng chọn ứng dụng trước.', 'error');
      return;
    }

    if (!event || (event.screenX === 0 && event.screenY === 0)) {
      this.showMessage('Không ghi nhận được điểm thả chuột.', 'error');
      return;
    }

    try {
      const result = await ipcRenderer.invoke('auto-compute-point', {
        x: event.screenX,
        y: event.screenY
      });

      if (result?.success) {
        const point = result.point;
        const pointId = this.generatePointId();
        this.autoState.points.push({
          id: pointId,
          offsetX: Math.round(point.offsetX),
          offsetY: Math.round(point.offsetY),
          screenX: Math.round(point.screenX),
          screenY: Math.round(point.screenY)
        });
        this.renderAutoPoints();
        this.persistAutoConfig();
        this.showMessage(`Đã thêm điểm (${point.offsetX}, ${point.offsetY})`, 'success');
      } else {
        this.showMessage(result?.error || 'Không thể ghi nhận điểm.', 'error');
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  renderAutoPoints() {
    const list = this.autoElements.pointsList;
    if (!list) return;

    if (this.autoState.points.length === 0) {
      list.innerHTML = '<li class="text-gray-400">Chưa có điểm nào</li>';
      return;
    }

    list.innerHTML = this.autoState.points.map((point, index) => `
      <li class="flex items-center justify-between bg-indigo-50 text-indigo-700 px-2 py-1 rounded">
        <span>#${index + 1} • X: ${point.offsetX} | Y: ${point.offsetY}</span>
        <button class="text-red-500 text-xs font-bold" onclick="app.removeAutoPoint(${point.id})">✖</button>
      </li>
    `).join('');
  }

  renderAutoProfiles() {
    const list = this.autoElements.profilesList;
    if (!list) return;

    if (!this.autoProfiles.length) {
      list.innerHTML = '<li class="text-gray-400 text-xs">Chưa có quy trình nào</li>';
      return;
    }

    list.innerHTML = this.autoProfiles.map((profile, index) => `
      <li class="flex items-center justify-between bg-white border border-gray-200 rounded px-2 py-1">
        <div class="flex flex-col text-[11px] leading-tight">
          <span class="font-semibold text-gray-700">${this.escapeHtml(profile.name)}</span>
          <span class="text-gray-500 text-[10px]">Điểm: ${profile.points.length} • ${profile.interval}ms</span>
        </div>
        <div class="flex items-center gap-1">
          <button class="px-1.5 py-0.5 text-[10px] rounded bg-green-500 text-white" data-action="load-profile" data-index="${index}">▶</button>
          <button class="px-1.5 py-0.5 text-[10px] rounded bg-red-500 text-white" data-action="delete-profile" data-index="${index}">✖</button>
        </div>
      </li>
    `).join('');
  }

  syncAutoSelections() {
    const validProfileNames = new Set(this.autoProfiles.map((profile) => profile.name));
    Object.keys(this.autoSelections).forEach((key) => {
      if (!validProfileNames.has(this.autoSelections[key])) {
        delete this.autoSelections[key];
      }
    });
  }

  renderAutoOptions(selectedName = '') {
    if (!this.autoProfiles.length) {
      return '<option value="">Chưa có</option>';
    }
    const defaultOption = '<option value="">Chọn</option>';
    const options = this.autoProfiles.map((profile) => {
      const isSelected = profile.name === selectedName ? 'selected' : '';
      return `<option value="${this.escapeAttribute(profile.name)}" ${isSelected}>${this.escapeHtml(profile.name)}</option>`;
    }).join('');
    return defaultOption + options;
  }

  handleAutoProfileSelect(itemId, profileName) {
    if (profileName) {
      this.autoSelections[itemId] = profileName;
    } else {
      delete this.autoSelections[itemId];
    }
  }

  async runProfileForItem(itemId) {
    const profileName = this.autoSelections[itemId];
    if (!profileName) {
      this.showMessage('Hãy chọn quy trình auto trước.', 'error');
      return;
    }

    const profile = this.getProfileByName(profileName);
    if (!profile) {
      this.showMessage('Quy trình auto không tồn tại.', 'error');
      delete this.autoSelections[itemId];
      this.renderTable();
      return;
    }

    const item = this.data.find((row) => row.id === itemId);
    if (!item) {
      this.showMessage('Không tìm thấy item.', 'error');
      return;
    }

    // Kiểm tra xem đã định vị ứng dụng chưa
    if (!item.targetWindow) {
      this.showMessage('Vui lòng định vị ứng dụng trước (kéo nút 🖥️ sang ứng dụng).', 'error');
      return;
    }

    // Parse thông tin cửa sổ đã lưu
    let targetWindow;
    try {
      targetWindow = JSON.parse(item.targetWindow);
    } catch (error) {
      this.showMessage('Thông tin cửa sổ không hợp lệ. Vui lòng định vị lại.', 'error');
      return;
    }

    // Áp dụng profile
    this.applyProfile(profile, { silent: true });

    // Chạy auto cho item này với cửa sổ đã lưu
    const interval = Math.max(200, Number(profile.interval) || 1000);
    const points = (profile.points || []).map(({ offsetX, offsetY }) => ({ offsetX, offsetY }));

    if (points.length === 0) {
      this.showMessage('Quy trình auto không có điểm nào.', 'error');
      return;
    }

    try {
      const result = await ipcRenderer.invoke('auto-start-for-item', itemId, {
        targetWindow: {
          pid: targetWindow.pid,
          title: targetWindow.title,
          handle: targetWindow.handle
        },
        interval,
        points
      });

      if (result?.success) {
        this.itemAutoRunning[itemId] = true;
        this.renderTable();
        this.showMessage(`Đang chạy auto cho "${item.ten}"...`, 'success');
      } else {
        this.showMessage(result?.error || 'Không khởi động được auto click.', 'error');
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  async stopProfileForItem(itemId) {
    // Cập nhật UI ngay lập tức để phản hồi nhanh
    this.itemAutoRunning[itemId] = false;
    this.renderTable();
    
    try {
      const result = await ipcRenderer.invoke('auto-stop-for-item', itemId);
      const item = this.data.find(i => i.id === itemId);
      const itemName = item ? item.ten : 'Item';
      
      if (result?.success) {
        // Đảm bảo trạng thái được cập nhật
        this.itemAutoRunning[itemId] = false;
        this.renderTable();
        this.showMessage(`Đã dừng auto cho "${itemName}".`, 'success');
      } else {
        // Nếu có lỗi, vẫn giữ trạng thái dừng trong UI
        this.itemAutoRunning[itemId] = false;
        this.renderTable();
        this.showMessage(result?.error || 'Không dừng được auto click.', 'error');
      }
    } catch (error) {
      // Nếu có lỗi, vẫn cập nhật UI
      this.itemAutoRunning[itemId] = false;
      this.renderTable();
      this.showMessage('Lỗi khi dừng auto: ' + error.message, 'error');
    }
  }

  getProfileByName(name) {
    if (!name) return null;
    return this.autoProfiles.find((profile) => profile.name === name) || null;
  }

  applyProfile(profile, options = {}) {
    if (!profile) return;

    const intervalValue = Math.max(200, Number(profile.interval) || 1000);
    if (this.autoElements.intervalInput) {
      this.autoElements.intervalInput.value = intervalValue;
    }

    this.autoState.points = (profile.points || []).map((point) => ({
      id: this.generatePointId(),
      offsetX: Math.round(point.offsetX),
      offsetY: Math.round(point.offsetY),
      screenX: 0,
      screenY: 0
    }));

    this.renderAutoPoints();
    this.persistAutoConfig();

    if (!options.silent) {
      this.showMessage(`Đã tải quy trình "${profile.name}".`, 'success');
    }
  }

  removeAutoPoint(id) {
    this.autoState.points = this.autoState.points.filter(point => point.id !== id);
    this.renderAutoPoints();
    this.persistAutoConfig();
  }

  async saveCurrentProfile() {
    const nameInput = this.autoElements.profileNameInput;
    if (!nameInput) return;

    const name = nameInput.value.trim();
    if (!name) {
      this.showMessage('Vui lòng nhập tên quy trình.', 'error');
      return;
    }

    if (this.autoState.points.length === 0) {
      this.showMessage('Chưa có điểm auto để lưu.', 'error');
      return;
    }

    const intervalInput = this.autoElements.intervalInput;
    const interval = Math.max(200, parseInt(intervalInput.value, 10) || 1000);
    intervalInput.value = interval;

    try {
      const result = await ipcRenderer.invoke('auto-save-profile', {
        name,
        interval,
        points: this.autoState.points.map(({ offsetX, offsetY }) => ({ offsetX, offsetY }))
      });

      if (result?.success) {
        this.autoProfiles = Array.isArray(result.profiles) ? result.profiles : [];
        this.syncAutoSelections();
        this.renderAutoProfiles();
        this.renderTable();
        this.showMessage(`Đã lưu quy trình "${name}".`, 'success');
        nameInput.value = '';
      } else {
        this.showMessage(result?.error || 'Không lưu được quy trình.', 'error');
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  loadProfileFromList(index) {
    const profile = this.autoProfiles[index];
    if (!profile) return;
    this.applyProfile(profile);
  }

  async deleteProfileFromList(index) {
    const profile = this.autoProfiles[index];
    if (!profile) return;

    try {
      const result = await ipcRenderer.invoke('auto-delete-profile', profile.name);
      if (result?.success) {
        this.autoProfiles = Array.isArray(result.profiles) ? result.profiles : [];
        this.syncAutoSelections();
        this.renderAutoProfiles();
        this.renderTable();
        this.showMessage(`Đã xóa quy trình "${profile.name}".`, 'success');
      } else {
        this.showMessage(result?.error || 'Không xóa được quy trình.', 'error');
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
    }
  }

  updateAutoTargetInfo() {
    const infoEl = this.autoElements.targetInfo;
    if (!infoEl) return;

    const pickPointBtn = this.autoElements.pickPointBtn;
    if (pickPointBtn) {
      pickPointBtn.disabled = !this.autoState.targetWindow;
    }

    infoEl.classList.remove('text-green-600', 'font-semibold');
    infoEl.classList.add('text-gray-600');

    if (this.autoState.targetWindow) {
      infoEl.textContent = `${this.autoState.targetWindow.title} (PID ${this.autoState.targetWindow.pid})`;
      infoEl.classList.remove('text-gray-600');
      infoEl.classList.add('text-green-600', 'font-semibold');
    } else {
      infoEl.textContent = 'Chưa chọn ứng dụng';
    }
  }

  async startAutoClick(event) {
    if (event) {
      event.preventDefault();
    }
    await this.executeAutoStart();
  }

  async executeAutoStart() {
    if (this.autoState.isRunning) {
      this.showMessage('Auto click đang chạy.', 'error');
      return false;
    }

    if (!this.autoState.targetWindow) {
      this.showMessage('Vui lòng chọn ứng dụng trước.', 'error');
      return false;
    }

    if (this.autoState.points.length === 0) {
      this.showMessage('Hãy thêm ít nhất một điểm auto.', 'error');
      return false;
    }

    const interval = Math.max(200, parseInt(this.autoElements.intervalInput.value, 10) || 1000);
    this.autoElements.intervalInput.value = interval;
    this.persistAutoConfig();

    try {
      const result = await ipcRenderer.invoke('auto-start', {
        interval,
        points: this.autoState.points.map(({ offsetX, offsetY }) => ({ offsetX, offsetY }))
      });

      if (result?.success) {
        this.autoState.isRunning = true;
        this.toggleAutoButtons();
        this.showMessage('Đang chạy auto click...', 'success');
        return true;
      } else {
        this.showMessage(result?.error || 'Không khởi động được auto click.', 'error');
        return false;
      }
    } catch (error) {
      this.showMessage('Lỗi: ' + error.message, 'error');
      return false;
    }
  }

  async stopAutoClick(event) {
    event.preventDefault();
    if (!this.autoState.isRunning) {
      return;
    }

    try {
      await ipcRenderer.invoke('auto-stop');
    } finally {
      this.autoState.isRunning = false;
      this.toggleAutoButtons();
      this.showMessage('Đã dừng auto click.', 'success');
    }
  }

  toggleAutoButtons() {
    const { startBtn, stopBtn } = this.autoElements;
    if (!startBtn || !stopBtn) return;

    if (this.autoState.isRunning) {
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
    }
  }

  showMessage(text, type) {
    if (!this.toastEl) {
      this.toastEl = document.getElementById('toast');
    }

    if (!this.toastEl) {
      console.warn('Toast element not found');
      return;
    }

    const baseClasses = 'fixed top-3 right-3 z-50 max-w-xs px-3 py-2 rounded shadow-lg text-xs text-white pointer-events-none transition-opacity duration-300';
    const typeClass = type === 'success'
      ? 'bg-green-500'
      : 'bg-red-500';

    this.toastEl.textContent = text;
    this.toastEl.className = `${baseClasses} ${typeClass} opacity-100`;

    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }

    this.toastTimeout = setTimeout(() => {
      this.toastEl.classList.add('opacity-0');
      setTimeout(() => {
        this.toastEl.className = 'hidden fixed top-3 right-3 z-50 max-w-xs px-3 py-2 rounded shadow-lg text-xs text-white pointer-events-none';
      }, 300);
    }, 2500);
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  escapeAttribute(text) {
    return this.escapeHtml(text).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  async autoSelectWindowByPid(pid, retries = 3, delayMs = 200) {
    // Chuyển đổi PID sang số nếu là string
    const pidNum = typeof pid === 'string' ? parseInt(pid.trim(), 10) : pid;
    
    if (!pidNum || isNaN(pidNum) || pidNum <= 0) {
      console.warn('PID không hợp lệ:', pid);
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await ipcRenderer.invoke('auto-target-by-pid', pidNum);
        if (result?.success) {
          this.autoState.targetWindow = result.window;
          if (this.autoElements.pickPointBtn) {
            this.autoElements.pickPointBtn.disabled = false;
          }
          this.updateAutoTargetInfo();
          return true;
        }
      } catch (error) {
        console.warn('Không tìm thấy cửa sổ với PID', pidNum, error);
      }
      if (attempt < retries - 1) {
        await this.delay(delayMs);
      }
    }

    return false;
  }

  async autoSelectWindowByTitle(title, retries = 12, delayMs = 400) {
    const trimmed = (title || '').trim();
    if (!trimmed) {
      return false;
    }

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const result = await ipcRenderer.invoke('auto-target-by-title', trimmed);
        if (result?.success) {
          this.autoState.targetWindow = result.window;
          if (this.autoElements.pickPointBtn) {
            this.autoElements.pickPointBtn.disabled = false;
          }
          this.updateAutoTargetInfo();
          return true;
        }
      } catch (error) {
        console.warn('Không tìm thấy cửa sổ với tên', trimmed, error);
      }
      await this.delay(delayMs);
    }

    return false;
  }

  delay(ms = 300) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Khởi tạo ứng dụng
let app;
document.addEventListener('DOMContentLoaded', () => {
  app = new App();
});

