const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wastelandDesktop", {
  revealPath: (target) => ipcRenderer.invoke("wasteland:reveal-path", target),
  pickDirectory: () => ipcRenderer.invoke("wasteland:pick-directory"),
});
