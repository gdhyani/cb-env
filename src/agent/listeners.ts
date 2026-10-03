import net from "node:net";

/** S6: agent listeners bind to 127.0.0.1 only. */
export function listenLocal(port: number, onConnection: (socket: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer(onConnection);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
