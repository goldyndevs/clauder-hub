import { File, Folder, FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

/** The name-to-icon tables of the Material Icon Theme, served by the hub for every project (server/src/fileIcons.ts). */
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
// Fetched once for the whole page; a failure leaves the plain icons.
const loading = fetch("/api/file-icons/manifest")
  .then((response) => (response.ok ? (response.json() as Promise<Manifest>) : null))
  .then((value) => (manifest = value))
  .catch(() => null);

/** As VS Code matches: the full file name, then the longest extension ("d.ts" before "ts"). */
function iconName(table: Manifest, name: string, folder: boolean, open: boolean): string {
  const lower = name.toLowerCase();
  // Own keys only: a file named "constructor" must not find Object's.
  const look = (map: Record<string, string>, key: string) => (Object.hasOwn(map, key) ? map[key] : undefined);
  if (folder) return (open ? look(table.folderNamesExpanded, lower) : look(table.folderNames, lower)) ?? (open ? table.folderExpanded : table.folder);
  const named = look(table.fileNames, lower);
  if (named) return named;
  const parts = lower.split(".");
  for (let at = 1; at < parts.length; at++) {
    const icon = look(table.fileExtensions, parts.slice(at).join("."));
    if (icon) return icon;
  }
  return table.file;
}

export function FileIcon({ name, folder = false, open = false, size = 14, className }: { name: string; folder?: boolean; open?: boolean; size?: number; className?: string }) {
  const [table, setTable] = useState(manifest);
  useEffect(() => {
    if (!table) void loading.then((value) => value && setTable(value));
  }, [table]);

  if (!table) {
    const Plain = folder ? (open ? FolderOpen : Folder) : File;
    return <Plain size={size - 1} className={cn("shrink-0", className)} />;
  }
  return <img src={`/api/file-icons/${iconName(table, name, folder, open)}.svg`} alt="" width={size} height={size} draggable={false} className={cn("shrink-0", className)} />;
}
