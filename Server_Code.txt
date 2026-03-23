import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";
import { storage } from "./storage";

interface RoomInfo {
  players: string[];
  spectators: Record<string, string>;
  gameState: any;
  name: string;
  playerCount: number;
  createdAt: number;
  lastActivity: number;
  status: "waiting" | "playing";
  currentRoundPlays: { seatIndex: number; card: string }[];
  roundSeed: number | null;
  isPublic?: boolean;
}

interface AdminLogEntry {
  ts: number;
  event: string;
  room?: string;
  detail: string;
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  const rooms: Record<string, RoomInfo> = {};
  const roomSeats: Record<string, Record<number, string>> = {};
  const socketSeats: Record<string, { roomId: string; index: number }> = {};
  const roomBotSeats: Record<string, number[]> = {};
  // Offline-seat timers: key = "roomId-seatIndex", value = timer ID
  // If player doesn't reconnect within 5 min, seat is released
  const offlineSeatTimers: Record<string, ReturnType<typeof setTimeout>> = {};

  // ── Lobby (pre-game hall) player tracking ──────────────────
  const lobbyPlayers: Record<string, string> = {}; // socketId → name
  function broadcastLobbyPlayers() {
    const list = Object.entries(lobbyPlayers).map(([sid, name]) => ({ socketId: sid, name }));
    io.emit("lobbyPlayers", list);
  }

  // ── Admin system ───────────────────────────────────────────
  const ADMIN_SECRET = process.env.ADMIN_SECRET || "speet-admin-2024";
  const adminSockets = new Set<string>();
  const adminLog: AdminLogEntry[] = [];
  const MAX_LOG = 300;
  const socketNames: Record<string, string> = {};

  function addAdminLog(event: string, room?: string, detail = "") {
    const entry: AdminLogEntry = { ts: Date.now(), event, room, detail };
    adminLog.push(entry);
    if (adminLog.length > MAX_LOG) adminLog.shift();
    adminSockets.forEach(sid => {
      io.to(sid).emit("adminLog", [entry]);
    });
  }

  function getAdminState() {
    const roomsData = Object.entries(rooms).map(([roomId, room]) => {
      const players = room.players.map((sid) => {
        const seat = socketSeats[sid];
        const seatIdx = seat?.index ?? -1;
        const name = roomSeats[roomId]?.[seatIdx] ?? socketNames[sid] ?? "?";
        return { socketId: sid, seatIndex: seatIdx, name };
      });
      const spectators = Object.entries(room.spectators ?? {}).map(([sid, n]) => ({ socketId: sid, name: n }));
      return {
        id: roomId,
        name: room.name,
        playerCount: room.playerCount,
        status: room.status,
        createdAt: room.createdAt,
        players,
        spectators,
        seats: roomSeats[roomId] ?? {},
        botSeats: roomBotSeats[roomId] ?? [],
        hasGame: !!room.gameState,
        gameState: room.gameState,
      };
    });
    return {
      totalConnected: io.sockets.sockets.size,
      totalRooms: roomsData.length,
      rooms: roomsData,
    };
  }

  function broadcastAdminState() {
    if (adminSockets.size === 0) return;
    const state = getAdminState();
    adminSockets.forEach(sid => {
      io.to(sid).emit("adminState", state);
    });
  }

  function getRoomList() {
    return Object.entries(rooms)
      .map(([id, r]) => ({
        id,
        name: r.name,
        playerCount: r.playerCount,
        players: r.players.length,
        status: r.status,
        createdAt: r.createdAt,
        seats: roomSeats[id] ?? {},
        botSeats: roomBotSeats[id] ?? [],
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  function broadcastRoomList() {
    io.emit("roomsUpdate", getRoomList());
  }

  // Helper to cleanly delete a room and all associated data
  function deleteRoom(roomId: string) {
    delete rooms[roomId];
    delete roomSeats[roomId];
    delete roomBotSeats[roomId];
    // Cancel any pending offline-seat timers for this room
    for (const key of Object.keys(offlineSeatTimers)) {
      if (key.startsWith(`${roomId}-`)) {
        clearTimeout(offlineSeatTimers[key]);
        delete offlineSeatTimers[key];
      }
    }
  }

  // ── Stale room cleanup — runs every 5 minutes ─────────────
  // Removes rooms that have had zero real players for more than 10 minutes
  setInterval(() => {
    const now = Date.now();
    const TEN_MINUTES = 10 * 60 * 1000;
    let changed = false;
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const idle = now - room.lastActivity;
      if (room.players.length === 0 && idle > TEN_MINUTES) {
        addAdminLog("autoCleanup", roomId, `Stale room removed after ${Math.round(idle / 60000)} min`);
        deleteRoom(roomId);
        changed = true;
      }
    }
    if (changed) {
      broadcastRoomList();
      broadcastAdminState();
    }
  }, 5 * 60 * 1000);

  io.on("connection", (socket) => {
    console.log("لاعب متصل: " + socket.id);
    socket.emit("roomList", getRoomList());
    addAdminLog("connect", undefined, `${socket.id}`);
    broadcastAdminState();

    // ── Admin authentication ─────────────────────────────────
    socket.on("adminAuth", (password: string) => {
      if (password === ADMIN_SECRET) {
        adminSockets.add(socket.id);
        socket.emit("adminAuthOk");
        socket.emit("adminState", getAdminState());
        socket.emit("adminLogHistory", adminLog.slice(-150));
        addAdminLog("adminLogin", undefined, `Admin connected: ${socket.id}`);
      } else {
        socket.emit("adminAuthFail");
      }
    });

    socket.on("adminGetState", () => {
      if (!adminSockets.has(socket.id)) return;
      socket.emit("adminState", getAdminState());
    });

    socket.on("adminKick", (targetSocketId: string) => {
      if (!adminSockets.has(socket.id)) return;
      const target = io.sockets.sockets.get(targetSocketId);
      if (target) {
        const name = socketNames[targetSocketId] ?? targetSocketId;
        addAdminLog("kick", undefined, `Kicked: ${name} (${targetSocketId})`);
        target.emit("kicked", { reason: "تم طردك من قِبَل المشرف" });
        setTimeout(() => target.disconnect(true), 600);
        socket.emit("adminKickOk", targetSocketId);
      } else {
        socket.emit("adminKickFail", "لاعب غير موجود");
      }
    });

    socket.on("playerFeedback", (data: { name: string; text: string; ts: number }) => {
      if (!data?.text?.trim()) return;
      const name = (data.name ?? "زائر").slice(0, 40);
      const text = data.text.slice(0, 500);
      addAdminLog("feedback", undefined, `[${name}] ${text}`);
    });

    socket.on("adminCloseRoom", (roomId: string) => {
      if (!adminSockets.has(socket.id)) return;
      if (!rooms[roomId]) return;
      addAdminLog("closeRoom", roomId, `Room closed by admin`);
      io.to(roomId).emit("roomClosed", { reason: "أُغلقت الغرفة من قِبَل المشرف" });
      const room = rooms[roomId];
      for (const sid of room.players) {
        const s = io.sockets.sockets.get(sid);
        if (s) setTimeout(() => s.disconnect(true), 700);
      }
      deleteRoom(roomId);
      broadcastRoomList();
      broadcastAdminState();
    });

    socket.on("adminAnnounce", (message: string) => {
      if (!adminSockets.has(socket.id)) return;
      io.emit("serverAnnouncement", { message });
      addAdminLog("announce", undefined, `Announcement: "${message}"`);
    });

    // ── Regular game events ──────────────────────────────────
    socket.on("getRooms", () => {
      socket.emit("roomList", getRoomList());
    });

    // Player exits a room voluntarily (without full disconnect)
    socket.on("leaveRoom", (roomId: string) => {
      socket.leave(roomId);
      const name = socketNames[socket.id] ?? socket.id;
      if (rooms[roomId]) {
        rooms[roomId].players = rooms[roomId].players.filter(id => id !== socket.id);
        if (rooms[roomId].players.length === 0) {
          deleteRoom(roomId);
        } else {
          rooms[roomId].lastActivity = Date.now();
        }
      }
      // Release seat immediately
      if (socketSeats[socket.id]) {
        const { index } = socketSeats[socket.id];
        delete socketSeats[socket.id];
        if (roomSeats[roomId]) {
          delete roomSeats[roomId][index];
          io.to(roomId).emit("seatUpdate", roomSeats[roomId]);
        }
        io.to(roomId).emit("playerOffline", { seatIndex: index, name });
      }
      // Remove from lobby if there
      if (lobbyPlayers[socket.id]) {
        delete lobbyPlayers[socket.id];
        broadcastLobbyPlayers();
      }
      broadcastRoomList();
    });

    socket.on(
      "createRoom",
      (data: {
        roomId: string;
        name: string;
        playerCount: number;
        playerName: string;
      }) => {
        socket.join(data.roomId);
        rooms[data.roomId] = {
          players: [socket.id],
          spectators: {},
          gameState: null,
          name: data.name,
          playerCount: data.playerCount,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          status: "waiting",
          currentRoundPlays: [],
          roundSeed: null,
        };
        socketNames[socket.id] = data.playerName;
        io.to(data.roomId).emit("playerJoined", {
          playerId: socket.id,
          playerName: data.playerName,
          playerCount: 1,
        });
        socket.emit("seatUpdate", roomSeats[data.roomId] ?? {});
        addAdminLog("createRoom", data.roomId, `${data.playerName} created "${data.name}" (${data.playerCount}p)`);
        broadcastRoomList();
        broadcastAdminState();
      }
    );

    // ── Quick match: find or create a public waiting room ──────────────
    socket.on("quickMatch", (data: { playerCount: number; playerName: string }) => {
      const pc = data.playerCount === 6 ? 6 : 4;
      // Search for an open public waiting room with available seats
      let foundId: string | null = null;
      for (const [rid, room] of Object.entries(rooms)) {
        if (!room.isPublic) continue;
        if (room.playerCount !== pc) continue;
        if (room.status !== "waiting") continue;
        const filled = Object.keys(roomSeats[rid] ?? {}).length;
        if (filled < pc) { foundId = rid; break; }
      }
      if (foundId) {
        socket.emit("quickMatchFound", { roomId: foundId, playerCount: pc });
        addAdminLog("quickMatch", foundId, `${data.playerName} joined existing public room (${pc}p)`);
      } else {
        const newId = `pub-${Date.now()}`;
        rooms[newId] = {
          players: [],
          spectators: {},
          gameState: null,
          name: "لعبة سريعة",
          playerCount: pc,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          status: "waiting",
          currentRoundPlays: [],
          roundSeed: null,
          isPublic: true,
        };
        socket.emit("quickMatchFound", { roomId: newId, playerCount: pc });
        addAdminLog("quickMatch", newId, `${data.playerName} created new public room (${pc}p)`);
        broadcastRoomList();
      }
    });

    socket.on("joinRoom", (roomId: string, playerName: string) => {
      socket.join(roomId);
      if (!rooms[roomId]) {
        rooms[roomId] = {
          players: [],
          spectators: {},
          gameState: null,
          name: roomId,
          playerCount: 4,
          createdAt: Date.now(),
          lastActivity: Date.now(),
          status: "waiting",
          currentRoundPlays: [],
          roundSeed: null,
        };
      }
      if (!rooms[roomId].spectators) rooms[roomId].spectators = {};
      if (!rooms[roomId].players.includes(socket.id)) {
        rooms[roomId].players.push(socket.id);
      }
      rooms[roomId].lastActivity = Date.now();
      socketNames[socket.id] = playerName;
      io.to(roomId).emit("playerJoined", {
        playerId: socket.id,
        playerName,
        playerCount: rooms[roomId].players.length,
      });
      // Send full game state to reconnecting player
      if (rooms[roomId].gameState) {
        const stateToSend = {
          ...rooms[roomId].gameState,
          currentRoundPlays: rooms[roomId].currentRoundPlays || [],
          roundSeed: rooms[roomId].roundSeed,
          playerCount: rooms[roomId].playerCount,
        };
        socket.emit("gameState", stateToSend);
      }
      socket.emit("seatUpdate", roomSeats[roomId] ?? {});
      socket.emit("botSeatsList", roomBotSeats[roomId] ?? []);
      addAdminLog("joinRoom", roomId, `${playerName} (${socket.id}) joined`);
      broadcastRoomList();
      broadcastAdminState();
    });

    socket.on(
      "claimSeat",
      (data: { roomId: string; index: number; name: string }) => {
        if (!roomSeats[data.roomId]) roomSeats[data.roomId] = {};

        // Release previous seat for this socket if it's a different seat in the same room
        const prevSeat = socketSeats[socket.id];
        if (prevSeat && prevSeat.roomId === data.roomId && prevSeat.index !== data.index) {
          delete roomSeats[data.roomId][prevSeat.index];
        }

        const wasEmpty = !roomSeats[data.roomId][data.index];
        roomSeats[data.roomId][data.index] = data.name;
        socketSeats[socket.id] = { roomId: data.roomId, index: data.index };
        socketNames[socket.id] = data.name;
        if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();

        // Cancel pending offline-seat timer if player is reclaiming their seat
        const seatKey = `${data.roomId}-${data.index}`;
        if (offlineSeatTimers[seatKey]) {
          clearTimeout(offlineSeatTimers[seatKey]);
          delete offlineSeatTimers[seatKey];
        }

        io.to(data.roomId).emit("seatUpdate", roomSeats[data.roomId]);
        if (!wasEmpty || rooms[data.roomId]?.status === "playing") {
          socket.to(data.roomId).emit("playerOnline", { seatIndex: data.index, name: data.name });
        }
        addAdminLog("claimSeat", data.roomId, `${data.name} → seat ${data.index}`);
        broadcastAdminState();
      }
    );

    socket.on("joinAsSpectator", (data: { roomId: string; name: string }) => {
      socket.join(data.roomId);
      if (!rooms[data.roomId]) return;
      if (!rooms[data.roomId].spectators) rooms[data.roomId].spectators = {};
      rooms[data.roomId].spectators[socket.id] = data.name;
      socketNames[socket.id] = data.name;
      rooms[data.roomId].lastActivity = Date.now();
      const specList = Object.entries(rooms[data.roomId].spectators).map(([socketId, name]) => ({ socketId, name }));
      io.to(data.roomId).emit("spectatorList", specList);
      if (rooms[data.roomId].gameState) {
        const stateToSend = {
          ...rooms[data.roomId].gameState,
          currentRoundPlays: rooms[data.roomId].currentRoundPlays || [],
          roundSeed: rooms[data.roomId].roundSeed,
          playerCount: rooms[data.roomId].playerCount,
        };
        socket.emit("gameState", stateToSend);
      }
      socket.emit("seatUpdate", roomSeats[data.roomId] ?? {});
      addAdminLog("spectator", data.roomId, `${data.name} watching`);
      broadcastAdminState();
    });

    socket.on("botSeatsUpdate", (data: { roomId: string; seats: number[] }) => {
      roomBotSeats[data.roomId] = data.seats;
      // Broadcast to all OTHER clients so they can run bot logic too
      socket.to(data.roomId).emit("botSeatsSync", data.seats);
    });

    socket.on("takeSeatRequest", (data: { roomId: string; seat: number; name: string }) => {
      socket.to(data.roomId).emit("takeSeatRequest", {
        seat: data.seat,
        name: data.name,
        socketId: socket.id,
      });
    });

    socket.on("takeSeatGrant", (data: { roomId: string; seat: number; name: string; hand: string[]; socketId: string }) => {
      if (roomBotSeats[data.roomId]) {
        roomBotSeats[data.roomId] = roomBotSeats[data.roomId].filter(s => s !== data.seat);
      }
      io.to(data.socketId).emit("takeSeatGrant", { seat: data.seat, name: data.name, hand: data.hand });
      io.to(data.roomId).emit("seatTaken", { seat: data.seat, name: data.name });
    });

    socket.on(
      "dealCards",
      (data: { roomId: string; seed: number; playerCount: number }) => {
        // Store seed and reset plays for the new round
        if (rooms[data.roomId]) {
          rooms[data.roomId].roundSeed = data.seed;
          rooms[data.roomId].currentRoundPlays = [];
          rooms[data.roomId].lastActivity = Date.now();
        }
        socket.to(data.roomId).emit("dealCards", {
          seed: data.seed,
          playerCount: data.playerCount,
        });
        addAdminLog("deal", data.roomId, `Cards dealt (${data.playerCount}p)`);
      }
    );

    socket.on("startPurchasing", (data: { roomId: string }) => {
      if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();
      socket.to(data.roomId).emit("startPurchasing");
      addAdminLog("purchasing", data.roomId, "Bidding started");
    });

    socket.on(
      "purchaseOrderSet",
      (data: { roomId: string; order: number[] }) => {
        if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();
        socket.to(data.roomId).emit("purchaseOrderSet", { order: data.order });
      }
    );

    socket.on(
      "forcedBuyTeamSet",
      (data: { roomId: string; team: 0 | 1 | null }) => {
        socket.to(data.roomId).emit("forcedBuyTeamSet", { team: data.team });
      }
    );

    socket.on(
      "forcedBuyPlayerSet",
      (data: { roomId: string; player: number | null }) => {
        socket.to(data.roomId).emit("forcedBuyPlayerSet", {
          player: data.player,
        });
      }
    );

    socket.on(
      "purchaseSubmit",
      (data: { roomId: string; index: number; value: number }) => {
        if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();
        socket.to(data.roomId).emit("purchaseSubmit", {
          index: data.index,
          value: data.value,
        });
        addAdminLog("bid", data.roomId, `Seat ${data.index} bid ${data.value}`);
      }
    );

    socket.on("roundReset", (data: { roomId: string; log: string }) => {
      if (rooms[data.roomId]) {
        rooms[data.roomId].currentRoundPlays = [];
        rooms[data.roomId].roundSeed = null;
        rooms[data.roomId].lastActivity = Date.now();
      }
      socket.to(data.roomId).emit("roundReset", { log: data.log });
    });

    socket.on(
      "startPlaying",
      (data: {
        roomId: string;
        leader: number;
        tricksTotal: number;
        playerCount: number;
      }) => {
        if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();
        socket.to(data.roomId).emit("startPlaying", {
          leader: data.leader,
          tricksTotal: data.tricksTotal,
          playerCount: data.playerCount,
        });
        addAdminLog("startPlaying", data.roomId, `Leader: seat ${data.leader}`);
      }
    );

    socket.on(
      "cardPlayed",
      (data: { roomId: string; playerIndex: number; card: string }) => {
        // Track played cards for reconnect hand reconstruction
        if (rooms[data.roomId]) {
          rooms[data.roomId].currentRoundPlays.push({
            seatIndex: data.playerIndex,
            card: data.card,
          });
          rooms[data.roomId].lastActivity = Date.now();
        }
        socket.to(data.roomId).emit("cardPlayed", {
          playerIndex: data.playerIndex,
          card: data.card,
        });
        addAdminLog("card", data.roomId, `Seat ${data.playerIndex}: ${data.card}`);
      }
    );

    socket.on("gameUpdate", (data: any) => {
      const roomId = data.roomId;
      if (roomId && rooms[roomId]) {
        rooms[roomId].gameState = data;
        rooms[roomId].lastActivity = Date.now();
        if (rooms[roomId].status !== "playing") {
          rooms[roomId].status = "playing";
          broadcastRoomList();
        }
        socket.to(roomId).emit("gameUpdate", data);
        addAdminLog("gameUpdate", roomId, `T1:${data.team1Score} T2:${data.team2Score} R:${data.roundNumber}`);
        broadcastAdminState();
      } else {
        socket.broadcast.emit("gameUpdate", data);
      }
    });

    socket.on("webrtcSignal", (data: any) => {
      if (data.roomId) {
        socket.to(data.roomId).emit("webrtcSignal", data);
      } else {
        socket.broadcast.emit("webrtcSignal", data);
      }
    });

    socket.on("chatMessage", (data: any) => {
      const roomId = data.roomId;
      if (roomId) {
        io.to(roomId).emit("chatMessage", data);
        addAdminLog("chat", roomId, `${data.sender}: "${data.text}"`);
      } else {
        socket.broadcast.emit("chatMessage", data);
      }
    });

    socket.on("restartGame", (data: { roomId: string }) => {
      if (rooms[data.roomId]) {
        rooms[data.roomId].currentRoundPlays = [];
        rooms[data.roomId].roundSeed = null;
        rooms[data.roomId].status = "waiting";
        rooms[data.roomId].lastActivity = Date.now();
      }
      socket.to(data.roomId).emit("restartGame");
    });

    socket.on("seatUpdate", (data: { roomId: string }) => {
      if (rooms[data.roomId]) rooms[data.roomId].lastActivity = Date.now();
    });

    // ── Lobby presence ────────────────────────────────────────
    socket.on("joinLobby", (name: string) => {
      if (name && typeof name === "string") {
        lobbyPlayers[socket.id] = name.trim().slice(0, 30);
        socketNames[socket.id] = lobbyPlayers[socket.id];
        socket.join("__lobby__");
        broadcastLobbyPlayers();
      }
    });

    socket.on("leaveLobby", () => {
      delete lobbyPlayers[socket.id];
      socket.leave("__lobby__");
      broadcastLobbyPlayers();
    });

    // ── Lobby voice presence ──────────────────────────────────
    socket.on("lobbyVoiceOn", () => {
      const name = lobbyPlayers[socket.id] ?? socketNames[socket.id] ?? "لاعب";
      socket.data.lobbyVoiceName = name;
      // Gather all voice-on users in __lobby__ room
      const voiceNames: string[] = [];
      const lobbyRoom = io.sockets.adapter.rooms.get("__lobby__");
      if (lobbyRoom) {
        for (const sid of Array.from(lobbyRoom)) {
          const s = io.sockets.sockets.get(sid);
          if (s?.data?.lobbyVoiceName) voiceNames.push(s.data.lobbyVoiceName);
        }
      }
      io.to("__lobby__").emit("lobbyVoiceUsers", voiceNames);
    });

    socket.on("lobbyVoiceOff", () => {
      delete socket.data.lobbyVoiceName;
      const voiceNames: string[] = [];
      const lobbyRoom = io.sockets.adapter.rooms.get("__lobby__");
      if (lobbyRoom) {
        for (const sid of Array.from(lobbyRoom)) {
          const s = io.sockets.sockets.get(sid);
          if (s?.data?.lobbyVoiceName) voiceNames.push(s.data.lobbyVoiceName);
        }
      }
      io.to("__lobby__").emit("lobbyVoiceUsers", voiceNames);
    });

    // ── Lobby chat ────────────────────────────────────────────
    socket.on("lobbyMessage", (text: string) => {
      if (!text || typeof text !== "string") return;
      const clean = text.trim().slice(0, 200);
      if (!clean) return;
      const name = lobbyPlayers[socket.id] ?? socketNames[socket.id] ?? "لاعب";
      io.emit("lobbyMessage", { name, text: clean, ts: Date.now() });
    });

    // ── Player invite ─────────────────────────────────────────
    socket.on("invitePlayer", (data: { targetSocketId: string; roomId: string; roomName: string; playerCount: number }) => {
      if (!data?.targetSocketId) return;
      const inviterName = socketNames[socket.id] ?? lobbyPlayers[socket.id] ?? "لاعب";
      const target = io.sockets.sockets.get(data.targetSocketId);
      if (target) {
        target.emit("gameInvite", {
          roomId: data.roomId,
          roomName: data.roomName,
          playerCount: data.playerCount,
          inviterName,
        });
      }
    });

    socket.on("disconnect", () => {
      console.log("لاعب فصل: " + socket.id);
      const name = socketNames[socket.id] ?? socket.id;
      addAdminLog("disconnect", undefined, `${name} disconnected`);
      adminSockets.delete(socket.id);
      delete socketNames[socket.id];
      if (lobbyPlayers[socket.id]) {
        delete lobbyPlayers[socket.id];
        broadcastLobbyPlayers();
      }

      let changed = false;
      for (const roomId in rooms) {
        if (rooms[roomId].spectators && rooms[roomId].spectators[socket.id]) {
          delete rooms[roomId].spectators[socket.id];
          const specList = Object.entries(rooms[roomId].spectators).map(([sid, n]) => ({ socketId: sid, name: n }));
          io.to(roomId).emit("spectatorList", specList);
        }
        const before = rooms[roomId].players.length;
        rooms[roomId].players = rooms[roomId].players.filter((id) => id !== socket.id);
        if (rooms[roomId].players.length !== before) {
          changed = true;
          rooms[roomId].lastActivity = Date.now();
          // If all players left, schedule room deletion
          if (rooms[roomId].players.length === 0) {
            deleteRoom(roomId);
          }
        }
      }

      const seatInfo = socketSeats[socket.id];
      if (seatInfo) {
        const { roomId, index } = seatInfo;
        // Notify others this player went offline
        io.to(roomId).emit("playerOffline", { seatIndex: index, name });
        delete socketSeats[socket.id];

        // Keep the seat for 5 minutes to allow reconnection
        // If they don't reconnect, release the seat
        if (rooms[roomId] && roomSeats[roomId]?.[index]) {
          const seatKey = `${roomId}-${index}`;
          // Cancel any existing timer for this seat
          if (offlineSeatTimers[seatKey]) clearTimeout(offlineSeatTimers[seatKey]);
          offlineSeatTimers[seatKey] = setTimeout(() => {
            delete offlineSeatTimers[seatKey];
            if (roomSeats[roomId]) {
              delete roomSeats[roomId][index];
              io.to(roomId).emit("seatUpdate", roomSeats[roomId]);
            }
          }, 5 * 60 * 1000); // 5 minutes
        }
      }

      if (changed) broadcastRoomList();
      broadcastAdminState();
    });
  });

  return httpServer;
}
