import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

/** Same-origin relay using only the browser's tenant credential. */
export function attachDevnetWebSocket(server: Server, upstreamUrl: string | undefined) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has('fiber-rpc') ? 'fiber-rpc' : false),
  });
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const protocols = (req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim());
    if (
      pathname !== '/devnet/ws' ||
      !req.headers.host ||
      ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(
        req.headers.origin ?? '',
      ) ||
      protocols.length !== 2 ||
      !protocols.includes('fiber-rpc') ||
      !protocols.some((p) => /^base64url\.bearer\.authorization\.fiber\.[A-Za-z0-9_-]+$/.test(p))
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!upstreamUrl) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = new WebSocket(upstreamUrl, protocols, {
      handshakeTimeout: 10_000,
      maxPayload: 1024 * 1024,
      followRedirects: false,
    });
    let downstream: WebSocket | undefined;
    const stop = () => {
      if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      else upstream.close();
    };
    socket.on('error', stop);
    socket.on('close', stop);
    upstream.on('error', () => {
      if (downstream) downstream.close(1011, 'LSP connection failed');
      else socket.destroy();
    });
    upstream.on('close', () => {
      if (downstream) downstream.close();
      else socket.destroy();
    });
    upstream.on('open', () => {
      if (socket.destroyed) {
        stop();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        downstream = client;
        client.on('error', stop);
        client.on('close', stop);
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
      });
    });
  });
  server.on('close', () => wss.close());
  return wss;
}
