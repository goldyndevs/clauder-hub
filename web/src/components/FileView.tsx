import { Code, ExternalLink, Eye, FileWarning, GitCommitHorizontal, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/cn";
import { isDirty, useAutoSave, useDrafts } from "../lib/fileDrafts";
import { filesApi, FilesError, isHtml, isMarkdown, mediaKind, rawUrl, type Blame } from "../lib/filesApi";
import { currentProjectId } from "../lib/project";
import { useStore } from "../lib/store";
import { useOpenFiles } from "../lib/openFiles";
import { DiffView } from "./FileEditor";
import { PageHeader } from "./Page";
import { Button } from "./ui/Button";
import { Checkbox } from "./ui/Checkbox";
import { CodeEditor } from "./ui/CodeEditor";
import type { EditorBlame } from "./ui/MonacoEditor";
import { Empty } from "./ui/Empty";
import { MarkdownBox } from "./ui/MarkdownBox";

/**
 * An image, a sound or a video, straight from the file. When the Files tab
 * changes something it is reloaded only if this file itself changed, so a
 * video does not restart because another file moved.
 */
function MediaView({ path, kind, tick }: { path: string; kind: "image" | "audio" | "video"; tick: number }) {
  const [failed, setFailed] = useState(false);
  const [mtime, setMtime] = useState(0);
  useEffect(() => {
    let stale = false;
    filesApi.stat(path).then(
      (stat) => !stale && setMtime(stat.mtimeMs),
      () => undefined,
    );
    return () => {
      stale = true;
    };
  }, [path, tick]);
  useEffect(() => setFailed(false), [path, mtime]);
  const url = `${rawUrl(path)}?v=${mtime}`;
  if (failed) return <Empty icon={FileWarning} title="The browser cannot show this file." hint="Its format is not one this browser plays or displays." />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto rounded border bg-muted/20 p-3">
      {kind === "image" && <img src={url} alt={path} onError={() => setFailed(true)} className="max-h-full max-w-full object-contain" />}
      {kind === "audio" && <audio key={url} controls src={url} onError={() => setFailed(true)} className="w-full max-w-xl" />}
      {kind === "video" && <video key={url} controls src={url} onError={() => setFailed(true)} className="max-h-full max-w-full" />}
    </div>
  );
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * One project file from the Files tab: markdown in MarkdownBox, anything else
 * in Monaco. Ctrl/Cmd+S or Save writes it. An unsaved draft stays in memory
 * when the view changes.
 *
 * Changes made elsewhere (a Claude session editing the file) are followed the
 * way VS Code does: with no unsaved edits the editor just shows the new
 * content; with unsaved edits nothing is replaced, a bar says the file changed
 * on disk and offers to compare, keep editing or reload, and saving over it
 * still asks first.
 */
const WATCH_MS = 1500;
/** Auto save waits this long after the last keystroke, as VS Code's afterDelay. */
const AUTO_SAVE_MS = 1000;
const FILE_BLAME_KEY = "clauder-hub:file-blame";

function ago(seconds: number): string {
  const days = Math.floor((Date.now() / 1000 - seconds) / 86400);
  if (days < 1) {
    const hours = Math.floor((Date.now() / 1000 - seconds) / 3600);
    return hours < 1 ? "just now" : `${hours} hour${hours > 1 ? "s" : ""} ago`;
  }
  return days < 30 ? `${days} day${days > 1 ? "s" : ""} ago` : new Date(seconds * 1000).toLocaleDateString();
}

const commitMessage = (sha: string) => filesApi.commit(sha).then((commit) => commit.message);
export function FileView({ path }: { path: string }) {
  const draft = useDrafts((state) => state.drafts[path]);
  const { put, drop } = useDrafts.getState();
  const filesTick = useStore((state) => state.ticks.files);
  const [notice, setNotice] = useState<{ kind: "binary" | "too-large"; size: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  /** Seen on disk while there were unsaved edits: changed, or gone. */
  const [disk, setDisk] = useState<{ state: "changed" | "deleted"; content?: string; comparing: boolean } | null>(null);
  const savingRef = useRef(false);
  /** The text whose save failed (not a conflict): auto save leaves it until it is edited again. */
  const failedText = useRef<string | null>(null);
  /** The disk version last seen, and the one "Keep editing" waved off, so the bar only returns for a newer change. */
  const seenMtime = useRef(0);
  const dismissedMtime = useRef(0);
  const dirty = isDirty(draft);
  const media = mediaKind(path);
  const html = isHtml(path);
  const [htmlView, setHtmlView] = useState<"preview" | "code">("preview");
  const [blame, setBlame] = useState<Blame | null>(null);
  const [fileBlame, setFileBlame] = useState(() => {
    try {
      return localStorage.getItem(FILE_BLAME_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleFileBlame = () => {
    const next = !fileBlame;
    setFileBlame(next);
    try {
      localStorage.setItem(FILE_BLAME_KEY, next ? "1" : "0");
    } catch {
      // The choice just does not persist.
    }
  };

  // Blame is for the saved file: fetched again whenever what is on disk changes.
  const savedAt = draft?.mtimeMs;
  useEffect(() => {
    if (savedAt === undefined) return;
    let stale = false;
    filesApi.blame(path).then(
      (result) => !stale && setBlame(result),
      () => !stale && setBlame(null),
    );
    return () => {
      stale = true;
    };
  }, [path, savedAt]);

  // Line numbers only match the blame while the text is what was blamed, so unsaved edits hide it.
  const editorBlame = useMemo<EditorBlame | undefined>(
    () => (blame?.available && !dirty ? { you: blame.you, commits: blame.commits, lines: blame.lines, details: commitMessage } : undefined),
    [blame, dirty],
  );
  const summary = (() => {
    if (!blame?.available) return null;
    const commits = Object.values(blame.commits).filter((commit) => !commit.uncommitted);
    const latest = commits.sort((a, b) => b.time - a.time)[0];
    const authors = new Set(commits.map((commit) => commit.author)).size;
    const uncommitted = Object.values(blame.commits).some((commit) => commit.uncommitted);
    return { latest, authors, uncommitted, you: blame.you };
  })();

  // Read on open, and again when the Files tab changes something, unless there are edits to keep.
  const load = useCallback(
    (force = false) => {
      if (!force && isDirty(useDrafts.getState().drafts[path])) return;
      // Media is shown from its bytes, never read as text.
      if (mediaKind(path)) return;
      const projectId = currentProjectId();
      filesApi.read(path).then(
        (file) => {
          // Read for a project the page has left: its drafts are not this project's.
          if (currentProjectId() !== projectId) return;
          setError(null);
          setConflict(false);
          setDisk(null);
          if (file.kind !== "text") {
            setNotice({ kind: file.kind, size: file.size });
            drop(path);
            return;
          }
          setNotice(null);
          put(path, { text: file.content, base: file.content, mtimeMs: file.mtimeMs });
        },
        (cause: Error) => setError(cause.message),
      );
    },
    [path, put, drop],
  );
  useEffect(() => load(), [load, filesTick]);

  const save = useCallback(
    async (overwrite = false, quiet = false) => {
      const current = useDrafts.getState().drafts[path];
      // The ref, not the state: auto save and Ctrl+S in the same tick must not both write.
      if (!current || savingRef.current) return;
      const projectId = currentProjectId();
      setSaving(true);
      savingRef.current = true;
      try {
        const saved = await filesApi.write(path, current.text, overwrite ? undefined : current.mtimeMs);
        failedText.current = null;
        if (currentProjectId() !== projectId) return;
        // Keystrokes made while it saved stay a draft.
        const latest = useDrafts.getState().drafts[path]?.text ?? current.text;
        put(path, { text: latest, base: current.text, mtimeMs: saved.mtimeMs });
        setConflict(false);
        setDisk(null);
        if (!quiet) useStore.getState().notify("Saved.");
      } catch (cause) {
        if (cause instanceof FilesError && cause.status === 409) setConflict(true);
        else {
          // Auto save waits for the next edit rather than retrying the same failure every second.
          failedText.current = current.text;
          useStore.getState().notify((cause as Error).message, "error");
        }
      } finally {
        setSaving(false);
        savingRef.current = false;
      }
    },
    [path, put],
  );

  // Watch the file while it is open and the page is visible: cheap, a stat each tick.
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const current = useDrafts.getState().drafts[path];
      if (stopped || !current || savingRef.current || document.hidden) return;
      const stat = await filesApi.stat(path).catch(() => null);
      if (!stat || stopped || savingRef.current) return;
      // A save may have finished while the stat was out: compare with the draft as it is now.
      const latest = useDrafts.getState().drafts[path];
      if (!latest) return;
      if (!stat.exists) {
        // -1 stands for "the deletion was waved off".
        if (dismissedMtime.current === -1) return;
        setDisk((now) => (now?.state === "deleted" ? now : { state: "deleted", comparing: false }));
        return;
      }
      if (stat.mtimeMs === latest.mtimeMs) return;
      if (!isDirty(latest)) return load(true);
      seenMtime.current = stat.mtimeMs;
      if (stat.mtimeMs === dismissedMtime.current) return;
      setDisk((now) => (now?.state === "changed" ? now : { state: "changed", comparing: false }));
    };
    const timer = setInterval(() => void tick(), WATCH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [path, load]);

  // Auto save holds off while a bar asks about the disk, so it never overwrites a change made elsewhere.
  const autoSave = useAutoSave((state) => state.on);
  useEffect(() => {
    if (!autoSave || !dirty || conflict || disk || draft?.text === failedText.current) return;
    const timer = window.setTimeout(() => void save(false, true), AUTO_SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, conflict, disk, draft?.text, save]);

  const compare = async () => {
    const file = await filesApi.read(path).catch(() => null);
    if (file?.kind === "text") setDisk({ state: "changed", content: file.content, comparing: true });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (isDirty(useDrafts.getState().drafts[path])) void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [path, save]);

  // Shown files get a tab (the preview tab until kept); the first edit keeps it, as in VS Code.
  useEffect(() => useOpenFiles.getState().show(path), [path]);

  const edit = (text: string) => {
    const current = useDrafts.getState().drafts[path];
    if (current) put(path, { ...current, text });
    useOpenFiles.getState().pin(path);
  };

  const name = path.split("/").pop() ?? path;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "project root";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-3 px-5 pb-3 pt-4">
        <PageHeader
          group="Files"
          title={name}
          description={folder}
          action={
            (media || draft) && (
              <>
                {html && draft && (
                  <Button onClick={() => setHtmlView(htmlView === "preview" ? "code" : "preview")} title={htmlView === "preview" ? "Edit the HTML" : "Show the page"}>
                    {htmlView === "preview" ? <Code size={13} /> : <Eye size={13} />} {htmlView === "preview" ? "Code" : "Preview"}
                  </Button>
                )}
                {(media || html) && (
                  <a href={rawUrl(path)} target="_blank" rel="noreferrer" title="Open in a new browser tab" className="inline-flex items-center rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                    <ExternalLink size={13} />
                  </a>
                )}
                {draft && (
                  <>
                    {dirty && !autoSave && <span className="self-center text-[11px] text-severity-warning">Unsaved, kept while this page is open</span>}
                    <Checkbox
                      label="Auto save"
                      title="For every file: saves 1 second after you stop typing"
                      checked={autoSave}
                      onCheckedChange={(on) => {
                        useAutoSave.getState().set(on);
                        useStore
                          .getState()
                          .notify(on ? "Auto save on: every file saves itself 1 second after you stop typing." : "Auto save off: save with the Save button or Ctrl+S.");
                      }}
                      className="mr-1"
                    />
                    {dirty && <Button onClick={() => put(path, { ...draft, text: draft.base })}>Discard</Button>}
                    <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()} title="Save (Ctrl+S)">
                      <Save size={13} /> {saving ? "Saving..." : "Save"}
                    </Button>
                  </>
                )}
              </>
            )
          }
        />
        {blame && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <GitCommitHorizontal size={13} className="shrink-0" />
            {!blame.available ? (
              <span>{blame.reason}</span>
            ) : (
              <>
                {summary?.latest && (
                  <span className="min-w-0 truncate" title={summary.latest.summary}>
                    Last change: <span className="text-foreground">{summary.latest.author === summary.you ? "You" : summary.latest.author}</span>, {ago(summary.latest.time)} · {summary.latest.summary}
                  </span>
                )}
                <span>
                  {summary?.authors ?? 0} author{summary?.authors === 1 ? "" : "s"}
                </span>
                {summary?.uncommitted && <span className="text-severity-warning">uncommitted changes</span>}
                {dirty && <span>blame hidden while editing</span>}
                <button className={cn("ml-auto rounded px-1.5 py-0.5 transition-colors", fileBlame ? "bg-primary/15 text-primary" : "hover:bg-muted hover:text-foreground")} onClick={toggleFileBlame} title="Show who last changed every line">
                  File blame {fileBlame ? "on" : "off"}
                </button>
              </>
            )}
          </div>
        )}
        {disk && !conflict && (
          <div className="space-y-2 rounded-md border border-severity-warning/50 bg-severity-warning/10 px-3 py-2 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                {disk.state === "deleted"
                  ? "This file was deleted on disk. Your unsaved edits are still here."
                  : "This file changed on disk while you were editing it. Your edits are kept; saving will ask before overwriting."}
              </span>
              {disk.state === "changed" && <Button onClick={() => (disk.comparing ? setDisk({ ...disk, comparing: false }) : void compare())}>{disk.comparing ? "Hide changes" : "Compare"}</Button>}
              {disk.state === "changed" && <Button onClick={() => load(true)}>Reload from disk</Button>}
              <Button
                variant="ghost"
                onClick={() => {
                  dismissedMtime.current = disk.state === "deleted" ? -1 : seenMtime.current;
                  setDisk(null);
                }}
              >
                Keep editing
              </Button>
            </div>
            {/* Disk on the left, yours on the right: - lines are only on disk, + lines only in your edit. */}
            {disk.comparing && disk.content !== undefined && draft && <DiffView before={disk.content} after={draft.text} />}
          </div>
        )}
        {conflict && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-severity-warning/50 bg-severity-warning/10 px-3 py-2 text-xs">
            <span className="flex-1">This file changed on disk since it was opened. Overwrite it with your version, or reload it and lose your edits.</span>
            <Button variant="primary" onClick={() => void save(true)}>
              Overwrite
            </Button>
            <Button onClick={() => load(true)}>Reload from disk</Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 px-5 pb-5">
        {media ? (
          <MediaView path={path} kind={media} tick={filesTick} />
        ) : error ? (
          <Empty icon={FileWarning} title={error} />
        ) : notice ? (
          <Empty
            icon={FileWarning}
            title={notice.kind === "binary" ? "A binary file" : "Too large to open here"}
            hint={notice.kind === "binary" ? `${size(notice.size)}; it is not shown as text.` : `${size(notice.size)}; files over 2 MB are not opened in the editor.`}
          />
        ) : !draft ? (
          <div className="text-xs text-muted-foreground">Loading...</div>
        ) : html && htmlView === "preview" ? (
          // The saved file, so its relative links resolve; scripts run in an opaque origin.
          <iframe key={draft.mtimeMs} title={name} src={`${rawUrl(path)}?v=${draft.mtimeMs}`} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="h-full w-full rounded border bg-white" />
        ) : isMarkdown(path) ? (
          <MarkdownBox fill value={draft.text} onChange={edit} blame={editorBlame} fileBlame={fileBlame} />
        ) : (
          <div className="h-full overflow-hidden rounded border">
            <CodeEditor path={path} value={draft.text} onChange={edit} blame={editorBlame} fileBlame={fileBlame} />
          </div>
        )}
      </div>
    </div>
  );
}
