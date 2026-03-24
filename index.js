const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on('connection', (socket) => {
  console.log('لاعب متصل:', socket.id);

  socket.on('start_game', () => {
    // توزيع ورق عشوائي كمثال من السيرفر
    const hand = ["A♠", "K♥", "Q♦", "J♣"];
    socket.emit('receive_hand', hand);
  });

  socket.on('send_message', (msg) => {
    io.emit('new_message', {
      id: Math.random(),
      sender: "لاعب",
      text: msg,
      time: new Date().toLocaleTimeString()
    });
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('السيرفر يعمل الآن...');
});
