import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" }
});

app.get("/", (req, res) => {
  res.send("Server is running!");
});

io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);
});

const PORT = process.env.PORT || 10000;
httpServer.listen(PORT, () => {
  console.log(Server is running on port ${PORT});
});
