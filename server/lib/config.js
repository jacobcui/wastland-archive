import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.WASTELAND_ROOT ? path.resolve(process.env.WASTELAND_ROOT) : path.resolve(here, "../..");
export const DATA_DIR = process.env.WASTELAND_DATA_DIR ? path.resolve(process.env.WASTELAND_DATA_DIR) : path.join(ROOT, "data");
export const ISSUES_DIR = path.join(DATA_DIR, "issues");
export const AUTH_FILE = path.join(DATA_DIR, "auth.json");

/* App state that must survive browser changes. Never put this inside DATA_DIR:
   DATA_DIR is the portable magazine archive. */
export const MEDIA_HOME = process.env.WASTELAND_MEDIA_HOME
  ? path.resolve(process.env.WASTELAND_MEDIA_HOME)
  : path.join(os.homedir(), ".wasteland_archive");
export const MEDIA_INDEX_FILE = path.join(MEDIA_HOME, "media-index.json");
/* The legacy browser-upload transcode route is a disposable cache. Keep it in
   the OS temp directory so it never pollutes the media home / Application
   Support, and clean it on every server start. Include a short key for the
   media home + port so the dev server and the native app (which may run at the
   same time) never delete each other's active sessions. */
const tempPort = process.env.PORT || "5178";
const tempKey = crypto.createHash("sha1").update(MEDIA_HOME + ":" + tempPort).digest("hex").slice(0, 8);
export const TRANSCODE_TEMP_DIR = path.join(os.tmpdir(), "wasteland-archive-transcodes-" + tempKey);
/* Older versions stored HLS sessions here; removed on every boot. */
export const LEGACY_TRANSCODE_DIR = path.join(MEDIA_HOME, "transcodes");

export const UPSTREAM = {
  api: "https://api.mkexue.com",
  site: "https://mkexue.com",
  reader: "https://kexuehao.mkexue.com",
  clientId: "eeab85c174ab451e84cb8883ea46c8f",
  siteId: "1785128947234697218",
  rsaPublicKey:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtq7BcsG5qmZE7Zf5oJCiN+Udac57/BwlsoqGD2aU6Ko9vhx1IXbicNjJUAFKhca0taCr5UA/d+xjw40YidM9YPdTDtnoKgdIrq+zmDxMxC6HJwouNy+htRXAcZrE42BeYSG8nXWDGMjS2hKTrBlPzPcULwap7l6nUx+CSszQ22+kt5hbYFdxPKapKwc+dmJU66WW0oVeR0W1jopefdq/AClyv3bYu1YTobIccQmyX6gM4nG5VaYgDyY+cI8RQBVKWChR4tuWx14vJYsH4AqRbTVZI4dOw21UVdN2f0k6f0CyTQzF184Tpc3sKSIlbSMXuxLHlakJi/OFQMs+IXi6YwIDAQAB",
};

export const PORT = Number(tempPort);
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
