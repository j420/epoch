/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The SWC minifier cannot be told to skip a single emitted asset, and it dies on
  // onnxruntime-web's pre-minified ESM bundle (see the webpack hook below). Terser
  // accepts an `exclude`, so we minify with Terser and skip that one file.
  swcMinify: false,
  // @huggingface/transformers ships node-only bits that must not be bundled for the browser.
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.alias = { ...config.resolve.alias, sharp$: false, 'onnxruntime-node$': false };
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };

      // onnxruntime-web (pulled in by @huggingface/transformers for the in-browser
      // depth fallback) ships an ALREADY-MINIFIED ESM bundle that uses `import.meta`.
      // Terser parses emitted assets as classic scripts, so it dies with
      // "'import.meta' cannot be used outside of module code" and fails the whole
      // production build — while `next dev` is perfectly happy, which is how this
      // got as far as a merged PR before anyone noticed.
      // The file is already minified, so skipping it costs nothing.
      for (const minimizer of config.optimization?.minimizer ?? []) {
        if (minimizer?.constructor?.name === 'TerserPlugin') {
          minimizer.options = { ...minimizer.options, exclude: /[\\/]ort[.\-@].*\.m?js$/ };
        }
      }
    }
    return config;
  },
  async headers() {
    return [
      {
        // WebGPU depth inference + SharedArrayBuffer-backed ORT threads.
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
      {
        source: '/monuments/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ];
  },
};

export default nextConfig;
