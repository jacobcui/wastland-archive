const ua = typeof navigator !== "undefined" ? navigator.userAgent || "" : "";

export const isMac = /Macintosh|Mac OS X|iPhone|iPad/i.test(ua);
export const isWindows = /Windows/i.test(ua);
export const platformLabel = isMac ? "macOS" : isWindows ? "Windows" : "Linux";
export const modKeyLabel = isMac ? "⌘" : "Ctrl";
export const modKeyName = isMac ? "Command" : "Ctrl";
export const fileManagerName = isMac ? "Finder" : isWindows ? "资源管理器" : "文件管理器";
export const openArchiveLabel = isMac
  ? "在 Finder 中打开浏览目录"
  : isWindows
    ? "在资源管理器中打开浏览目录"
    : "在文件管理器中打开浏览目录";

export function hasModifier(event) {
  return Boolean(event && (event.metaKey || event.ctrlKey));
}

if (typeof document !== "undefined") {
  document.documentElement.dataset.platform = isMac ? "mac" : isWindows ? "windows" : "linux";
}
