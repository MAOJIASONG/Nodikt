import type { SocketMessage } from "./types";

export const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

export function createNodiktSocket(onMessage: (message: SocketMessage) => void): WebSocket {
  const socket = new WebSocket(WS_URL);
  socket.onmessage = (message) => {
    onMessage(JSON.parse(message.data) as SocketMessage);
  };
  return socket;
}
