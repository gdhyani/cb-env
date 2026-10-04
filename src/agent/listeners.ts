import net from "node:net";

export interface LocalListener {
  server: net.Server;
  port: number;
  /** Stops accepting and destroys open connections immediately (server.close() alone waits for them). */
  close(): void;
}

/** S6: agent listeners bind to 127.0.0.1 only. */
export function listenLocal(port: number, onConnection: (socket: net.Socket) => void): Promise<LocalListener> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    onConnection(socket);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        server,
        port,
        close() {
          server.close();
          for (const s of sockets) s.destroy();
          sockets.clear();
        },
      });
    });
  });
}
