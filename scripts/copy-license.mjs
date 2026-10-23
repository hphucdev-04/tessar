import { copyFileSync } from "node:fs";

// npm packs from the package directory, so include the shared license there.
copyFileSync(new URL("../LICENSE", import.meta.url), "LICENSE");
