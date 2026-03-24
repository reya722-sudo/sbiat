import type { Express } from "express";
import { createServer, type Server } from "http";
import { Server as SocketIOServer } from "socket.io";

interface RoomInfo {
  players: string[];
  spectators: Record<string, string>;
  gameState: any;
  name: string;
  playerCount: number;
  status: "waiting" | "playing";
  currentRoundPlays: { seatIndex: number; card: string }[];
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  const rooms: Record<string, RoomInfo> = {};
  const roomSeats: Record<string, Record<number, string>> = {};

  io.on("connection", (socket) => {
    console.log("لاعب جديد متصل:", socket.id);

    // منطق إنشاء الغرفة
    socket.on("createRoom", (data) => {
      const roomId = Math.random().toString(36).substring(2, 7).toUpperCase();
      rooms[roomId] = {
        players: [socket.id],
        spectators: {},
        gameState: null,
        name: data.name || "غرفة جديدة",
        playerCount: 4,
        status: "waiting",
        currentRoundPlays: [],
      };
      socket.join(roomId);
      socket.emit("roomCreated", { roomId });
      console.log(`تم إنشاء الغرفة: ${roomId}`);
    });

    // منطق الانضمام للغرفة
    socket.on("joinRoom", (roomId) => {
      if (rooms[roomId]) {
        socket.join(roomId);
        rooms[roomId].players.push(socket.id);
        io.to(roomId).emit("playerJoined", { id: socket.id });
      } else {
        socket.emit("error", "الغرفة غير موجودة");
      }
    });

    socket.on("disconnect", () => {
      console.log("لاعب غادر:", socket.id);
    });
  });

  return httpServer;
}
