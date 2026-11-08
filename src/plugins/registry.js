export const plugins = [
  {
    id: "mkx-archive",
    code: "PLUGIN 01",
    mark: "MKX",
    nameKey: "plugins.mkx.name",
    latin: "MKX ARCHIVE",
    descriptionKey: "plugins.mkx.desc",
    tagKeys: ["plugins.mkx.tag1", "plugins.mkx.tag2", "plugins.mkx.tag3"],
    accent: "#ffb000",
    status: "ready",
    component: () => import("@/plugins/mkx-archive/ArchivePlugin.vue"),
  },
  {
    id: "pdf-reader",
    code: "PLUGIN 02",
    mark: "PDF",
    nameKey: "plugins.pdf.name",
    latin: "PDF READER",
    descriptionKey: "plugins.pdf.desc",
    tagKeys: ["plugins.pdf.tag1", "plugins.pdf.tag2", "plugins.pdf.tag3"],
    accent: "#c2542a",
    status: "ready",
    component: () => import("@/plugins/pdf-reader/PdfReaderPlugin.vue"),
  },
  {
    id: "image-browser",
    code: "PLUGIN 03",
    mark: "IMG",
    nameKey: "plugins.image.name",
    latin: "IMAGE BROWSER",
    descriptionKey: "plugins.image.desc",
    tagKeys: ["plugins.image.tag1", "plugins.image.tag2", "plugins.image.tag3"],
    accent: "#9ecb3b",
    status: "ready",
    component: () => import("@/plugins/image-browser/ImageBrowserPlugin.vue"),
  },
  {
    id: "media-player",
    code: "PLUGIN 04",
    mark: "Media",
    nameKey: "plugins.media.name",
    latin: "MEDIA PLAYER",
    descriptionKey: "plugins.media.desc",
    tagKeys: ["plugins.media.tag1", "plugins.media.tag2", "plugins.media.tag3"],
    accent: "#6ea8fe",
    status: "ready",
    component: () => import("@/plugins/media-player/MediaPlayerPlugin.vue"),
  },
];

export function pluginById(id) {
  return plugins.find((plugin) => plugin.id === id) || null;
}