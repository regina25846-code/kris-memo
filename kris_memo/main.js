const { app, BrowserWindow, ipcMain, Tray, Menu, screen, nativeImage, Notification, desktopCapturer, clipboard, dialog, globalShortcut, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { autoUpdater } = require('electron-updater');
const { verifyLicense, checkSavedLicense } = require('./license');

if (process.platform === 'win32' && process.env.APPDATA) {
  app.setPath('userData', path.join(process.env.APPDATA, 'kris-memo'));
}

const DATA_FILE = path.join(app.getPath('userData'), 'memos.json');
const CONFIG_FILE = path.join(app.getPath('userData'), 'config.json');
const _appDir = process.env.PORTABLE_EXECUTABLE_DIR
  ? process.env.PORTABLE_EXECUTABLE_DIR
  : (app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname);
// 포터블은 실행 폴더, 설치본은 userData에 백업 저장 (제거해도 백업 유지)
const _backupBase = process.env.PORTABLE_EXECUTABLE_DIR
  ? _appDir
  : app.getPath('userData');
const BACKUP_AUTO_DIR = path.join(_backupBase, 'backups', 'auto');
const BACKUP_MANUAL_DIR = path.join(_backupBase, 'backups', 'manual');

let dataModified = false;

let sidebarWin = null;
let tabWin = null;
let settingsWin = null;
let colorPickWin = null;
let licenseWin = null;
let tray = null;
let memoWindows = {};
let notifiedSchedules = new Set();
let sidebarOpening = false;
let unlockedFolders = new Set();
let tempCodes = {};

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');
  return { hash, salt };
}
function verifyPw(password, hash, salt) {
  return hashPassword(password, salt).hash === hash;
}

// ── Default data ─────────────────────────────────────────────────────────────

function defaultData() {
  return {
    folders: [
      { id: 'basic', name: 'Basic', color: '#4a90d9', order: 0 },
      { id: 'coin',  name: '코인',  color: '#e88a3a', order: 1 },
    ],
    memos: [],
    schedules: [],
  };
}

function defaultConfig() {
  return {
    sidebarX: 0,
    sidebarSide: 'right',
    sidebarLocked: true,
    autoHide: true,
    theme: 'dark',
    startOnBoot: false,
    showMemosOnStart: true,
    showSidebarOnStart: true,
    showKTab: true,
    starredFirst: false,
    autoBackup: false,
    backupTime: '09:00',
    lastAutoBackupAt: null,
    font: 'Inter,Pretendard',
    shortcuts: {
      newMemo:      { key: 'Ctrl+Alt+N',    enabled: true },
      searchMemo:   { key: 'Ctrl+Alt+F',    enabled: true },
      showAllMemos: { key: 'Ctrl+Alt+PgUp', enabled: true },
      hideAllMemos: { key: 'Ctrl+Alt+PgDn', enabled: true },
      recentMemo:   { key: 'Ctrl+Alt+O',    enabled: true },
      showSidebar:  { key: 'Ctrl+Alt+M',    enabled: true },
      openSettings: { key: 'Ctrl+Alt+F9',   enabled: true },
    },
  };
}

function toElectronAccel(key) {
  return key
    .replace('Ctrl', 'CommandOrControl')
    .replace('PgUp', 'PageUp')
    .replace('PgDn', 'PageDown');
}

function registerShortcuts(cfg) {
  const { globalShortcut } = require('electron');
  globalShortcut.unregisterAll();
  const sc = cfg.shortcuts || {};
  const actions = {
    newMemo:      () => createNewMemo(),
    searchMemo:   () => { sidebarWin?.show(); sidebarWin?.focus(); moveTabToBeside(); sendToSidebar('focus-search'); },
    showAllMemos: () => { const d = loadData(); d.memos.forEach(m => openMemo(m)); },
    hideAllMemos: () => closeAllMemos(),
    recentMemo:   () => { const d = loadData(); const m = [...d.memos].sort((a,b) => new Date(b.updatedAt)-new Date(a.updatedAt))[0]; if (m) openMemo(m); },
    showSidebar:  () => { sidebarWin?.show(); sidebarWin?.focus(); moveTabToBeside(); },
    openSettings: () => { sidebarWin?.show(); sidebarWin?.focus(); moveTabToBeside(); sendToSidebar('open-settings'); },
  };
  Object.entries(sc).forEach(([name, s]) => {
    if (!s.enabled || !s.key) return;
    try { globalShortcut.register(toElectronAccel(s.key), actions[name]); } catch(e) {}
  });
}

function closeAllMemos() {
  Object.values(memoWindows).forEach(w => { if (!w.isDestroyed()) w.close(); });
}

function sendToSidebar(channel, ...args) {
  if (sidebarWin && !sidebarWin.isDestroyed()) {
    sidebarWin.webContents.send(channel, ...args);
  }
}

// ── Data I/O ─────────────────────────────────────────────────────────────────

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (!d.schedules) d.schedules = [];
      return d;
    }
  } catch(e) {}
  return defaultData();
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  dataModified = true;
}

function ensureBackupDirs() {
  [BACKUP_AUTO_DIR, BACKUP_MANUAL_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
}

function pruneOldBackups(dir, max) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  while (files.length > max) {
    fs.unlinkSync(path.join(dir, files.shift()));
  }
}

function runAutoBackup() {
  try {
    ensureBackupDirs();
    const date = new Date().toISOString().slice(0, 10);
    const dest = path.join(BACKUP_AUTO_DIR, `auto_${date}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    pruneOldBackups(BACKUP_AUTO_DIR, 30);
    dataModified = false;
    const cfg = loadConfig();
    cfg.lastAutoBackupAt = new Date().toISOString();
    saveConfig(cfg);
  } catch(e) {}
}

function runManualBackup() {
  try {
    ensureBackupDirs();
    const ts = new Date().toISOString().replace(/:/g, '').slice(0, 15);
    const dest = path.join(BACKUP_MANUAL_DIR, `manual_${ts}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    return dest;
  } catch(e) { return null; }
}

function checkAutoBackup() {
  const cfg = loadConfig();
  if (!cfg.autoBackup || !dataModified) return;
  const now = new Date();
  const nowHHMM = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  if (nowHHMM !== (cfg.backupTime || '09:00')) return;
  const todayDate = now.toISOString().slice(0, 10);
  const lastDate = cfg.lastAutoBackupAt ? cfg.lastAutoBackupAt.slice(0, 10) : null;
  if (lastDate === todayDate) return;
  runAutoBackup();
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch(e) {}
  return defaultConfig();
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

async function checkPortableUpdate() {
  try {
    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      const req = https.get({
        hostname: 'api.github.com',
        path: '/repos/regina25846-code/kris-memo/releases/latest',
        headers: { 'User-Agent': 'K-Memo' }
      }, res => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      req.on('error', reject);
    });
    const latest = data.tag_name?.replace(/^v/, '');
    const current = app.getVersion();
    if (latest && latest !== current) {
      sendToSidebar('portable-update-available', latest);
    }
  } catch(e) {}
}

// ── SMEMO .stf importer ───────────────────────────────────────────────────────

function importStfFiles(dirPath) {
  const data = loadData();

  // 'SMEMO' 폴더 없으면 생성
  let smemoFolder = data.folders.find(f => f.id === 'smemo');
  if (!smemoFolder) {
    smemoFolder = { id: 'smemo', name: 'SMEMO', color: '#9c6fd6', order: data.folders.length };
    data.folders.push(smemoFolder);
  }

  const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.stf'));
  let imported = 0;
  for (const file of files) {
    const id = 'stf_' + file.replace('.stf', '');
    if (data.memos.find(m => m.id === id)) continue;
    const raw = fs.readFileSync(path.join(dirPath, file));
    const text = raw.slice(2).toString('utf16le');
    const lines = text.split(/\r?\n/);
    const title = lines[0].trim() || '(제목 없음)';
    const content = lines.slice(1).join('\n').trimStart();
    data.memos.push({
      id, folderId: 'smemo', title, content,
      color: '#fdf6ff', visible: false, pinned: false, starred: false,
      x: 200 + (imported % 5) * 20, y: 150 + (imported % 5) * 20,
      width: 300, height: 220,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    imported++;
  }
  saveData(data);
  return imported;
}

// ── Sidebar window ────────────────────────────────────────────────────────────

function createLicenseWindow() {
  licenseWin = new BrowserWindow({
    width: 360,
    height: 260,
    resizable: false,
    frame: false,
    center: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload_license.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });
  licenseWin.loadFile('renderer/license.html');
}

function createSidebar() {
  const { height, width } = screen.getPrimaryDisplay().workAreaSize;
  const cfg = loadConfig();
  const sidebarW = 240;
  const x = cfg.sidebarSide === 'left' ? 0 : width - sidebarW;

  sidebarWin = new BrowserWindow({
    x, y: 0,
    width: sidebarW,
    height,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: cfg.sidebarAlwaysOnTop !== false,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  sidebarWin.loadFile('renderer/sidebar.html');
  sidebarWin.setVisibleOnAllWorkspaces(true);

  sidebarWin.on('blur', () => {
    if (!loadConfig().autoHide) return;
    const settingsOpen = (settingsWin && !settingsWin.isDestroyed());
    if (!settingsOpen && !Object.values(memoWindows).some(w => w.isFocused())) {
      sidebarWin.hide();
      moveTabToBeside();
    }
  });
}

// ── Tab window ────────────────────────────────────────────────────────────────

const TAB_W = 24, TAB_H = 72;

function getTabPos() {
  const { height, width } = screen.getPrimaryDisplay().workAreaSize;
  const cfg = loadConfig();
  const sidebarW = 240;
  let x;
  if (cfg.sidebarSide === 'left') {
    x = sidebarWin?.isVisible() ? sidebarW : 0;
  } else {
    x = sidebarWin?.isVisible() ? width - sidebarW - TAB_W : width - TAB_W;
  }
  const y = Math.floor(height / 2) - Math.floor(TAB_H / 2);
  return { x, y };
}

function createTabWindow() {
  const cfg = loadConfig();
  const { x, y } = getTabPos();

  tabWin = new BrowserWindow({
    x, y, width: TAB_W, height: TAB_H,
    frame: false, transparent: true, backgroundColor: '#00000000',
    focusable: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  tabWin.loadFile('renderer/tab.html', { query: { side: cfg.sidebarSide || 'right', theme: cfg.sidebarTheme || 'darkgray' } });
  tabWin.setVisibleOnAllWorkspaces(true);
}

function moveTabToBeside() {
  if (!tabWin) return;
  const { x, y } = getTabPos();
  tabWin.setPosition(x, y);
}

// ── Memo window ───────────────────────────────────────────────────────────────

function openMemo(memo) {
  if (memoWindows[memo.id]) {
    memoWindows[memo.id].focus();
    return;
  }

  const win = new BrowserWindow({
    x: memo.x || 300,
    y: memo.y || 200,
    width: memo.width || 300,
    height: memo.height || 220,
    minWidth: 180,
    minHeight: 120,
    frame: false,
    transparent: false,
    alwaysOnTop: memo.pinned || false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  win.loadFile('renderer/memo.html');
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('memo-init', memo);
  });

  win.on('moved', () => {
    const [x, y] = win.getPosition();
    updateMemoPos(memo.id, x, y);
  });
  win.on('resize', () => {
    const [w, h] = win.getSize();
    const data = loadData();
    const m = data.memos.find(m => m.id === memo.id);
    if (m) { m.width = w; m.height = h; saveData(data); }
  });

  win.on('closed', () => {
    delete memoWindows[memo.id];
    const data = loadData();
    const m = data.memos.find(m => m.id === memo.id);
    if (m) { m.visible = false; saveData(data); }
    sendToSidebar('memo-closed', memo.id);
  });

  memoWindows[memo.id] = win;

  const data = loadData();
  const m = data.memos.find(m => m.id === memo.id);
  if (m) { m.visible = true; saveData(data); }
}

function updateMemoPos(id, x, y) {
  const data = loadData();
  const m = data.memos.find(m => m.id === id);
  if (m) { m.x = x; m.y = y; saveData(data); }
}

// ── Alarm checker ─────────────────────────────────────────────────────────────

function getReminderOffsetMs(reminder) {
  if (!reminder || reminder === 'none') return null;
  const m = reminder.match(/^(\d+)(m|h|d|w)$/);
  if (!m) return 0;
  const n = parseInt(m[1]);
  const u = m[2];
  if (u === 'm') return n * 60000;
  if (u === 'h') return n * 3600000;
  if (u === 'd') return n * 86400000;
  if (u === 'w') return n * 604800000;
  return 0;
}

function getCustomReminderOffsetMs(cr) {
  const unitMap = { '분': 60000, '시간': 3600000, '일': 86400000, '주': 604800000 };
  return (cr.num || 0) * (unitMap[cr.unit] || 60000);
}

function checkAlarms() {
  const data = loadData();
  const now = new Date();
  const nowDate = now.toISOString().slice(0, 10);
  const nowMin = Math.floor(now.getTime() / 60000) * 60000;
  let changed = false;

  for (const s of (data.schedules || [])) {
    if (!s.done && s.autoDelete && s.date < nowDate) {
      s.done = true; changed = true;
    }
    const hasAlarm = s.alarmType ? s.alarmType !== 'none' : !!s.alarm;
    if (s.done || !hasAlarm) continue;
    if (!s.date) continue;

    const eventTime = (s.scheduleType === 'allday') ? '09:00' : (s.time || '09:00');
    const eventMs = new Date(`${s.date}T${eventTime}:00`).getTime();
    if (isNaN(eventMs)) continue;

    const offsets = [];
    const reminder = s.reminder || s.alarmType;
    if (reminder && reminder !== 'none') {
      const off = getReminderOffsetMs(reminder);
      if (off !== null) offsets.push({ key: reminder, off });
    }
    if (s.customReminders && s.customReminders.length) {
      s.customReminders.forEach((cr, i) => {
        offsets.push({ key: `custom-${i}`, off: getCustomReminderOffsetMs(cr) });
      });
    }

    for (const { key, off } of offsets) {
      const fireMin = Math.floor((eventMs - off) / 60000) * 60000;
      if (fireMin !== nowMin) continue;
      const notifKey = `${s.id}-${fireMin}-${key}`;
      if (!notifiedSchedules.has(notifKey)) {
        notifiedSchedules.add(notifKey);
        if (Notification.isSupported()) {
          const body = off === 0
            ? `${s.title}${s.content ? '\n' + s.content : ''}`
            : `${s.title}${s.content ? '\n' + s.content : ''}\n(${off >= 86400000 ? (off/86400000)+'일' : off >= 3600000 ? (off/3600000)+'시간' : (off/60000)+'분'} 전 알림)`;
          new Notification({ title: 'K-Memo 알람', body }).show();
        }
        sendToSidebar('alarm-fired', s.id);
      }
    }
  }

  if (changed) { saveData(data); sendToSidebar('data-changed'); }
}

// ── Tray ──────────────────────────────────────────────────────────────────────

// 요일별 배경색 (일~토)
const TRAY_DOW_COLORS = [
  [0xd9,0x4f,0x4f], // 일 red
  [0x3a,0x7b,0xc8], // 월 blue
  [0x9b,0x59,0xb6], // 화 purple
  [0x27,0xae,0x60], // 수 green
  [0xe6,0x7e,0x22], // 목 orange
  [0x1a,0x7f,0xa8], // 금 teal
  [0x50,0x60,0xd0], // 토 indigo
];

// 3×5 픽셀 폰트 (숫자 0-9, 각 행은 3비트 마스크)
const DIGIT_FONT = {
  '0':[0x7,0x5,0x5,0x5,0x7], '1':[0x2,0x6,0x2,0x2,0x7],
  '2':[0x7,0x1,0x7,0x4,0x7], '3':[0x7,0x1,0x3,0x1,0x7],
  '4':[0x5,0x5,0x7,0x1,0x1], '5':[0x7,0x4,0x7,0x1,0x7],
  '6':[0x7,0x4,0x7,0x5,0x7], '7':[0x7,0x1,0x1,0x1,0x1],
  '8':[0x7,0x5,0x7,0x5,0x7], '9':[0x7,0x5,0x7,0x1,0x7],
};

function drawDigit(buf, W, ch, ox, oy, scale) {
  const rows = DIGIT_FONT[ch]; if (!rows) return;
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if (rows[row] & (1 << (2 - col))) {
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const px = ox + col * scale + dx, py = oy + row * scale + dy;
          if (px >= 0 && px < W && py >= 0 && py < W) {
            const i = (py * W + px) * 4;
            buf[i] = 255; buf[i+1] = 255; buf[i+2] = 255; buf[i+3] = 255;
          }
        }
      }
    }
  }
}

function makeDateTrayIcon() {
  const now = new Date();
  const day = now.getDate();
  const dow = now.getDay();
  const [br, bg, bb] = TRAY_DOW_COLORS[dow];
  const W = 16, scale = 2;
  const buf = Buffer.alloc(W * W * 4);
  for (let i = 0; i < W * W; i++) { buf[i*4]=br; buf[i*4+1]=bg; buf[i*4+2]=bb; buf[i*4+3]=255; }
  const s = String(day), cw = 3*scale, ch = 5*scale, gap = 1;
  if (s.length === 1) {
    drawDigit(buf, W, s[0], Math.floor((W-cw)/2), Math.floor((W-ch)/2), scale);
  } else {
    const tw = cw*2 + gap, sx = Math.floor((W-tw)/2), sy = Math.floor((W-ch)/2);
    drawDigit(buf, W, s[0], sx, sy, scale);
    drawDigit(buf, W, s[1], sx+cw+gap, sy, scale);
  }
  return nativeImage.createFromBuffer(buf, { width: W, height: W });
}

let _trayLastDay = -1;
function updateTrayIcon() {
  if (!tray || tray.isDestroyed()) return;
  const today = new Date().getDate();
  if (today !== _trayLastDay) {
    _trayLastDay = today;
    tray.setImage(makeDateTrayIcon());
  }
}

function createTray() {
  tray = new Tray(makeDateTrayIcon());
  _trayLastDay = new Date().getDate();
  tray.setToolTip('K-Memo');

  const menu = Menu.buildFromTemplate([
    { label: '백업', click: () => {
      const dest = runManualBackup();
      if (dest) dialog.showMessageBox({ type: 'info', title: 'K-Memo', message: `백업 완료\n${dest}` });
      else dialog.showMessageBox({ type: 'error', title: 'K-Memo', message: '백업 실패' });
    }},
    { label: '복원', click: async () => {
      const result = await dialog.showOpenDialog({ title: '복원할 백업 파일 선택', defaultPath: BACKUP_MANUAL_DIR, filters: [{ name: 'JSON 백업', extensions: ['json'] }], properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return;
      try {
        const raw = fs.readFileSync(result.filePaths[0], 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed.memos) { dialog.showMessageBox({ type: 'error', title: 'K-Memo', message: '올바른 백업 파일이 아닙니다.' }); return; }
        runManualBackup();
        fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), 'utf8');
        dialog.showMessageBox({ type: 'info', title: 'K-Memo', message: '복원 완료. 앱을 재시작하면 적용됩니다.' });
      } catch(e) { dialog.showMessageBox({ type: 'error', title: 'K-Memo', message: '복원 실패' }); }
    }},
    { type: 'separator' },
    { label: '환경설정', click: () => openSettingsWindow() },
    { type: 'separator' },
    { label: '설명서 보기', click: () => shell.openExternal('https://regina25846-code.github.io/kris-memo/update/manual.html') },
    { type: 'separator' },
    { label: '프로그램 정보', click: () => {
      dialog.showMessageBox({ type: 'info', title: 'K-Memo', message: `K-Memo v${app.getVersion()}\n\nPC 메모 프로그램\nby Kris (with Team Melona)` });
    }},
    { label: '프로그램 종료', click: () => { tray?.destroy(); app.exit(0); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (sidebarWin?.isVisible()) {
      sidebarWin.hide();
    } else {
      sidebarWin?.show();
      sidebarWin?.focus();
    }
    moveTabToBeside();
  });
}

function createNewMemo() {
  const data = loadData();
  const id = Date.now().toString();
  const colors = ['#fffde7','#e8f5e9','#e3f2fd','#fce4ec','#f3e5f5','#fff3e0'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const memo = {
    id, folderId: data.folders[0]?.id || 'basic',
    title: '', content: '',
    color, visible: true, pinned: false, starred: false,
    x: 300 + Math.random() * 100, y: 150 + Math.random() * 100,
    width: 300, height: 220,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.memos.push(memo);
  saveData(data);
  openMemo({ ...memo, isNew: true });
  sendToSidebar('data-changed');
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-data', () => loadData());
ipcMain.handle('get-config', () => loadConfig());

ipcMain.handle('save-memo', (_, memo) => {
  const data = loadData();
  const idx = data.memos.findIndex(m => m.id === memo.id);
  if (idx >= 0) {
    const existing = data.memos[idx];
    data.memos[idx] = {
      ...existing, ...memo,
      x: existing.x, y: existing.y, width: existing.width, height: existing.height,
      updatedAt: new Date().toISOString(),
    };
  } else {
    data.memos.push({ ...memo, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  }
  saveData(data);
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('delete-memo', (_, id) => {
  const data = loadData();
  data.memos = data.memos.filter(m => m.id !== id);
  saveData(data);
  if (memoWindows[id]) { memoWindows[id].destroy(); delete memoWindows[id]; }
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('toggle-starred', (_, id) => {
  const data = loadData();
  const m = data.memos.find(m => m.id === id);
  if (m) { m.starred = !m.starred; saveData(data); }
  sendToSidebar('data-changed');
  return !!(m?.starred);
});

ipcMain.handle('open-memo', (_, memo) => {
  const data = loadData();
  const latest = data.memos.find(m => m.id === memo.id) || memo;
  openMemo(latest);
  return true;
});
ipcMain.handle('preview-ktab', (_, show) => { if (show) tabWin?.show(); else tabWin?.hide(); });
ipcMain.handle('new-memo', () => { createNewMemo(); return true; });
ipcMain.handle('new-memo-in-folder', (_, folderId) => {
  const data = loadData();
  const id = Date.now().toString();
  const colors = ['#fffde7','#e8f5e9','#e3f2fd','#fce4ec','#f3e5f5','#fff3e0'];
  const color = colors[Math.floor(Math.random() * colors.length)];
  const memo = {
    id, folderId: folderId || data.folders[0]?.id || 'basic',
    title: '', content: '',
    color, visible: true, pinned: false, starred: false,
    x: 300 + Math.random() * 100, y: 150 + Math.random() * 100,
    width: 300, height: 220,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  data.memos.push(memo);
  saveData(data);
  openMemo({ ...memo, isNew: true });
  sendToSidebar('data-changed');
  return true;
});
ipcMain.handle('close-memo', (_, id) => {
  if (memoWindows[id]) { memoWindows[id].close(); }
  return true;
});

ipcMain.handle('save-folder', (_, folder) => {
  const data = loadData();
  const idx = data.folders.findIndex(f => f.id === folder.id);
  if (idx >= 0) data.folders[idx] = folder;
  else data.folders.push(folder);
  saveData(data);
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('delete-folder', (_, id) => {
  const data = loadData();
  data.folders = data.folders.filter(f => f.id !== id);
  data.memos.forEach(m => { if (m.folderId === id) m.folderId = data.folders[0]?.id || 'basic'; });
  saveData(data);
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('move-memo', (_, { memoId, folderId }) => {
  const data = loadData();
  const m = data.memos.find(m => m.id === memoId);
  if (m) { m.folderId = folderId; saveData(data); }
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('toggle-pin', (_, id) => {
  const data = loadData();
  const m = data.memos.find(m => m.id === id);
  if (m) {
    m.pinned = !m.pinned;
    saveData(data);
    if (memoWindows[id]) memoWindows[id].setAlwaysOnTop(m.pinned);
  }
  return true;
});

ipcMain.handle('import-stf', (_, dirPath) => {
  const count = importStfFiles(dirPath);
  sendToSidebar('data-changed');
  return count;
});

ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(sidebarWin, {
    properties: ['openDirectory'],
    title: 'SMEMO syncmemo_data 폴더 선택',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// System tools
ipcMain.handle('system-shutdown', () => {
  const { exec } = require('child_process');
  exec('shutdown /s /t 5');
  return true;
});

ipcMain.handle('system-lock', () => {
  const { exec } = require('child_process');
  exec('rundll32.exe user32.dll,LockWorkStation');
  return true;
});

// Schedule IPC
ipcMain.handle('save-schedule', (_, schedule) => {
  const data = loadData();
  const idx = data.schedules.findIndex(s => s.id === schedule.id);
  if (idx >= 0) data.schedules[idx] = { ...data.schedules[idx], ...schedule, updatedAt: new Date().toISOString() };
  else data.schedules.push({ ...schedule, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  saveData(data);
  sendToSidebar('data-changed');
  return true;
});

ipcMain.handle('delete-schedule', (_, id) => {
  const data = loadData();
  data.schedules = data.schedules.filter(s => s.id !== id);
  saveData(data);
  sendToSidebar('data-changed');
  return true;
});

// Capture IPC — takes screenshot to clipboard
ipcMain.handle('capture-screen', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
    if (sources.length > 0) {
      clipboard.writeImage(sources[0].thumbnail);
      return true;
    }
  } catch(e) {}
  return false;
});

ipcMain.handle('show-sidebar', () => {
  sidebarWin?.show();
  sidebarWin?.focus();
  moveTabToBeside();
  return true;
});

ipcMain.handle('hide-sidebar', () => {
  sidebarWin?.hide();
  moveTabToBeside();
  return true;
});
let colorPickInterval = null;
let colorPickForTodo = null;
let colorPickSidebarWasVisible = false;

function closeColorPick(hex) {
  if (colorPickInterval) { clearInterval(colorPickInterval); colorPickInterval = null; }
  globalShortcut.unregister('Escape');
  if (colorPickWin && !colorPickWin.isDestroyed()) colorPickWin.close();
  colorPickWin = null;
  if (colorPickSidebarWasVisible) {
    sidebarWin?.show();
    colorPickSidebarWasVisible = false;
  }
  tabWin?.show();
  moveTabToBeside();
  if (colorPickForTodo && todoColorPickWin && !todoColorPickWin.isDestroyed()) {
    todoColorPickWin.show();
    todoColorPickWin.focus();
    if (hex) {
      clipboard.writeText(hex);
      todoColorPickWin.webContents.send('eyedrop-result', colorPickForTodo, hex);
    }
  } else if (hex) {
    clipboard.writeText(hex);
    sidebarWin?.webContents.send('colorpick-result', hex);
  }
  colorPickForTodo = null;
}

ipcMain.handle('colorpick-start', async (_, todoTarget = null) => {
  if (colorPickWin && !colorPickWin.isDestroyed()) return;
  colorPickForTodo = todoTarget || null;
  if (todoTarget && todoColorPickWin && !todoColorPickWin.isDestroyed()) todoColorPickWin.hide();
  const { width, height } = screen.getPrimaryDisplay().size;

  colorPickSidebarWasVisible = sidebarWin?.isVisible() ?? false;
  sidebarWin?.hide();
  tabWin?.hide();
  await new Promise(r => setTimeout(r, 180));

  const scaleFactor = screen.getPrimaryDisplay().scaleFactor || 1;
  let b64 = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
    });
    b64 = sources[0]?.thumbnail.toDataURL();
  } catch(e) {}

  const LOUPE_W = 220, LOUPE_H = 256;

  function loupePos(x, y) {
    // 루페 정중앙에 커서가 오도록
    let nx = Math.round(x - LOUPE_W / 2);
    let ny = Math.round(y - LOUPE_H / 2);
    nx = Math.max(0, Math.min(nx, width - LOUPE_W));
    ny = Math.max(0, Math.min(ny, height - LOUPE_H));
    return { nx, ny };
  }

  const startPos = screen.getCursorScreenPoint();
  const { nx: lx, ny: ly } = loupePos(startPos.x, startPos.y);

  colorPickWin = new BrowserWindow({
    x: lx, y: ly,
    width: LOUPE_W, height: LOUPE_H,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: true,
    show: false,
    backgroundColor: '#1a1a1a',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  colorPickWin.setVisibleOnAllWorkspaces(true);
  if (process.platform === 'win32') {
    colorPickWin.setAlwaysOnTop(true, 'screen-saver');
  }
  colorPickWin.loadFile('renderer/colorpick.html');
  colorPickWin.webContents.once('did-finish-load', () => {
    colorPickWin?.webContents.send('colorpick-data', b64);
    colorPickWin?.show();
    colorPickWin?.moveTop();

    colorPickInterval = setInterval(() => {
      if (!colorPickWin || colorPickWin.isDestroyed()) {
        clearInterval(colorPickInterval); colorPickInterval = null; return;
      }
      const { x, y } = screen.getCursorScreenPoint();
      const { nx, ny } = loupePos(x, y);
      colorPickWin.setPosition(nx, ny, false);
      colorPickWin.webContents.send('cursor-pos', Math.round(x * scaleFactor), Math.round(y * scaleFactor));
    }, 30);
  });

  if (globalShortcut.isRegistered('Escape')) globalShortcut.unregister('Escape');
  globalShortcut.register('Escape', () => closeColorPick(null));
});

ipcMain.on('colorpick-close', (_, hex) => closeColorPick(hex));
ipcMain.handle('colorpick-end', () => {});

// ── 할 것 색상 플로팅 피커 ────────────────────────────────────────────────────
let todoColorPickWin = null;

ipcMain.handle('open-todo-colorpick', (_, bg, text) => {
  if (todoColorPickWin && !todoColorPickWin.isDestroyed()) {
    todoColorPickWin.show();
    todoColorPickWin.focus();
    todoColorPickWin.webContents.send('todo-colorpick-init', bg, text);
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const W = 240, H = 265;
  const px = Math.min(Math.max(0, cursor.x + 12), sw - W);
  const py = Math.min(Math.max(0, cursor.y - 20), sh - H);
  todoColorPickWin = new BrowserWindow({
    x: px, y: py,
    width: W, height: H,
    resizable: false, alwaysOnTop: true,
    frame: false, transparent: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  todoColorPickWin.setVisibleOnAllWorkspaces(true);
  todoColorPickWin.loadFile('renderer/todo_colorpick.html');
  todoColorPickWin.webContents.once('did-finish-load', () => {
    todoColorPickWin.webContents.send('todo-colorpick-init', bg, text);
    todoColorPickWin.show();
    todoColorPickWin.focus();
  });
  todoColorPickWin.on('closed', () => { todoColorPickWin = null; });
});

ipcMain.on('todo-colorpick-apply', (_, bg, text) => {
  sidebarWin?.webContents.send('todo-color-result', bg, text);
  if (todoColorPickWin && !todoColorPickWin.isDestroyed()) todoColorPickWin.close();
  todoColorPickWin = null;
});

ipcMain.handle('todo-colorpick-close', () => {
  if (todoColorPickWin && !todoColorPickWin.isDestroyed()) todoColorPickWin.close();
  todoColorPickWin = null;
});
ipcMain.handle('toggle-sidebar', () => {
  if (sidebarWin?.isVisible()) {
    sidebarWin.hide();
    moveTabToBeside();
  } else {
    sidebarWin?.show();
    sidebarWin?.focus();
    moveTabToBeside();
  }
  return true;
});

// ── 폴더 잠금 ─────────────────────────────────────────────────────────────────

ipcMain.handle('folder-set-password', (_, { folderId, currentPassword, newPassword }) => {
  const data = loadData();
  const folder = data.folders.find(f => f.id === folderId);
  if (!folder) return { ok: false, error: '폴더 없음' };
  if (folder.passwordHash) {
    if (!currentPassword) return { ok: false, error: '현재 비밀번호 필요' };
    if (!verifyPw(currentPassword, folder.passwordHash, folder.passwordSalt)) return { ok: false, error: '현재 비밀번호 틀림' };
  }
  const { hash, salt } = hashPassword(newPassword);
  folder.passwordHash = hash;
  folder.passwordSalt = salt;
  saveData(data);
  sendToSidebar('data-changed');
  return { ok: true };
});

ipcMain.handle('folder-verify-password', (_, { folderId, password }) => {
  const data = loadData();
  const folder = data.folders.find(f => f.id === folderId);
  if (!folder || !folder.passwordHash) return { ok: false, error: '잠금 없음' };
  if (verifyPw(password, folder.passwordHash, folder.passwordSalt)) {
    unlockedFolders.add(folderId);
    return { ok: true };
  }
  return { ok: false, error: '비밀번호 틀림' };
});

ipcMain.handle('folder-lock', (_, folderId) => {
  unlockedFolders.delete(folderId);
  return true;
});

ipcMain.handle('folder-remove-password', (_, { folderId, currentPassword }) => {
  const data = loadData();
  const folder = data.folders.find(f => f.id === folderId);
  if (!folder) return { ok: false, error: '폴더 없음' };
  if (!verifyPw(currentPassword, folder.passwordHash, folder.passwordSalt)) return { ok: false, error: '비밀번호 틀림' };
  delete folder.passwordHash;
  delete folder.passwordSalt;
  saveData(data);
  unlockedFolders.delete(folderId);
  sendToSidebar('data-changed');
  return { ok: true };
});

ipcMain.handle('folder-is-unlocked', (_, folderId) => unlockedFolders.has(folderId));

ipcMain.handle('folder-send-recovery', async (_, folderId) => {
  const cfg = loadConfig();
  if (!cfg.recoveryEmail) return { ok: false, error: '복구 이메일 미등록\n설정 → 보안에서 등록해주세요' };
  if (!cfg.gmailSender || !cfg.gmailAppPassword) return { ok: false, error: 'Gmail 설정 미완료\n설정 → 보안에서 설정해주세요' };
  let nodemailer;
  try { nodemailer = require('nodemailer'); } catch(e) { return { ok: false, error: 'nodemailer 모듈 없음\n앱을 재설치하세요' }; }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const { hash, salt } = hashPassword(code);
  tempCodes[folderId] = { hash, salt, expiry: Date.now() + 15 * 60 * 1000 };
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: cfg.gmailSender, pass: cfg.gmailAppPassword },
    });
    await transporter.sendMail({
      from: cfg.gmailSender,
      to: cfg.recoveryEmail,
      subject: '[K-Memo] 폴더 잠금 임시 비밀번호',
      text: `임시 비밀번호: ${code}\n\n유효 시간: 15분\nK-Memo 잠금 해제 화면에서 입력하세요.`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('folder-verify-temp-reset', (_, { folderId, tempCode, newPassword }) => {
  const entry = tempCodes[folderId];
  if (!entry) return { ok: false, error: '임시 코드 없음' };
  if (Date.now() > entry.expiry) { delete tempCodes[folderId]; return { ok: false, error: '임시 코드 만료 (15분)' }; }
  if (!verifyPw(tempCode, entry.hash, entry.salt)) return { ok: false, error: '임시 코드 틀림' };
  const data = loadData();
  const folder = data.folders.find(f => f.id === folderId);
  if (!folder) return { ok: false, error: '폴더 없음' };
  const { hash, salt } = hashPassword(newPassword);
  folder.passwordHash = hash;
  folder.passwordSalt = salt;
  saveData(data);
  delete tempCodes[folderId];
  unlockedFolders.add(folderId);
  sendToSidebar('data-changed');
  return { ok: true };
});

ipcMain.handle('save-recovery-settings', async (_, { recoveryEmail, gmailSender, gmailAppPassword, verifyPassword, folderId }) => {
  if (folderId) {
    const data = loadData();
    const folder = data.folders.find(f => f.id === folderId);
    if (folder?.passwordHash && !verifyPw(verifyPassword, folder.passwordHash, folder.passwordSalt)) {
      return { ok: false, error: '비밀번호 틀림' };
    }
  }
  // Gmail 연결 테스트
  if (gmailSender && gmailAppPassword) {
    try {
      let nm;
      try { nm = require('nodemailer'); } catch(e) { return { ok: false, error: 'nodemailer 모듈 없음' }; }
      const transporter = nm.createTransport({
        service: 'gmail',
        auth: { user: gmailSender, pass: gmailAppPassword }
      });
      await transporter.verify();
    } catch(e) {
      return { ok: false, error: 'Gmail 인증 실패. 이메일 주소 또는 앱 비밀번호를 확인해주세요.' };
    }
  }
  const cfg = loadConfig();
  cfg.recoveryEmail = recoveryEmail;
  cfg.gmailSender = gmailSender;
  cfg.gmailAppPassword = gmailAppPassword;
  saveConfig(cfg);
  return { ok: true };
});

ipcMain.handle('save-config', (_, cfg) => {
  const existing = loadConfig();
  cfg = { ...existing, ...cfg };
  saveConfig(cfg);
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  const sidebarW = 240;
  const newX = cfg.sidebarSide === 'left' ? 0 : width - sidebarW;
  sidebarWin?.setPosition(newX, 0);
  moveTabToBeside();
  tabWin?.webContents.send('set-side', cfg.sidebarSide || 'right');
  tabWin?.webContents.send('set-theme', cfg.sidebarTheme || 'darkgray');
  app.setLoginItemSettings({ openAtLogin: !!cfg.startOnBoot });
  registerShortcuts(cfg);
  // K탭 표시 여부 적용
  if (cfg.showKTab === false) tabWin?.hide(); else tabWin?.show();
  // 열려있는 메모 창에 폰트 변경 브로드캐스트
  const font = cfg.font || '맑은 고딕';
  Object.values(memoWindows).forEach(w => {
    if (!w.isDestroyed()) w.webContents.send('set-font', font);
  });
  sidebarWin?.setAlwaysOnTop(cfg.sidebarAlwaysOnTop !== false);
  sendToSidebar('config-updated', cfg);
  return true;
});

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  sidebarWin?.show();
  settingsWin = new BrowserWindow({
    width: 500, height: 520,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  settingsWin.loadFile('renderer/settings.html');
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('open-settings-window', () => { openSettingsWindow(); });

ipcMain.handle('preview-theme', (_, name) => {
  sidebarWin?.webContents.send('preview-theme', name);
  tabWin?.webContents.send('set-theme', name);
  return true;
});

let sidebarSettingsWin = null;
ipcMain.handle('open-sidebar-settings-window', () => {
  if (sidebarSettingsWin && !sidebarSettingsWin.isDestroyed()) { sidebarSettingsWin.focus(); return; }
  sidebarSettingsWin = new BrowserWindow({
    width: 290, height: 390,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  sidebarSettingsWin.loadFile('renderer/sidebar_settings.html');
  sidebarSettingsWin.on('closed', () => { sidebarSettingsWin = null; });
});

ipcMain.handle('close-settings-window', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) win.close();
});
ipcMain.handle('memo-is-open', (_, id) => !!memoWindows[id]);

// ── What's New ────────────────────────────────────────────────────────────────

let whatsNewWin = null;

function openWhatsNewWindow() {
  if (whatsNewWin && !whatsNewWin.isDestroyed()) { whatsNewWin.focus(); return; }
  whatsNewWin = new BrowserWindow({
    width: 460, height: 900,
    frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: false,
    transparent: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  whatsNewWin.loadFile('renderer/whats_new.html');
  whatsNewWin.on('closed', () => { whatsNewWin = null; });
}

ipcMain.handle('get-whats-new', () => {
  const version = app.getVersion();
  let changes = [];
  try {
    const cl = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'changelog.json'), 'utf8'));
    changes = cl[version] || [];
  } catch(e) {}
  return { version, changes };
});

ipcMain.handle('close-whats-new', () => {
  const cfg = loadConfig();
  cfg.lastSeenVersion = app.getVersion();
  saveConfig(cfg);
  if (whatsNewWin && !whatsNewWin.isDestroyed()) whatsNewWin.close();
});

ipcMain.handle('resize-whats-new', (_, w, h) => {
  if (whatsNewWin && !whatsNewWin.isDestroyed()) {
    whatsNewWin.setSize(Math.round(w), Math.round(h));
  }
});

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // 라이선스 검증
  const licensed = await checkSavedLicense(CONFIG_FILE);
  if (!licensed) {
    createLicenseWindow();
    return;
  }
  startApp();
});

function startApp() {
  createSidebar();
  createTabWindow();
  createTray();

  const cfg = loadConfig();
  const data = loadData();
  if (cfg.showMemosOnStart !== false) {
    data.memos.filter(m => m.visible).forEach(m => openMemo(m));
  }

  if (cfg.showSidebarOnStart === false) sidebarWin.hide();
  if (cfg.showKTab === false) tabWin?.hide();

  registerShortcuts(cfg);

  // 업데이트 후 첫 실행 시 What's New 팝업
  const currentVersion = app.getVersion();
  if (cfg.lastSeenVersion !== currentVersion) {
    setTimeout(() => openWhatsNewWindow(), 1500);
  }

  setInterval(checkAlarms, 30000);
  setInterval(checkAutoBackup, 60000);
  setInterval(updateTrayIcon, 60000);

  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  if (isPortable) {
    checkPortableUpdate();
  } else {
    autoUpdater.checkForUpdatesAndNotify();
    autoUpdater.on('update-available', () => sendToSidebar('update-status', 'downloading'));
    autoUpdater.on('download-progress', (p) => sendToSidebar('update-progress', Math.round(p.percent)));
    autoUpdater.on('update-downloaded', () => sendToSidebar('update-status', 'ready'));
  }
}

ipcMain.handle('license-verify', async (_, key) => {
  return await verifyLicense(key);
});

ipcMain.handle('license-activate', (_, key) => {
  const cfg = loadConfig();
  cfg.licenseKey = key;
  saveConfig(cfg);
  if (licenseWin && !licenseWin.isDestroyed()) licenseWin.close();
  licenseWin = null;
  startApp();
  return true;
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

ipcMain.handle('close-all-memos', () => { closeAllMemos(); return true; });
ipcMain.handle('show-all-memos', () => {
  const d = loadData();
  d.memos.forEach(m => openMemo(m));
  return true;
});
ipcMain.handle('set-login-item', (_, enabled) => {
  app.setLoginItemSettings({ openAtLogin: enabled });
  return true;
});
ipcMain.handle('get-login-item', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('backup-data', () => {
  const dest = runManualBackup();
  return dest ? path.basename(dest) : false;
});

ipcMain.handle('restore-backup', async () => {
  const result = await dialog.showOpenDialog(sidebarWin, {
    title: '복원할 백업 파일 선택',
    defaultPath: BACKUP_MANUAL_DIR,
    filters: [{ name: 'JSON 백업', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return false;
  try {
    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed.memos) return false;
    runManualBackup(); // 복원 전 현재 데이터 백업
    fs.writeFileSync(DATA_FILE, JSON.stringify(parsed, null, 2), 'utf8');
    return true;
  } catch(e) { return false; }
});

ipcMain.handle('quit-app', () => { tray?.destroy(); app.exit(0); });
ipcMain.handle('open-url', (_, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});
ipcMain.handle('open-backup-folder', () => {
  const { shell } = require('electron');
  const fs = require('fs');
  if (!fs.existsSync(BACKUP_MANUAL_DIR)) fs.mkdirSync(BACKUP_MANUAL_DIR, { recursive: true });
  shell.openPath(BACKUP_MANUAL_DIR);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => {
  tray?.destroy();
  const { globalShortcut } = require('electron');
  globalShortcut.unregisterAll();
});
