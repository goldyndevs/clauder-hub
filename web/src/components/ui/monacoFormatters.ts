import type * as Monaco from "monaco-editor";
import { filesApi } from "../../lib/filesApi";
import { useStore } from "../../lib/store";

/**
 * "Format Document" (Shift+Alt+F, or the editor's context menu) through
 * Prettier for the web languages and sql-formatter for SQL. Both load on the
 * first format, not with the editor. The project's own .prettierrc (JSON) is
 * honoured; the editor's indentation is the fallback.
 */
const PRETTIER_PARSER: Record<string, string> = {
  javascript: "babel",
  typescript: "typescript",
  json: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  markdown: "markdown",
  yaml: "yaml",
  graphql: "graphql",
};
const SQL_DIALECT: Record<string, "sql" | "mysql" | "postgresql"> = { sql: "sql", mysql: "mysql", pgsql: "postgresql" };

/** Read at each format, from the open project: it differs per project and may have just been edited. */
async function prettierConfig(): Promise<Record<string, unknown>> {
  for (const name of [".prettierrc", ".prettierrc.json"]) {
    const file = await filesApi.read(name).catch(() => null);
    if (file?.kind !== "text") continue;
    try {
      return JSON.parse(file.content) as Record<string, unknown>;
    } catch {
      // A YAML .prettierrc is not read; the defaults apply.
    }
  }
  return {};
}

async function prettierFormat(text: string, parser: string, options: Monaco.languages.FormattingOptions): Promise<string> {
  const [prettier, babel, estree, typescript, postcss, html, markdown, yaml, graphql, config] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/babel"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/html"),
    import("prettier/plugins/markdown"),
    import("prettier/plugins/yaml"),
    import("prettier/plugins/graphql"),
    prettierConfig(),
  ]);
  return prettier.format(text, {
    tabWidth: options.tabSize,
    useTabs: !options.insertSpaces,
    ...config,
    parser,
    plugins: [babel, estree, typescript, postcss, html, markdown, yaml, graphql],
  });
}

async function sqlFormat(text: string, language: "sql" | "mysql" | "postgresql", options: Monaco.languages.FormattingOptions): Promise<string> {
  const { format } = await import("sql-formatter");
  return format(text, { language, tabWidth: options.tabSize, useTabs: !options.insertSpaces });
}

let registered = false;
export function registerFormatters(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;
  const provide = (language: string, run: (text: string, options: Monaco.languages.FormattingOptions) => Promise<string>) =>
    monaco.languages.registerDocumentFormattingEditProvider(language, {
      displayName: language in SQL_DIALECT ? "sql-formatter" : "Prettier",
      async provideDocumentFormattingEdits(model, options) {
        try {
          const text = await run(model.getValue(), options);
          return text === model.getValue() ? [] : [{ range: model.getFullModelRange(), text }];
        } catch (error) {
          // A syntax error says where; Monaco itself would only fail silently.
          useStore.getState().notify(`Could not format: ${(error as Error).message.split("\n")[0]}`, "error");
          return [];
        }
      },
    });
  for (const [language, parser] of Object.entries(PRETTIER_PARSER)) provide(language, (text, options) => prettierFormat(text, parser, options));
  for (const [language, dialect] of Object.entries(SQL_DIALECT)) provide(language, (text, options) => sqlFormat(text, dialect, options));
}
