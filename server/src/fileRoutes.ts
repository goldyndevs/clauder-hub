import express from "express";
import { blameFile, commitDetails } from "./blame.js";
import { FileError, copyPath, revealPath, createFile, createFolder, deletePath, listFolder, readText, renamePath, resolvePath, statFile, writeText } from "./files.js";

/** The Files tab: /api/files. Every path is relative to the project root; files.ts checks it. */
export const fileRoutes = express.Router();

const wrap =
  (handler: (req: express.Request) => unknown) =>
  (req: express.Request, res: express.Response) => {
    try {
      res.json(handler(req));
    } catch (error) {
      res.status(error instanceof FileError ? error.status : 400).json({ error: (error as Error).message });
    }
  };

fileRoutes.get("/list", wrap((req) => listFolder(req.query.path ?? "", req.query.ignored === "1")));
fileRoutes.get("/read", wrap((req) => readText(req.query.path)));
fileRoutes.get("/stat", wrap((req) => statFile(req.query.path)));

/**
 * The file's bytes at /raw/<path>, for images, audio, video and HTML previews.
 * The path is in the URL so a page's relative links (style.css, img/a.png)
 * resolve to their files too. Range requests work, so media can seek.
 * Sandboxed without same-origin: a page's scripts run, but in an opaque
 * origin that the hub's CORS turns away.
 */
fileRoutes.use("/raw", (req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).end();
  try {
    const absolute = resolvePath(decodeURIComponent(req.path.replace(/^\//, "")));
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.sendFile(absolute, { dotfiles: "allow", cacheControl: false }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: "No such file." });
    });
  } catch (error) {
    res.status(error instanceof FileError ? error.status : 400).json({ error: (error as Error).message });
  }
});


/** The blame endpoints shell out to git, so they answer asynchronously. */
const wrapAsync =
  (handler: (req: express.Request) => Promise<unknown>) =>
  async (req: express.Request, res: express.Response) => {
    try {
      res.json(await handler(req));
    } catch (error) {
      res.status(error instanceof FileError ? error.status : 400).json({ error: (error as Error).message });
    }
  };

fileRoutes.get("/blame", wrapAsync((req) => blameFile(req.query.path)));
fileRoutes.get("/commit", wrapAsync((req) => commitDetails(req.query.sha)));
fileRoutes.put("/write", wrap((req) => writeText(req.body?.path, req.body?.content, req.body?.expectedMtimeMs)));
fileRoutes.post("/create", wrap((req) => createFile(req.body?.path, req.body?.content ?? "")));
fileRoutes.post("/mkdir", wrap((req) => createFolder(req.body?.path)));
fileRoutes.post("/rename", wrap((req) => renamePath(req.body?.from, req.body?.to)));
fileRoutes.post("/delete", wrap((req) => deletePath(req.body?.path)));
fileRoutes.post("/reveal", wrapAsync((req) => revealPath(req.body?.path)));
fileRoutes.post("/copy", wrap((req) => copyPath(req.body?.from, req.body?.folder ?? "")));
