import { FFmpeg } from "@ffmpeg/ffmpeg";

let instance = null;
let loading = null;

export function decoderAvailable() {
  return typeof WebAssembly === "object";
}

export async function loadMediaDecoder({ onStatus } = {}) {
  if (instance) return instance;
  if (loading) return loading;
  if (!decoderAvailable()) throw new Error("当前浏览器不支持 WebAssembly 解码器");
  loading = (async () => {
    onStatus && onStatus("加载内置解码器…");
    const decoder = new FFmpeg();
    const base = new URL("/vendor/ffmpeg/", window.location.origin).href;
    await decoder.load({
      coreURL: base + "ffmpeg-core.js",
      wasmURL: base + "ffmpeg-core.wasm",
    });
    instance = decoder;
    return decoder;
  })().catch((error) => {
    loading = null;
    throw new Error("内置解码器加载失败: " + error.message);
  });
  return loading;
}

function extensionOf(name) {
  const text = String(name || "");
  const index = text.lastIndexOf(".");
  return index >= 0 ? text.slice(index + 1).toLowerCase() : "";
}

/**
 * Shared fallback decoder. Converts an unsupported local media file into
 * browser-playable H.264/AAC MP4 (video) or AAC/M4A (audio) using a lazily
 * loaded ffmpeg.wasm core. Other plugins can import this module too.
 */
export async function transcodeMedia({ data, name, kind = "video", onProgress, onStatus } = {}) {
  if (!data) throw new Error("没有可解码的媒体数据");
  const ffmpeg = await loadMediaDecoder({ onStatus });
  const inputName = "input." + (extensionOf(name) || (kind === "audio" ? "dat" : "dat"));
  const outputName = kind === "audio" ? "output.m4a" : "output.mp4";
  const onEvent = ({ progress }) => {
    if (onProgress && Number.isFinite(progress)) onProgress(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on("progress", onEvent);
  try {
    onStatus && onStatus("写入媒体数据…");
    await ffmpeg.writeFile(inputName, new Uint8Array(data));
    onStatus && onStatus(kind === "audio" ? "转码音频…" : "转码视频…");
    const args =
      kind === "audio"
        ? ["-i", inputName, "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", outputName]
        : [
            "-i",
            inputName,
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            outputName,
          ];
    const code = await ffmpeg.exec(args);
    if (code !== 0) throw new Error("解码器返回错误码 " + code);
    onStatus && onStatus("读取转码结果…");
    const output = await ffmpeg.readFile(outputName);
    const bytes = output instanceof Uint8Array ? output : new TextEncoder().encode(String(output));
    return new Blob([bytes], { type: kind === "audio" ? "audio/mp4" : "video/mp4" });
  } finally {
    ffmpeg.off("progress", onEvent);
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
