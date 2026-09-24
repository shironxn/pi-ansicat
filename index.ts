// Entry point. pi derives the extension's display name from this file's
// path, so keeping it at the package root (instead of src/index.ts) makes the
// extension show up as "pi-ansicat" rather than "src".
export { default, registerAnsiCat } from "./src/index.js";
