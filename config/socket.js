const socketIo = require('socket.io');

const initSocket = (server) => {
  const io = socketIo(server, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
  });
  return io;
};

module.exports = initSocket;