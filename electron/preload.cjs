const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wastelandDesktop", {
  revealPath: (target) => ipcRenderer.invoke("wasteland:reveal-path", target),
  pickDirectory: () => ipcRenderer.invoke("wasteland:pick-directory"),
  getSystemInfo: () => ipcRenderer.invoke("wasteland:system-info"),
  downloadUpdate: (payload) => ipcRenderer.invoke("wasteland:download-update", payload),
  onUpdateProgress: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on("wasteland:update-progress", listener);
    return () => ipcRenderer.removeListener("wasteland:update-progress", listener);
  },
});
