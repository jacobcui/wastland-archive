/* ============================================================
   EPUB 解析 · WASTELAND ARCHIVE
   ------------------------------------------------------------
   零依赖的 EPUB(OCF/ZIP) 读取器：
     - 自己解 ZIP 目录（stored / deflate），用 DecompressionStream("deflate-raw")
     - 解析 META-INF/container.xml -> OPF
     - 解析 OPF: 元数据、manifest、spine、封面
     - 解析目录: EPUB 3 nav.xhtml，回退 EPUB 2 NCX
     - 章节资源统一转成 Blob URL，图片直接可用
   不引入 npm 依赖，不把书上传到服务器。
   ============================================================ */

const XML_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
};

const IMAGE_MIME = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const FONT_MIME = {
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
};

const TEXT_MIME = {
  xhtml: "application/xhtml+xml",
  html: "application/xhtml+xml",
  htm: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "audio/ogg",
  vtt: "text/vtt",
  smil: "application/smil+xml",
  xml: "application/xml",
  ncx: "application/x-dtbncx+xml",
  txt: "text/plain",
};

export function mimeForPath(path) {
  const ext = String(path || "").split(".").pop().toLowerCase();
  if (FONT_MIME[ext]) return FONT_MIME[ext];
  return TEXT_MIME[ext] || "application/octet-stream";
}

export function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = XML_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/* ---------------- 路径工具 ---------------- */

/** 去掉 query/hash，归一化 .. 与 .，不接受跳出根目录的路径 */
export function normalizePath(path) {
  const raw = String(path || "").split("#")[0].split("?")[0].replace(/\\/g, "/");
  const out = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** base 是文件路径（不是目录），target 相对它解析 */
export function resolvePath(base, target) {
  const link = String(target || "").split("#")[0].split("?")[0];
  if (!link) return normalizePath(base);
  if (link.startsWith("/")) return normalizePath(link);
  const dir = String(base || "").includes("/") ? String(base).slice(0, String(base).lastIndexOf("/")) : "";
  return normalizePath(dir ? dir + "/" + link : link);
}

export function dirname(path) {
  const p = String(path || "");
  return p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
}

/** 换成 .xhtml 扩展名，让浏览器按 XHTML 命名空间解析，避免自闭合 <script/> 之类被吞掉 */
export function toXhtmlName(path) {
  return String(path || "").replace(/\.(x?html?|xhtm)$/i, "") + ".xhtml";
}

/* ---------------- ZIP ---------------- */

async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("当前浏览器不支持 DecompressionStream，无法解压 EPUB");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function findEndOfCentralDirectory(view, length) {
  const min = Math.max(0, length - 66000);
  for (let i = length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  return -1;
}

function zipErrorMessage(code, name) {
  if (code === 1) return "EPUB 压缩包已损坏: " + name;
  if (code === 3) return "EPUB 使用了不支持的压缩方式: " + name;
  return "EPUB 解压失败 (" + code + "): " + name;
}

/**
 * 读取 ZIP 目录，返回 [{ name, size, compressedSize, method, offset, read() }]
 */
export function readZipEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view, bytes.byteLength);
  if (eocd < 0) throw new Error("不是有效的 EPUB（找不到 ZIP 结尾标记）");

  let count = view.getUint16(eocd + 10, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  // ZIP64：0xffffffff 时去 ZIP64 EOCD 记录里取真实值
  if (centralOffset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x07064b50) {
        const zip64 = Number(view.getBigUint64(i + 8, true));
        if (view.getUint32(zip64, true) === 0x06064b50) {
          count = Number(view.getBigUint64(zip64 + 32, true));
          centralOffset = Number(view.getBigUint64(zip64 + 48, true));
        }
        break;
      }
    }
  }

  const entries = [];
  let cursor = centralOffset;
  const decoder = new TextDecoder("utf-8");

  for (let i = 0; i < count; i += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== 0x02014b50) break;
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    let size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    let localOffset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const extraStart = cursor + 46 + nameLength;

    // ZIP64 扩展字段
    if (size === 0xffffffff || localOffset === 0xffffffff) {
      let p = extraStart;
      const extraEnd = extraStart + extraLength;
      while (p + 4 <= extraEnd) {
        const id = view.getUint16(p, true);
        const len = view.getUint16(p + 2, true);
        if (id === 0x0001) {
          let q = p + 4;
          if (size === 0xffffffff) {
            size = Number(view.getBigUint64(q, true));
            q += 8;
          }
          if (localOffset === 0xffffffff) localOffset = Number(view.getBigUint64(q, true));
          break;
        }
        p += 4 + len;
      }
    }

    entries.push({
      name,
      method,
      size,
      compressedSize,
      offset: localOffset,
      read: () => {
        if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error("ZIP 本地头损坏: " + name);
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = bytes.subarray(start, start + (compressedSize || size));
        if (method === 0) return Promise.resolve(raw);
        if (method === 8) return inflateRaw(raw);
        throw new Error(zipErrorMessage(method, name));
      },
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  if (!entries.length) throw new Error("EPUB 压缩包是空的");
  return entries;
}

/* ---------------- XML ---------------- */

function parseXml(text, label) {
  const doc = new DOMParser().parseFromString(String(text || ""), "application/xml");
  const error = doc.querySelector("parsererror");
  if (error) throw new Error((label || "XML") + " 解析失败");
  return doc;
}

function firstByLocalName(doc, name) {
  const all = doc.getElementsByTagName("*");
  for (const node of all) if (node.localName === name) return node;
  return null;
}

function allByLocalName(root, name) {
  const out = [];
  if (!root) return out;
  const all = root.getElementsByTagName("*");
  for (const node of all) if (node.localName === name) out.push(node);
  return out;
}

/* ---------------- 目录（TOC） ---------------- */

/** NAV/NCX 里的链接可能只有片段，需要相对当前文档解析 */
function resolveHref(fromPath, href) {
  const link = String(href || "").trim();
  if (!link) return null;
  const hashIndex = link.indexOf("#");
  const fragment = hashIndex >= 0 ? link.slice(hashIndex + 1) : "";
  const path = resolvePath(fromPath, link);
  return { path, fragment };
}

function parseNavToc(doc, navPath, manifestMap) {
  const navs = allByLocalName(doc, "nav");
  let target = null;
  for (const nav of navs) {
    const type = nav.getAttribute("epub:type") || nav.getAttribute("type") || "";
    if (String(type).includes("toc")) {
      target = nav;
      break;
    }
  }
  if (!target && navs.length) target = navs[0];
  if (!target) return [];

  const items = [];
  const walk = (list, depth) => {
    if (!list || depth > 6) return;
    for (const li of Array.from(list.children || [])) {
      if (li.localName !== "li") continue;
      let anchor = null;
      for (const child of Array.from(li.children || [])) {
        if (child.localName === "a" || child.localName === "span") {
          anchor = child;
          break;
        }
      }
      if (anchor && anchor.localName === "a") {
        const label = decodeEntities(anchor.textContent || "").replace(/\s+/g, " ").trim();
        const linked = resolveHref(navPath, anchor.getAttribute("href"));
        if (label && linked) items.push({ label: label.slice(0, 160), path: linked.path, fragment: linked.fragment, depth });
      }
      for (const child of Array.from(li.children || [])) {
        if (child.localName === "ol" || child.localName === "ul") walk(child, depth + 1);
      }
    }
  };
  for (const child of Array.from(target.children || [])) {
    if (child.localName === "ol" || child.localName === "ul") walk(child, 0);
  }
  return items.filter((item) => !manifestMap || manifestMap.has(item.path) || item.path === navPath);
}

function parseNcxToc(doc, ncxPath, manifestMap) {
  const navPoints = allByLocalName(doc, "navPoint");
  const items = [];
  for (const point of navPoints) {
    const labelNode = allByLocalName(point, "navLabel")[0];
    const contentNode = allByLocalName(point, "content")[0];
    if (!contentNode) continue;
    const label = decodeEntities(labelNode ? labelNode.textContent : "").replace(/\s+/g, " ").trim();
    const linked = resolveHref(ncxPath, contentNode.getAttribute("src"));
    if (!label || !linked) continue;
    items.push({ label: label.slice(0, 160), path: linked.path, fragment: linked.fragment, depth: 0 });
  }
  return items.filter((item) => !manifestMap || manifestMap.has(item.path));
}

/* ---------------- OPF ---------------- */

/** manifest item 的 href 是相对 OPF 的 */
function manifestHref(opfPath, href) {
  return resolvePath(opfPath, href);
}

function readMetadata(opfDoc) {
  const meta = { title: "", creator: "", publisher: "", language: "", date: "", description: "", identifier: "", subjects: [] };
  const text = (name) => {
    const node = firstByLocalName(opfDoc, name);
    return node ? decodeEntities(node.textContent || "").replace(/\s+/g, " ").trim() : "";
  };
  meta.title = text("title");
  meta.creator = text("creator");
  meta.publisher = text("publisher");
  meta.language = text("language");
  meta.date = text("date");
  meta.description = text("description");
  meta.identifier = text("identifier");
  for (const subject of allByLocalName(opfDoc, "subject")) {
    const value = decodeEntities(subject.textContent || "").replace(/\s+/g, " ").trim();
    if (value) meta.subjects.push(value);
  }
  return meta;
}

function findCoverId(opfDoc) {
  for (const meta of allByLocalName(opfDoc, "meta")) {
    if ((meta.getAttribute("name") || "").toLowerCase() === "cover") return meta.getAttribute("content") || "";
  }
  return "";
}

/* ---------------- 主入口 ---------------- */

/**
 * 解析一份 EPUB。
 * @param {ArrayBuffer|Uint8Array} buffer 原始 .epub 字节
 * @param {(loaded:number,total:number)=>void} [onProgress]
 * @returns {Promise<{metadata, coverUrl, chapters, toc, resources, revoke}>}
 */
export async function openEpub(buffer, onProgress) {
  const entries = readZipEntries(buffer);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));

  const containerEntry = byName.get("META-INF/container.xml");
  if (!containerEntry) throw new Error("不是有效的 EPUB（缺少 META-INF/container.xml）");
  const containerDoc = parseXml(new TextDecoder("utf-8").decode(await containerEntry.read()), "container.xml");
  const rootfile = firstByLocalName(containerDoc, "rootfile");
  const opfPath = normalizePath((rootfile && rootfile.getAttribute("full-path")) || "");
  if (!opfPath) throw new Error("EPUB 缺少 OPF 包文档");

  const opfEntry = byName.get(opfPath);
  if (!opfEntry) throw new Error("EPUB 缺少 OPF 文件: " + opfPath);
  const opfText = new TextDecoder("utf-8").decode(await opfEntry.read());
  const opfDoc = parseXml(opfText, "OPF");

  const metadata = readMetadata(opfDoc);
  const version = (firstByLocalName(opfDoc, "package") || { getAttribute: () => "" }).getAttribute("version") || "2.0";

  // manifest
  const manifest = new Map();
  for (const item of allByLocalName(opfDoc, "item")) {
    const id = item.getAttribute("id") || "";
    const href = item.getAttribute("href") || "";
    if (!id || !href) continue;
    const path = manifestHref(opfPath, href);
    manifest.set(id, {
      id,
      path,
      mediaType: item.getAttribute("media-type") || mimeForPath(path),
      properties: item.getAttribute("properties") || "",
    });
  }

  // spine
  const chapters = [];
  const spineIds = new Set();
  const spineNode = firstByLocalName(opfDoc, "spine");
  for (const itemref of allByLocalName(spineNode, "itemref")) {
    const idref = itemref.getAttribute("idref") || "";
    const item = manifest.get(idref);
    if (!item || spineIds.has(idref)) continue;
    spineIds.add(idref);
    chapters.push({
      index: chapters.length,
      id: item.id,
      path: item.path,
      name: item.path.split("/").pop(),
      linear: (itemref.getAttribute("linear") || "yes").toLowerCase() !== "no",
    });
  }
  if (!chapters.length) throw new Error("这本 EPUB 没有可阅读的正文章节");

  // 目录：EPUB 3 nav -> EPUB 2 NCX
  let toc = [];
  const navItem = [...manifest.values()].find((item) => String(item.properties).split(/\s+/).includes("nav"));
  if (navItem && byName.has(navItem.path)) {
    try {
      const navDoc = parseXml(new TextDecoder("utf-8").decode(await byName.get(navItem.path).read()), "nav.xhtml");
      toc = parseNavToc(navDoc, navItem.path, manifest_pathSet(manifest));
    } catch {
      toc = [];
    }
  }
  if (!toc.length) {
    const spineElement = firstByLocalName(opfDoc, "spine");
    const tocId = spineElement ? spineElement.getAttribute("toc") : "";
    const ncxItem = (tocId && manifest.get(tocId)) || [...manifest.values()].find((item) => /ncx/i.test(item.mediaType) || /\.ncx$/i.test(item.path));
    if (ncxItem && byName.has(ncxItem.path)) {
      try {
        const ncxDoc = parseXml(new TextDecoder("utf-8").decode(await byName.get(ncxItem.path).read()), "NCX");
        toc = parseNcxToc(ncxDoc, ncxItem.path, manifest_pathSet(manifest));
      } catch {
        toc = [];
      }
    }
  }
  if (!toc.length) {
    toc = chapters.map((chapter) => ({ label: chapter.name, path: chapter.path, fragment: "", depth: 0 }));
  }
  // 把目录条目挂到 spine 序号上；指向非正文的条目丢掉
  const chapterIndexByPath = new Map(chapters.map((chapter) => [chapter.path, chapter.index]));
  toc = toc
    .map((item) => ({ ...item, chapter: chapterIndexByPath.has(item.path) ? chapterIndexByPath.get(item.path) : -1 }))
    .filter((item) => item.chapter >= 0);

  // 只解码正文会引用到的资源：正文 / 样式 / 字体 / 图片 / 音视频
  const wanted = new Set();
  for (const chapter of chapters) wanted.add(chapter.path);
  for (const item of manifest.values()) {
    if (/^text\/css|^font\/|^image\/|^audio\/|^video\/|application\/font/.test(item.mediaType)) wanted.add(item.path);
  }
  for (const href of extractStylesheetHrefs(opfDoc, opfPath)) wanted.add(href);

  const resources = new Map();
  const total = wanted.size;
  let loaded = 0;
  for (const path of wanted) {
    const entry = byName.get(path);
    if (!entry) {
      loaded += 1;
      continue;
    }
    try {
      const data = await entry.read();
      resources.set(path, { name: path, url: URL.createObjectURL(new Blob([data], { type: mimeForPath(path) })) });
    } catch {
      // 单个资源失败不影响整本书
    }
    loaded += 1;
    if (onProgress) onProgress(loaded, total);
  }

  // 正文改成 .xhtml 命名，并把图片/样式等相对路径换成 Blob URL。
  // Blob URL 没有目录概念，留着 "../images/x.png" 会解析失败，图片就显示不出来。
  for (const path of wanted) {
    const resource = resources.get(path);
    if (!resource || !/x?html?$/i.test(path)) continue;
    try {
      const raw = fixNamedEntities(new TextDecoder("utf-8").decode(await byName.get(path).read()));
      const rewritten = rewriteChapterAssets(raw, path, resources);
      URL.revokeObjectURL(resource.url);
      resource.name = toXhtmlName(path);
      resource.url = URL.createObjectURL(new Blob([rewritten], { type: "application/xhtml+xml" }));
    } catch {
      // 改写失败就保留原始字节
    }
  }

  // 封面：EPUB 3 cover-image -> <meta name="cover"> -> 第一张图
  let coverUrl = "";
  const coverItem =
    [...manifest.values()].find((item) => String(item.properties).split(/\s+/).includes("cover-image")) ||
    (() => {
      const id = findCoverId(opfDoc);
      return id ? manifest.get(id) : null;
    })();
  if (coverItem && resources.has(coverItem.path)) coverUrl = resources.get(coverItem.path).url;
  if (!coverUrl) {
    const fallback = [...manifest.values()].find((item) => /^image\//.test(item.mediaType) && resources.has(item.path));
    if (fallback) coverUrl = resources.get(fallback.path).url;
  }

  return {
    version,
    metadata,
    coverUrl,
    chapters,
    toc,
    resources,
    /** 释放所有 Blob URL */
    revoke() {
      for (const resource of resources.values()) URL.revokeObjectURL(resource.url);
      resources.clear();
    },
  };
}

/* XML 只预定义了 amp/lt/gt/quot/apos，XHTML 里常见的 &nbsp; &mdash; 之类
   会让浏览器直接报 "Entity not defined" 并中断渲染。
   这里把 HTML 命名实体换成数字实体（数字实体在 XML 里始终合法）。 */
const NAMED_HTML_ENTITIES = {
  nbsp: "&#160;", iexcl: "&#161;", cent: "&#162;", pound: "&#163;", curren: "&#164;",
  yen: "&#165;", brvbar: "&#166;", sect: "&#167;", uml: "&#168;", copy: "&#169;",
  ordf: "&#170;", laquo: "&#171;", not: "&#172;", shy: "&#173;", reg: "&#174;",
  macr: "&#175;", deg: "&#176;", plusmn: "&#177;", sup2: "&#178;", sup3: "&#179;",
  acute: "&#180;", micro: "&#181;", para: "&#182;", middot: "&#183;", cedil: "&#184;",
  sup1: "&#185;", ordm: "&#186;", raquo: "&#187;", frac14: "&#188;", frac12: "&#189;",
  frac34: "&#190;", iquest: "&#191;", times: "&#215;", divide: "&#247;",
  ndash: "&#8211;", mdash: "&#8212;", lsquo: "&#8216;", rsquo: "&#8217;",
  sbquo: "&#8218;", ldquo: "&#8220;", rdquo: "&#8221;", bdquo: "&#8222;",
  dagger: "&#8224;", Dagger: "&#8225;", bull: "&#8226;", hellip: "&#8230;",
  permil: "&#8240;", prime: "&#8242;", Prime: "&#8243;", lsaquo: "&#8249;",
  rsaquo: "&#8250;", oline: "&#8254;", frasl: "&#8260;", euro: "&#8364;",
  trade: "&#8482;", larr: "&#8592;", uarr: "&#8593;", rarr: "&#8594;",
  darr: "&#8595;", harr: "&#8596;", minus: "&#8722;", lowast: "&#8727;",
  radic: "&#8730;", infin: "&#8734;", ne: "&#8800;", le: "&#8804;", ge: "&#8805;",
  loz: "&#9674;", spades: "&#9824;", clubs: "&#9827;", hearts: "&#9829;", diams: "&#9830;",
};

function fixNamedEntities(markup) {
  return String(markup).replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => {
    if (name === "amp" || name === "lt" || name === "gt" || name === "quot" || name === "apos") return match;
    const numeric = NAMED_HTML_ENTITIES[name];
    return numeric === undefined ? match : numeric;
  });
}

/**
 * 把章节里指向书内资源的相对路径替换成已经创建好的 Blob URL。
 * 外链（http/https/data/blob/mailto）和纯片段链接保持原样。
 * 注意：正则必须在函数内新建，带 /g 的常量正则会记住 lastIndex，
 * 连续调用会从错误的位置开始匹配，把正文改坏。
 */
function rewriteChapterAssets(markup, chapterPath, resources) {
  const assetAttr = /(\s(?:src|href|poster)\s*=\s*)(["'])([^"']*)\2/gi;
  return String(markup).replace(assetAttr, (match, prefix, quote, rawValue) => {
    const value = rawValue.trim();
    if (!value || /^(https?:|data:|blob:|mailto:|tel:|javascript:|#)/i.test(value)) return match;
    const target = resolvePath(chapterPath, value);
    const resource = resources.get(target);
    if (!resource) return match;
    // 保留原链接里的片段，方便章节内锚点继续工作
    const hashIndex = value.indexOf("#");
    const fragment = hashIndex >= 0 ? value.slice(hashIndex) : "";
    return prefix + quote + resource.url + fragment + quote;
  });
}

function manifest_pathSet(manifest) {
  return new Set([...manifest.values()].map((item) => item.path));
}

/** OPF 里可能通过 <?xml-stylesheet?> 引用样式，尽量带上 */
function extractStylesheetHrefs(opfDoc, opfPath) {
  const out = [];
  const walk = (node) => {
    for (const child of Array.from(node.childNodes || [])) {
      if (child.nodeType === 7 && /xml-stylesheet/i.test(child.nodeValue || "")) {
        const match = /href\s*=\s*["']([^"']+)["']/i.exec(child.nodeValue || "");
        if (match) out.push(resolvePath(opfPath, match[1]));
      }
      if (child.nodeType === 1) walk(child);
    }
  };
  walk(opfDoc);
  return out;
}
