import { WebSocketServer } from 'ws';
import http from 'http';
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const TTL_MS = 2 * 60 * 1000; // 2 minutes to complete handshake
// In-memory, ephemeral map of room name -> offer
const rooms = new Map();
const server = http.createServer();
const wss = new WebSocketServer({ server });
function now() { return Date.now(); }
function cleanupExpired() {
    const t = now();
    for (const [name, rec] of rooms) {
        if (t - rec.createdAt > rec.ttlMs) {
            try {
                rec.offerSocket.close();
            }
            catch { }
            rooms.delete(name);
        }
    }
}
setInterval(cleanupExpired, 15_000);
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        }
        catch {
            ws.send(JSON.stringify({ type: 'error', error: 'bad_json' }));
            return;
        }
        const { type } = msg || {};
        // Creator posts offer SDP to a room name
        if (type === 'create') {
            const { name, sdp } = msg;
            if (!name || !sdp) {
                ws.send(JSON.stringify({ type: 'error', error: 'missing_fields' }));
                return;
            }
            if (rooms.has(name)) {
                ws.send(JSON.stringify({ type: 'error', error: 'room_exists' }));
                return;
            }
            rooms.set(name, { offerSDP: sdp, offerSocket: ws, createdAt: now(), ttlMs: TTL_MS });
            ws.send(JSON.stringify({ type: 'created', name }));
            return;
        }
        // Joiner asks for an offer for a room name
        if (type === 'join') {
            const { name } = msg;
            const rec = rooms.get(name);
            if (!rec) {
                ws.send(JSON.stringify({ type: 'not_found', name }));
                return;
            }
            // Send the offer SDP to the joiner
            ws.send(JSON.stringify({ type: 'offer', name, sdp: rec.offerSDP, info: { createdAt: rec.createdAt } }));
            // Wire up forwarding for the answer
            ws.__roomName = name;
            return;
        }
        // Joiner sends the answer back; server forwards to creator and deletes room
        if (type === 'answer') {
            const { name, sdp } = msg;
            const rec = rooms.get(name);
            if (!rec) {
                ws.send(JSON.stringify({ type: 'not_found', name }));
                return;
            }
            try {
                rec.offerSocket.send(JSON.stringify({ type: 'answer', name, sdp }));
            }
            finally {
                rooms.delete(name); // forget immediately after handshake
            }
            ws.send(JSON.stringify({ type: 'ok' }));
            return;
        }
        ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }));
    });
    ws.on('close', () => {
        // If a creator disconnects before handshake completes, nuke the room
        for (const [name, rec] of rooms) {
            if (rec.offerSocket === ws)
                rooms.delete(name);
        }
    });
});
server.listen(PORT, () => {
    console.log(`[signaling] listening on ws://localhost:${PORT}`);
    console.log(`[signaling] ephemeral; offers auto-expire after ${TTL_MS / 1000}s`);
});
