// Copies the docs' screenshots (docs/guide/img) into public/img, where the site serves them. Runs before dev and build.
import fs from "node:fs";
import path from "node:path";

const from = path.resolve(import.meta.dirname, "../../../docs/guide/img");
const to = path.resolve(import.meta.dirname, "../public/img");
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
