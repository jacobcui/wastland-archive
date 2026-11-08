const DB_NAME = "wasteland-browser";
const DB_VERSION = 5;
const STORES = ["pdfs", "folders", "imageFolders", "media", "mediaFolders", "mediaTranscodes"];
const LEGACY_MEDIA_CLEANUP_KEY = "wasteland.media.legacy-cache-cleared.v1";
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("当前浏览器不支持 IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB 打开失败"));
  });
  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let result;
    try {
      result = fn(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error("IndexedDB 事务失败"));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB 事务取消"));
  });
}

/* Old 1.0.x builds copied every imported media file into IndexedDB as a Blob.
   Those blobs can occupy hundreds of GB in the Electron/browser profile. The
   server-backed library only stores paths, so remove the legacy media stores
   once while keeping PDFs and image-folder metadata untouched. */
export async function purgeLegacyMediaCache() {
  try {
    const db = await openDb();
    const stores = ["media", "mediaFolders", "mediaTranscodes"].filter((name) => db.objectStoreNames.contains(name));
    if (stores.length) {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        for (const name of stores) tx.objectStore(name).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error("IndexedDB cleanup failed"));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB cleanup aborted"));
      });
    }
    localStorage.setItem(LEGACY_MEDIA_CLEANUP_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

export async function idbGetAll(name) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const req = tx.objectStore(name).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error || new Error("IndexedDB 读取失败"));
  });
}

export async function idbGet(name, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, "readonly");
    const req = tx.objectStore(name).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("IndexedDB 读取失败"));
  });
}

export async function idbPutMany(name, values) {
  return withStore(name, "readwrite", (store) => {
    for (const value of values) {
      const key = value && value.id !== undefined ? value.id : undefined;
      if (key === undefined) store.put(value);
      else store.put(value, key);
    }
  });
}

export async function idbPut(name, value, key) {
  const actualKey = key === undefined && value && value.id !== undefined ? value.id : key;
  return withStore(name, "readwrite", (store) => (actualKey === undefined ? store.put(value) : store.put(value, actualKey)));
}

export async function idbDelete(name, key) {
  return withStore(name, "readwrite", (store) => store.delete(key));
}
