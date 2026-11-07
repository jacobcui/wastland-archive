/**
 * Canvas page-curl renderer.
 *
 * The leaf is modelled as a cylindrical sheet: at arc position s (0 = hinge,
 * W = free edge) the tangent angle is theta + bend * s / W. Integrating the
 * tangent gives the 3D position of every column, then a simple perspective
 * projection (camera distance) turns that into screen space. Each column is
 * drawn with drawImage, so the page really bends instead of rotating rigidly.
 */

export function makePaperTexture(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(120, Math.round(width * 0.5));
  canvas.height = Math.max(160, Math.round(height * 0.5));
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  const base = ctx.createLinearGradient(0, 0, w, h);
  base.addColorStop(0, "#bcb097");
  base.addColorStop(0.55, "#9d9179");
  base.addColorStop(1, "#7d725d");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, w, h);

  // fine grain instead of straight fibres (vertical lines band badly once the
  // texture is sliced into curl columns)
  const noise = document.createElement("canvas");
  noise.width = 140;
  noise.height = 180;
  const nctx = noise.getContext("2d");
  const grain = nctx.createImageData(noise.width, noise.height);
  for (let i = 0; i < grain.data.length; i += 4) {
    const v = 128 + (Math.random() - 0.5) * 70;
    grain.data[i] = v;
    grain.data[i + 1] = v;
    grain.data[i + 2] = v;
    grain.data[i + 3] = 255;
  }
  nctx.putImageData(grain, 0, 0);
  ctx.save();
  ctx.globalAlpha = 0.16;
  ctx.globalCompositeOperation = "overlay";
  ctx.drawImage(noise, 0, 0, w, h);
  ctx.restore();

  // soft edge shading
  const edge = ctx.createLinearGradient(0, 0, w, 0);
  edge.addColorStop(0, "rgba(0,0,0,0.28)");
  edge.addColorStop(0.18, "rgba(0,0,0,0)");
  edge.addColorStop(0.82, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,0.18)");
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, w, h);

  // letterpress watermark
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.fillStyle = "rgba(59,53,41,0.45)";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const size = Math.max(11, Math.round(w * 0.052));
  ctx.font = size + "px ui-monospace, Menlo, monospace";
  ctx.fillText("M K X   A R C H I V E", 0, 0);
  ctx.font = Math.round(size * 0.62) + "px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "rgba(59,53,41,0.3)";
  ctx.fillText("L O C A L   C O P Y", 0, size * 1.6);
  ctx.restore();

  return canvas;
}

const imageCache = new Map();

export function preloadImage(url) {
  if (!url) return null;
  let entry = imageCache.get(url);
  if (!entry) {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    entry = { img, ready: false, callbacks: [] };
    img.onload = () => {
      entry.ready = true;
      entry.callbacks.forEach((cb) => cb());
      entry.callbacks = [];
    };
    imageCache.set(url, entry);
  }
  return entry;
}

export function getImage(url) {
  const entry = preloadImage(url);
  return entry && entry.ready ? entry.img : null;
}

/* Pre-scaled copies of the page images. Slicing a 2500px-wide page into
 * 4px columns aliases badly ("streaks"); slicing a ~1.8x display-size copy
 * is both smoother and cheaper. */
const sourceCache = new Map();
const SOURCE_CACHE_MAX = 8;

export function getLeafSource(url, targetWidth, dpr = 1) {
  const img = getImage(url);
  if (!img) return null;
  const width = Math.max(360, Math.min(1800, Math.round(targetWidth * Math.max(1, dpr) * 1.05)));
  const key = url + "@" + width;
  const cached = sourceCache.get(key);
  if (cached) {
    sourceCache.delete(key);
    sourceCache.set(key, cached);
    return cached;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = Math.round(width * (img.naturalHeight / img.naturalWidth)) || width;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  sourceCache.set(key, canvas);
  while (sourceCache.size > SOURCE_CACHE_MAX) {
    const oldest = sourceCache.keys().next().value;
    sourceCache.delete(oldest);
  }
  return canvas;
}

export function onImageReady(url, callback) {
  const entry = preloadImage(url);
  if (!entry) return;
  if (entry.ready) callback();
  else entry.callbacks.push(callback);
}

/**
 * Draw one curled leaf onto ctx. All coordinates are CSS pixels; the caller is
 * expected to have applied a devicePixelRatio transform.
 */
export function renderLeaf(ctx, options) {
  const {
    W,
    H,
    hingeX,
    dir,
    theta,
    bend,
    front,
    back,
    centerX,
    centerY,
    columns = 120,
    camera,
  } = options;

  if (!front) return;
  const cam = camera || Math.max(W * 3.1, 1600);
  const ds = W / columns;

  // integrate the sheet centreline: position after every 1/columns slice
  const xs = new Float32Array(columns + 1);
  const zs = new Float32Array(columns + 1);
  let x = 0;
  let z = 0;
  // curl is concentrated near the free edge: the body of the page stays almost
  // straight, the leading edge rolls over like paper.
  const curlAt = (u) => theta + bend * u * u;
  for (let i = 0; i < columns; i += 1) {
    const th = curlAt((i + 0.5) / columns);
    x += ds * Math.cos(th);
    z += ds * Math.sin(th);
    xs[i + 1] = x;
    zs[i + 1] = z;
  }

  // project every shared edge once so neighbouring slices tile exactly
  const sx = new Float32Array(columns + 1);
  const sc = new Float32Array(columns + 1);
  for (let i = 0; i <= columns; i += 1) {
    const scale = cam / Math.max(1, cam - zs[i]);
    const worldX = hingeX + dir * xs[i];
    sx[i] = centerX + (worldX - centerX) * scale;
    sc[i] = scale;
  }

  for (let i = 0; i < columns; i += 1) {
    const left = Math.min(sx[i], sx[i + 1]);
    const width = Math.abs(sx[i + 1] - sx[i]);
    if (width < 0.25) continue;

    const s = i * ds;
    const thMid = curlAt((i + 0.5) / columns);
    const scale = (sc[i] + sc[i + 1]) / 2;
    const height = H * scale;
    const top = centerY - centerY * scale;

    const isFront = Math.cos(thMid) >= 0;

    // mirror the texture when the sheet is seen from behind / anchored right
    const mapFor = (frontFace) => (u) => {
      if (dir > 0) return frontFace ? u : W - u;
      return frontFace ? W - u : u;
    };

    const drawSlice = (image, frontFace, alpha = 1) => {
      if (!image) return;
      const iw = image.naturalWidth || image.width;
      const ih = image.naturalHeight || image.height;
      const mapU = mapFor(frontFace);
      const a = mapU(s);
      const b = mapU(s + ds);
      const srcX = (Math.min(a, b) / W) * iw;
      const srcW = Math.max(0.5, (Math.abs(b - a) / W) * iw);
      if (alpha < 1) ctx.globalAlpha = alpha;
      ctx.drawImage(image, srcX, 0, srcW, ih, left - 0.7, top, width + 1.4, height);
      if (alpha < 1) ctx.globalAlpha = 1;
    };

    // Almost edge-on slices alias into streaks; paint them as flat shading
    // instead (this is also what a real page looks like at that angle).
    const edgeOn = Math.abs(Math.cos(thMid)) < 0.22;
    if (edgeOn) {
      ctx.fillStyle = isFront ? "#0e0c0a" : "#6d6350";
      ctx.fillRect(left, top, width + 0.6, height);
    } else if (isFront) {
      drawSlice(front, true);
    } else {
      drawSlice(back, false);
      // ink from the printed side ghosting through the paper
      drawSlice(front, true, 0.1);
    }

    // light falling off as the sheet turns edge-on + crease shadow near the spine
    const crease = 0.22 * Math.exp(-(i / columns) * 5.5);
    const shade = Math.min(0.8, 0.55 * (1 - Math.abs(Math.cos(thMid))) + crease);
    if (shade > 0.01) {
      ctx.globalAlpha = shade;
      ctx.fillStyle = "#050403";
      ctx.fillRect(left, top, width + 0.6, height);
      ctx.globalAlpha = 1;
    }

    // soft sheen riding the outer curl
    const sheen = Math.max(0, Math.cos(thMid - 0.9)) * 0.05;
    if (sheen > 0.005) {
      ctx.globalAlpha = sheen;
      ctx.fillStyle = "#fff6e2";
      ctx.fillRect(left, top, width + 0.6, height);
      ctx.globalAlpha = 1;
    }
  }
}

