import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.WASTELAND_ROOT ? path.resolve(process.env.WASTELAND_ROOT) : path.resolve(here, "../..");
export const DATA_DIR = process.env.WASTELAND_DATA_DIR ? path.resolve(process.env.WASTELAND_DATA_DIR) : path.join(ROOT, "data");
export const ISSUES_DIR = path.join(DATA_DIR, "issues");
export const AUTH_FILE = path.join(DATA_DIR, "auth.json");

export const UPSTREAM = {
  api: "https://api.mkexue.com",
  site: "https://mkexue.com",
  reader: "https://kexuehao.mkexue.com",
  clientId: "eeab85c174ab451e84cb8883ea46c8f",
  siteId: "1785128947234697218",
  rsaPublicKey:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtq7BcsG5qmZE7Zf5oJCiN+Udac57/BwlsoqGD2aU6Ko9vhx1IXbicNjJUAFKhca0taCr5UA/d+xjw40YidM9YPdTDtnoKgdIrq+zmDxMxC6HJwouNy+htRXAcZrE42BeYSG8nXWDGMjS2hKTrBlPzPcULwap7l6nUx+CSszQ22+kt5hbYFdxPKapKwc+dmJU66WW0oVeR0W1jopefdq/AClyv3bYu1YTobIccQmyX6gM4nG5VaYgDyY+cI8RQBVKWChR4tuWx14vJYsH4AqRbTVZI4dOw21UVdN2f0k6f0CyTQzF184Tpc3sKSIlbSMXuxLHlakJi/OFQMs+IXi6YwIDAQAB",
};

export const PORT = Number(process.env.PORT || 5178);
export const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
