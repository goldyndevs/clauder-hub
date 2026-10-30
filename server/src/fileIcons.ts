import fs from "node:fs";
import nodeModule from "node:module";
import path from "node:path";

/**
 * File and folder icons for the Files tab, from the Material Icon Theme (MIT)
 * that VS Code users know. The page gets only the name-to-icon tables, and
 * fetches each icon as it shows one.
 */
// Named apart from the bundle's own createRequire/require banner.
const resolveFrom = nodeModule.createRequire(import.meta.url);
const root = path.dirname(resolveFrom.resolve("material-icon-theme/package.json"));
export const iconsDir = path.join(root, "icons");

interface Manifest {
  file: string;
  folder: string;
  folderExpanded: string;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
}

let manifest: Manifest | null = null;

export function iconManifest(): Manifest {
  if (!manifest) {
    const full = JSON.parse(fs.readFileSync(path.join(root, "dist", "material-icons.json"), "utf8")) as Manifest;
    manifest = {
      file: full.file,
      folder: full.folder,
      folderExpanded: full.folderExpanded,
      fileExtensions: full.fileExtensions,
      fileNames: full.fileNames,
      folderNames: full.folderNames,
      folderNamesExpanded: full.folderNamesExpanded,
    };
  }
  return manifest;
}

/** The icon's file, or null for a name that is not one. */
export function iconFile(name: string): string | null {
  if (!/^[\w.-]+$/.test(name)) return null;
  const file = path.join(iconsDir, `${name}.svg`);
  return fs.existsSync(file) ? file : null;
}
