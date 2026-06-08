import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { Server as SocketIOServer } from 'socket.io';
import { TICK_MS } from '@infinitechess/shared';
import { World } from './world.js';
const PORT = Number(process.env.PORT ?? 8080);
const __dirname = dirname(fileURLToPath(import.meta.url));
// Mirror console.log/console.warn/console.error to logs/server.log so the
// user can hand the file to debugging tools instead of copy-pasting terminal
// output. The file is truncated on each restart so it always reflects the
// current run.
const logDir = resolve(__dirname, '../../../logs');
mkdirSync(logDir, { recursive: true });
const logStream = createWriteStream(resolve(logDir, 'server.log'), { flags: 'w' });
for (const level of ['log', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
        original(...args);
        const stamp = new Date().toISOString();
        const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        logStream.write(`${stamp} [${level}] ${text}\n`);
    };
}
const app = express();
app.get('/health', (_req, res) => res.json({ ok: true }));
// In production, serve the built client.
const clientDist = resolve(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
    app.use(express.static(clientDist));
}
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: { origin: true, credentials: true },
});
const world = new World();
/** Map socket -> playerId so the tick loop can address each connection's snapshot. */
const socketPlayer = new Map();
io.on('connection', (socket) => {
    let playerId = null;
    socket.on('hello', ({ name }) => {
        if (playerId)
            return; // already joined
        const player = world.addPlayer(name ?? '');
        playerId = player.id;
        socketPlayer.set(socket, player.id);
        socket.emit('welcome', {
            playerId: player.id,
            tickMs: TICK_MS,
            serverTick: world.tick,
            snapshot: world.snapshot(),
        });
        console.log(`[join] ${player.name} (${player.id.slice(0, 8)})`);
    });
    socket.on('moveIntent', ({ pieceId, target }) => {
        if (!playerId)
            return;
        const err = world.requestMove(playerId, pieceId, target);
        if (err)
            socket.emit('error', err);
    });
    socket.on('formationMove', ({ pieceIds, target }) => {
        if (!playerId)
            return;
        world.formationMove(playerId, pieceIds, target);
    });
    socket.on('cancelGoal', ({ pieceId }) => {
        if (!playerId)
            return;
        world.cancelGoal(playerId, pieceId);
    });
    socket.on('leaveFormation', ({ pieceId }) => {
        if (!playerId)
            return;
        const err = world.leaveFormation(playerId, pieceId);
        if (err)
            socket.emit('error', err);
    });
    socket.on('sellPiece', ({ pieceId }) => {
        if (!playerId)
            return;
        const err = world.sellPiece(playerId, pieceId);
        if (err)
            socket.emit('error', err);
    });
    socket.on('buyPiece', ({ type, pos }) => {
        if (!playerId)
            return;
        const err = world.buyPiece(playerId, type, pos);
        if (err)
            socket.emit('error', err);
    });
    socket.on('upgradePiece', ({ pieceIds }) => {
        if (!playerId)
            return;
        // Multi-select Upgrade All: try each, emit the first failure (if any)
        // so the client surfaces a meaningful message. Successful upgrades
        // ride through silently and show up via the snapshot.
        let firstErr = null;
        for (const id of pieceIds) {
            const err = world.upgradePiece(playerId, id);
            if (err && !firstErr)
                firstErr = err;
        }
        if (firstErr)
            socket.emit('error', firstErr);
    });
    socket.on('placeBomb', ({ pos }) => {
        if (!playerId)
            return;
        const err = world.placeBomb(playerId, pos);
        if (err)
            socket.emit('error', err);
    });
    socket.on('viewport', (vp) => {
        if (!playerId)
            return;
        world.setViewport(playerId, vp);
    });
    socket.on('disconnect', () => {
        if (playerId) {
            world.removePlayer(playerId);
            socketPlayer.delete(socket);
            console.log(`[leave] ${playerId.slice(0, 8)}`);
        }
    });
});
// 10 Hz tick: advance the world, then send each player a viewport-filtered snapshot.
setInterval(() => {
    world.step();
    for (const [socket, pid] of socketPlayer) {
        socket.emit('snapshot', world.snapshotFor(pid));
    }
}, TICK_MS);
httpServer.listen(PORT, () => {
    console.log(`infinitechess server listening on http://localhost:${PORT}`);
});
