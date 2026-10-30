import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

/**
 * The session's own terminal, untouched: keystrokes go to the `claude`
 * process as they are, and its output is drawn as it comes. Leaving the page
 * only detaches; the process keeps running on the hub and the next attach
 * replays what it printed meanwhile.
 */
export function TerminalView({ terminalId, onExit }: { terminalId: string; onExit?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!host.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 10_000,
      allowProposedApi: true,
      theme: {
        background: "#141413",
        foreground: "#f5f4ee",
        cursor: "#d77757",
        selectionBackground: "#d7775755",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(host.current);
    fit.fit();

    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminals/${terminalId}`);
    const send = (message: unknown) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message));
    const sendSize = () => send({ type: "resize", cols: term.cols, rows: term.rows });

    socket.onopen = () => {
      setState("open");
      sendSize();
      term.focus();
    };
    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data) as { type: string; data?: string; code?: number };
      if (frame.type === "output" && frame.data) term.write(frame.data);
      if (frame.type === "exit") {
        term.write(`\r\n\x1b[2m[session ended, exit code ${frame.code}]\x1b[0m\r\n`);
        onExit?.();
      }
    };
    socket.onclose = () => setState("closed");

    const input = term.onData((data) => send({ type: "input", data }));
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        sendSize();
      } catch {
        // Hidden panels measure as zero; the next visible resize fixes it.
      }
    });
    observer.observe(host.current);

    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId]);

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border bg-[#141413]">
      <div ref={host} className="terminal-host h-full w-full" />
      {state === "connecting" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">connecting...</div>}
      {state === "closed" && <div className="absolute bottom-2 right-3 text-[11px] text-muted-foreground">detached</div>}
    </div>
  );
}
