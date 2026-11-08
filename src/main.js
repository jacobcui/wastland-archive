import { createApp } from "vue";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";
import "vuetify/styles";
import "@mdi/font/css/materialdesignicons.css";
import App from "./App.vue";
import { purgeLegacyMediaCache } from "./lib/idb";
import "./lib/platform";
import "./styles/wasteland.css";

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: "wasteland",
    themes: {
      wasteland: {
        dark: true,
        colors: {
          background: "#0a0907",
          surface: "#14110d",
          "surface-bright": "#1d1913",
          "surface-light": "#241f18",
          primary: "#ffb000",
          "primary-darken-1": "#c98600",
          secondary: "#9ecb3b",
          "secondary-darken-1": "#74a01f",
          accent: "#c2542a",
          error: "#e0412d",
          info: "#7fa08c",
          success: "#9ecb3b",
          warning: "#e8a33d",
          "on-background": "#ded4c2",
          "on-surface": "#ded4c2",
          "on-primary": "#16120b",
          "on-secondary": "#12160a",
        },
      },
    },
  },
  defaults: {
    VBtn: { rounded: 0, variant: "flat", density: "comfortable" },
    VCard: { rounded: 0, flat: true },
    VTextField: { variant: "outlined", density: "compact", rounded: 0, hideDetails: "auto" },
    VChip: { rounded: 0, size: "small" },
    VDialog: { scrim: "#050403" },
  },
});

createApp(App).use(vuetify).mount("#app");
purgeLegacyMediaCache();
