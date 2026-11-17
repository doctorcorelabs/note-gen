// Modified for the web fork on 2026-11-14; see FORK.md.
import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === 'production';
const internalHost = process.env.TAURI_DEV_HOST || 'localhost';

const withNextIntl = createNextIntlPlugin();

const nextConfig: NextConfig = {
  /* config options here */
  output: "export",
  images: {
    unoptimized: true,
  },
  assetPrefix: isProd ? undefined : `http://${internalHost}:3456`,
  sassOptions: {
    silenceDeprecations: ['legacy-js-api'],
  },
  reactStrictMode: false,
  turbopack: {
    // POC (Fase 0, W12): Turbopack module alias that replaces the Tauri
    // api/app module with a minimal web shim so the app can boot in a
    // plain browser without Tauri IPC. This alias is a POC shortcut
    // only; Fase 1 replaces it with the central adapter registry
    // from design F1. The alias target is a relative path, the same form
    // the next-intl plugin uses for its own Turbopack alias below.
    resolveAlias: {
      '@tauri-apps/api/app': './src/lib/platform/poc-app-shim.ts',
    },
  },
  devIndicators: false,
};

const configuredNext = withNextIntl(nextConfig);

// next-intl 3.x still injects its Turbopack alias through the deprecated
// experimental.turbo key. Normalize the plugin output for Next.js 15.3.
const legacyTurbo = configuredNext.experimental?.turbo;
if (legacyTurbo) {
  // Merge resolveAlias maps explicitly: a shallow spread would drop the
  // next-intl alias (or the POC aliases) when both sides define the key.
  configuredNext.turbopack = {
    ...legacyTurbo,
    ...configuredNext.turbopack,
    resolveAlias: {
      ...legacyTurbo.resolveAlias,
      ...configuredNext.turbopack?.resolveAlias,
    },
  };
  if (configuredNext.experimental) delete configuredNext.experimental.turbo;
}

export default configuredNext;
