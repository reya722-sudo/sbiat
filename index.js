import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// صفحة تجريبية للتأكد أن السيرفر يعمل
app.get("/", (req, res) => {
  res.send("<h1>Sbiat Server is Running!</h1>");
});

// منطق الاتصال باللاعبين
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);
  
  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
  });
});

// تحديد المنفذ (Port) بشكل تلقائي ليتناسب مع Render
const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
