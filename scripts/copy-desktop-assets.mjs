import { cp, rm } from "node:fs/promises";

await cp("src/desktop/renderer", "dist/src/desktop/renderer", { recursive: true });
await rm("dist/src/desktop/preload.js", { force: true });
