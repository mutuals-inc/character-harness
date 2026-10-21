import { defineConfig } from "vite";
export default defineConfig({
  root: import.meta.dirname,
  build: {
    // The WebGL renderer is a shared vendor chunk (~155 kB compressed).
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes("node_modules/three/")
            ? "three"
            : id.includes("node_modules/@pixiv/")
              ? "vrm"
              : undefined,
      },
    },
  },
});
