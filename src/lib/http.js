export class ApiError extends Error {
  constructor(message, { status = 0, code = null, payload = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export async function request(path, options = {}) {
  const { timeoutMs = 180000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...fetchOptions,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      throw new ApiError("服务端返回了非 JSON 响应", { status: res.status });
    }
    if (!res.ok || json.ok === false) {
      throw new ApiError(json.error || "请求失败 (" + res.status + ")", {
        status: res.status,
        code: json.code || null,
        payload: json,
      });
    }
    return json;
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new ApiError("请求超时，请检查 mkexue.com 连接", { code: "TIMEOUT" });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function isAuthError(error) {
  return Boolean(error && (error.status === 401 || error.code === "CREDENTIALS_REQUIRED"));
}
