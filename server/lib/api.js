import { UPSTREAM, UA } from "./config.js";
import { session } from "./auth.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function rawGet(path, token) {
  const res = await fetch(UPSTREAM.api + path, {
    headers: {
      Accept: "application/json",
      clientid: UPSTREAM.clientId,
      "Content-Language": "zh_CN",
      Authorization: "Bearer " + token,
      "User-Agent": UA,
      Referer: UPSTREAM.site + "/",
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

/** Authenticated GET against the mkexue API with one automatic re-login on 401. */
export async function apiGet(path, { retries = 2 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let token;
    try {
      token = await session.ensureToken(attempt > 0);
    } catch (error) {
      throw error;
    }
    try {
      const { status, json } = await rawGet(path, token);
      if (status === 401 || (json && json.code === 401)) {
        session.invalidate();
        lastError = new Error((json && json.msg) || "未授权");
        await sleep(400);
        continue;
      }
      if (!json) throw new Error("响应不是 JSON: " + path);
      if (json.code !== 200) throw new Error(json.msg || "接口错误 (" + path + ")");
      return json.data;
    } catch (error) {
      lastError = error;
      if (/未授权|token/i.test(error.message || "")) {
        session.invalidate();
      }
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastError || new Error("请求失败: " + path);
}

export const getMagazines = () => apiGet("/node/ebookMagazine/bookshelf");

export const getYears = (magazineId = 0) => apiGet("/node/ebook/bookshelfYear/" + magazineId);

export const getIssues = (year, pageNum = 1, pageSize = 100) =>
  apiGet(
    `/node/ebook/bookshelfPagePc?pageSize=${pageSize}&pageNum=${pageNum}&boundVolumeType=0&year=${year}`,
  );

export const getIssueDetail = (nodeId) => apiGet("/node/ebook/pub/" + nodeId);

export function normalizeIssue(row) {
  return {
    nodeId: String(row.nodeId),
    magazineId: row.magazineId ? String(row.magazineId) : null,
    title: row.title || "电脑报",
    volume: row.volume || `${row.itemYear}年${row.itemMonth}月第${row.itemNumber}期`,
    year: row.itemYear,
    month: row.itemMonth,
    number: row.itemNumber,
    coverUrl: row.coverUrl || null,
    publishTime: row.promisePublishTime || null,
  };
}
