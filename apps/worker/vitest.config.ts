import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Tests run inside the Workers runtime, with bindings read from wrangler.jsonc.
//
// `remoteBindings: false` matters. The AI binding has no local emulation, so the pool would
// otherwise open a remote session and every test run would call Workers AI for real — needing
// credentials and spending inference. Unit tests use a fake model and reach no network; the
// product only ever uses the real one.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" }, remoteBindings: false })],
});
