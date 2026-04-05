const fs = require("fs");
const path = require("path");
const { app, Notification, BrowserWindow } = require("electron");
const debugLogger = require("./debugLogger");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".flac", ".aac", ".ogg", ".webm", ".opus"]);
const DEBOUNCE_MS = 1500;
const POLL_INTERVAL_MS = 3000;
const CONFIG_FILE = "watch-folders.json";

class WatchFolderManager {
  constructor() {
    this.ipcHandlers = null; // set via setIpcHandlers() after construction
    this.databaseManager = null;
    this.windowManager = null;
    this._watchers = new Map(); // folderPath -> watcher/interval
    this._debounceTimers = new Map(); // filePath -> timeout
    this._processedFiles = new Map(); // filePath -> size (dedup)
    this._folders = []; // array of { path, status }
    this._configPath = null;
  }

  setDependencies(ipcHandlers, databaseManager, windowManager) {
    this.ipcHandlers = ipcHandlers;
    this.databaseManager = databaseManager;
    this.windowManager = windowManager;
  }

  start() {
    this._configPath = path.join(app.getPath("userData"), CONFIG_FILE);
    this._loadConfig();
    for (const folder of this._folders) {
      this._startWatching(folder.path);
    }
    debugLogger.log(`WatchFolderManager started, watching ${this._folders.length} folder(s)`, {}, "watchFolder");
  }

  stop() {
    for (const [, watcher] of this._watchers) {
      try {
        if (watcher && typeof watcher.close === "function") {
          watcher.close();
        } else if (typeof watcher === "number") {
          clearInterval(watcher);
        }
      } catch {}
    }
    this._watchers.clear();
    for (const timer of this._debounceTimers.values()) {
      clearTimeout(timer);
    }
    this._debounceTimers.clear();
    debugLogger.log("WatchFolderManager stopped", {}, "watchFolder");
  }

  addFolder(folderPath) {
    if (this._folders.find((f) => f.path === folderPath)) {
      return { success: false, error: "Folder already watched" };
    }
    const folder = { path: folderPath, status: "watching" };
    this._folders.push(folder);
    this._saveConfig();
    this._startWatching(folderPath);
    this._broadcast();
    return { success: true };
  }

  removeFolder(folderPath) {
    this._stopWatching(folderPath);
    this._folders = this._folders.filter((f) => f.path !== folderPath);
    this._saveConfig();
    this._broadcast();
    return { success: true };
  }

  getFolders() {
    return this._folders.map((f) => ({ ...f }));
  }

  // --- Private ---

  _loadConfig() {
    try {
      if (fs.existsSync(this._configPath)) {
        const raw = fs.readFileSync(this._configPath, "utf-8");
        const data = JSON.parse(raw);
        this._folders = Array.isArray(data.folders) ? data.folders : [];
      }
    } catch (err) {
      debugLogger.error("WatchFolderManager: failed to load config", { error: err.message }, "watchFolder");
      this._folders = [];
    }
  }

  _saveConfig() {
    try {
      fs.writeFileSync(this._configPath, JSON.stringify({ folders: this._folders }, null, 2), "utf-8");
    } catch (err) {
      debugLogger.error("WatchFolderManager: failed to save config", { error: err.message }, "watchFolder");
    }
  }

  _startWatching(folderPath) {
    if (this._watchers.has(folderPath)) return;

    if (!fs.existsSync(folderPath)) {
      this._setFolderStatus(folderPath, "error");
      debugLogger.warn(`WatchFolderManager: folder does not exist: ${folderPath}`, {}, "watchFolder");
      return;
    }

    if (process.platform === "linux") {
      this._startPolling(folderPath);
    } else {
      this._startFsWatch(folderPath);
    }
  }

  _startFsWatch(folderPath) {
    try {
      const watcher = fs.watch(folderPath, { recursive: true, persistent: false }, (eventType, filename) => {
        if (!filename) return;
        const filePath = path.join(folderPath, filename);
        if (this._isAudioFile(filePath)) {
          this._scheduleProcess(filePath);
        }
      });

      watcher.on("error", (err) => {
        debugLogger.error(`WatchFolderManager: watcher error for ${folderPath}`, { error: err.message }, "watchFolder");
        this._setFolderStatus(folderPath, "error");
      });

      this._watchers.set(folderPath, watcher);
      this._setFolderStatus(folderPath, "watching");
      debugLogger.log(`WatchFolderManager: watching (fs.watch) ${folderPath}`, {}, "watchFolder");
    } catch (err) {
      debugLogger.error(`WatchFolderManager: failed to watch ${folderPath}`, { error: err.message }, "watchFolder");
      this._setFolderStatus(folderPath, "error");
    }
  }

  _startPolling(folderPath) {
    // Track file mtimes for Linux polling fallback
    const knownFiles = new Map(); // filePath -> mtime

    // Seed with existing files so we don't re-process them on first poll
    try {
      const files = fs.readdirSync(folderPath);
      for (const file of files) {
        const filePath = path.join(folderPath, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isFile()) knownFiles.set(filePath, stat.mtimeMs);
        } catch {}
      }
    } catch {}

    const interval = setInterval(() => {
      try {
        if (!fs.existsSync(folderPath)) {
          this._setFolderStatus(folderPath, "error");
          return;
        }
        const files = fs.readdirSync(folderPath);
        for (const file of files) {
          const filePath = path.join(folderPath, file);
          if (!this._isAudioFile(filePath)) continue;
          try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) continue;
            const prevMtime = knownFiles.get(filePath);
            if (prevMtime === undefined || stat.mtimeMs > prevMtime) {
              knownFiles.set(filePath, stat.mtimeMs);
              if (prevMtime === undefined && stat.mtimeMs < Date.now() - 10000) continue; // skip old files on startup
              this._scheduleProcess(filePath);
            }
          } catch {}
        }
      } catch (err) {
        debugLogger.error(`WatchFolderManager: poll error for ${folderPath}`, { error: err.message }, "watchFolder");
      }
    }, POLL_INTERVAL_MS);

    this._watchers.set(folderPath, interval);
    this._setFolderStatus(folderPath, "watching");
    debugLogger.log(`WatchFolderManager: watching (polling) ${folderPath}`, {}, "watchFolder");
  }

  _stopWatching(folderPath) {
    const watcher = this._watchers.get(folderPath);
    if (watcher !== undefined) {
      try {
        if (watcher && typeof watcher.close === "function") {
          watcher.close();
        } else if (typeof watcher === "number") {
          clearInterval(watcher);
        }
      } catch {}
      this._watchers.delete(folderPath);
    }
  }

  _scheduleProcess(filePath) {
    // Debounce: wait for file write to finish
    if (this._debounceTimers.has(filePath)) {
      clearTimeout(this._debounceTimers.get(filePath));
    }
    const timer = setTimeout(() => {
      this._debounceTimers.delete(filePath);
      this._processFile(filePath);
    }, DEBOUNCE_MS);
    this._debounceTimers.set(filePath, timer);
  }

  async _processFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return;
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;

      // Dedup: skip if already processed with same size
      const key = `${filePath}:${stat.size}`;
      if (this._processedFiles.has(key)) return;
      this._processedFiles.set(key, true);

      debugLogger.log(`WatchFolderManager: processing new file: ${filePath}`, {}, "watchFolder");

      if (!this.ipcHandlers) {
        debugLogger.warn("WatchFolderManager: ipcHandlers not set, skipping transcription", {}, "watchFolder");
        return;
      }

      const result = await this.ipcHandlers.transcribeAudioFileInternal(filePath);

      if (result && result.success !== false && result.text) {
        // Save to database
        if (this.databaseManager) {
          this.databaseManager.saveTranscription(result.text, result.text);
          this._broadcastToWindows("transcription-added", {});
        }

        // Show desktop notification
        const filename = path.basename(filePath);
        try {
          const notif = new Notification({
            title: "Transcription Complete",
            body: `${filename}: ${result.text.substring(0, 80)}${result.text.length > 80 ? "…" : ""}`,
          });
          notif.show();
        } catch {}

        debugLogger.log(`WatchFolderManager: transcription complete for ${filename}`, {}, "watchFolder");
      } else {
        debugLogger.warn(`WatchFolderManager: transcription failed for ${filePath}`, { result }, "watchFolder");
      }
    } catch (err) {
      debugLogger.error(`WatchFolderManager: error processing ${filePath}`, { error: err.message }, "watchFolder");
    }
  }

  _isAudioFile(filePath) {
    return AUDIO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  _setFolderStatus(folderPath, status) {
    const folder = this._folders.find((f) => f.path === folderPath);
    if (folder && folder.status !== status) {
      folder.status = status;
      this._broadcast();
    }
  }

  _broadcast() {
    this._broadcastToWindows("watch-folder-updated", { folders: this.getFolders() });
  }

  _broadcastToWindows(channel, payload) {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    } catch {}
  }
}

module.exports = WatchFolderManager;
