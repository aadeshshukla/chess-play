const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {};
const matchmakingQueues = { '3': null, '5': null, '10': null };

function getGameOutcome(chess) {
  if (chess.isCheckmate()) {
    const winner = chess.turn() === 'w' ? 'black' : 'white';
    return { outcome: `${winner} wins`, winner, reason: 'checkmate' };
  }
  if (chess.isDraw()) {
    let reason = 'draw';
    if (chess.isStalemate()) reason = 'stalemate';
    else if (chess.isThreefoldRepetition()) reason = 'repetition';
    else if (chess.isInsufficientMaterial()) reason = 'insufficient material';
    else if (chess.isDraw()) reason = '50-move rule'; // fallback
    return { outcome: 'draw', winner: null, reason };
  }
  return { outcome: 'game over', winner: null, reason: 'unknown' };
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.chess = new Chess();
  room.time = { w: room.timeMode * 60000, b: room.timeMode * 60000 };
  room.gameStarted = false;
  room.lastMoveTime = null;
  room.moves = [];
  room.drawOffer = null;
  room.rematchVotes = room.rematchVotes || [];

  if (room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
  if (room.abandonTimer) {
    clearTimeout(room.abandonTimer);
    room.abandonTimer = null;
  }

  io.to(roomId).emit('game_start', {
    fen: room.chess.fen(),
    time: room.time,
    timeMode: room.timeMode,
    white: room.players.white,
    black: room.players.black,
    moves: []
  });

  // 20s to make first move or game is abandoned
  room.abandonTimer = setTimeout(() => {
    if (!room.gameStarted && rooms[roomId]) {
      io.to(roomId).emit('game_abandoned');
      cleanupRoom(roomId);
    }
  }, 20000);
}

function startTurnTimer(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);

  room.lastMoveTime = Date.now();
  room.timerInterval = setInterval(() => {
    const turnStr = room.chess.turn();
    const now = Date.now();
    const delta = now - room.lastMoveTime;
    room.time[turnStr] = Math.max(0, room.time[turnStr] - delta);
    room.lastMoveTime = now;

    if (room.time[turnStr] <= 0) {
      room.time[turnStr] = 0;
      clearInterval(room.timerInterval);
      room.timerInterval = null;
      const winner = turnStr === 'w' ? 'black' : 'white';
      io.to(roomId).emit('time_update', room.time);
      io.to(roomId).emit('game_over', { outcome: `${winner} wins`, winner, reason: 'time' });
    } else {
      io.to(roomId).emit('time_update', room.time);
    }
  }, 200);
}

function cleanupRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.abandonTimer) clearTimeout(room.abandonTimer);
  delete rooms[roomId];
}

function broadcastMoveMade(roomId, moveResult) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('move_made', {
    fen: room.chess.fen(),
    move: moveResult,
    san: moveResult.san
  });
}

io.on('connection', (socket) => {
  socket.on('create_room', ({ timeMode = 5 }) => {
    const roomId = uuidv4().slice(0, 8).toUpperCase();
    rooms[roomId] = {
      players: { white: socket.id, black: null },
      rematchVotes: [],
      timeMode: parseInt(timeMode),
      drawOffer: null,
      moves: []
    };
    socket.join(roomId);
    socket.emit('room_created', { roomId, color: 'white' });
  });

  socket.on('join_room', ({ roomId }) => {
    const targetRoomId = roomId.toUpperCase();
    const room = rooms[targetRoomId];
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.black) return socket.emit('error', 'Room is full');

    room.players.black = socket.id;
    socket.join(targetRoomId);
    socket.emit('room_joined', { roomId: targetRoomId, color: 'black' });
    startGame(targetRoomId);
  });

  socket.on('find_random_match', ({ timeMode = 5 }) => {
    const mode = parseInt(timeMode);
    if (matchmakingQueues[mode] && matchmakingQueues[mode] !== socket.id) {
      const roomId = uuidv4().slice(0, 8).toUpperCase();
      const opponentId = matchmakingQueues[mode];
      matchmakingQueues[mode] = null;

      rooms[roomId] = {
        players: { white: opponentId, black: socket.id },
        rematchVotes: [],
        timeMode: mode,
        drawOffer: null,
        moves: []
      };

      const opponentSocket = io.sockets.sockets.get(opponentId);
      if (opponentSocket) opponentSocket.join(roomId);
      socket.join(roomId);

      // Tell both their colors explicitly (helps during transition)
      io.to(opponentId).emit('room_joined', { roomId, color: 'white' });
      io.to(socket.id).emit('room_joined', { roomId, color: 'black' });

      startGame(roomId);
    } else {
      matchmakingQueues[mode] = socket.id;
      socket.emit('searching');
    }
  });

  socket.on('cancel_search', () => {
    Object.keys(matchmakingQueues).forEach(mode => {
      if (matchmakingQueues[mode] === socket.id) matchmakingQueues[mode] = null;
    });
  });

  socket.on('move', ({ roomId, move }) => {
    const room = rooms[roomId];
    if (!room || !room.chess) return;

    const turnStr = room.chess.turn();
    const currentTurn = turnStr === 'w' ? room.players.white : room.players.black;
    if (socket.id !== currentTurn) return;

    // Moving implicitly declines any draw offer
    if (room.drawOffer) {
      room.drawOffer = null;
      socket.to(roomId).emit('draw_declined');
    }

    try {
      const result = room.chess.move(move);
      if (!result) return;

      room.moves = room.moves || [];
      room.moves.push(result);

      if (!room.gameStarted) {
        room.gameStarted = true;
        if (room.abandonTimer) {
          clearTimeout(room.abandonTimer);
          room.abandonTimer = null;
        }
        startTurnTimer(roomId);
      } else {
        const now = Date.now();
        const delta = now - room.lastMoveTime;
        room.time[turnStr] = Math.max(0, room.time[turnStr] - delta);
        startTurnTimer(roomId);
      }

      broadcastMoveMade(roomId, result);
      io.to(roomId).emit('time_update', room.time);

      if (room.chess.isGameOver()) {
        if (room.timerInterval) {
          clearInterval(room.timerInterval);
          room.timerInterval = null;
        }
        const outcomeData = getGameOutcome(room.chess);
        io.to(roomId).emit('game_over', outcomeData);
      }
    } catch (e) {
      socket.emit('error', 'Invalid move');
    }
  });

  socket.on('resign', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.chess) return;

    const isWhite = socket.id === room.players.white;
    const isBlack = socket.id === room.players.black;
    if (!isWhite && !isBlack) return;

    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }

    const winner = isWhite ? 'black' : 'white';
    io.to(roomId).emit('game_over', {
      outcome: `${winner} wins`,
      winner,
      reason: 'resignation'
    });
  });

  socket.on('offer_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.chess || room.chess.isGameOver()) return;

    const isPlayer = socket.id === room.players.white || socket.id === room.players.black;
    if (!isPlayer) return;

    // Can't offer if already offered by self
    if (room.drawOffer === socket.id) return;

    room.drawOffer = socket.id;
    socket.to(roomId).emit('draw_offered', { from: socket.id });
  });

  socket.on('accept_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.chess) return;

    if (!room.drawOffer || room.drawOffer === socket.id) return; // must be the other player accepting

    if (room.timerInterval) {
      clearInterval(room.timerInterval);
      room.timerInterval = null;
    }
    room.drawOffer = null;

    io.to(roomId).emit('game_over', {
      outcome: 'draw',
      winner: null,
      reason: 'agreement'
    });
  });

  socket.on('decline_draw', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (room.drawOffer && room.drawOffer !== socket.id) {
      room.drawOffer = null;
      socket.to(roomId).emit('draw_declined');
    }
  });

  socket.on('abort', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || room.gameStarted) return; // can only abort before first move

    const isPlayer = socket.id === room.players.white || socket.id === room.players.black;
    if (!isPlayer) return;

    io.to(roomId).emit('game_over', {
      outcome: 'Game aborted',
      winner: null,
      reason: 'aborted'
    });
    cleanupRoom(roomId);
  });

  socket.on('rematch', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    if (!room.rematchVotes.includes(socket.id)) {
      room.rematchVotes.push(socket.id);
    }

    if (room.rematchVotes.length >= 2) {
      // Swap colors for fairness (like many platforms)
      const temp = room.players.white;
      room.players.white = room.players.black;
      room.players.black = temp;

      room.rematchVotes = [];
      room.drawOffer = null;

      // Fully restart the game (fresh chess, times, etc.)
      startGame(roomId);
    } else {
      socket.to(roomId).emit('rematch_requested');
    }
  });

  socket.on('disconnect', () => {
    Object.keys(matchmakingQueues).forEach(mode => {
      if (matchmakingQueues[mode] === socket.id) matchmakingQueues[mode] = null;
    });

    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (!room) continue;

      if (room.players.white === socket.id || room.players.black === socket.id) {
        // If game never started, just clean quietly
        if (!room.gameStarted) {
          cleanupRoom(roomId);
          return;
        }
        io.to(roomId).emit('player_left');
        cleanupRoom(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));