const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ─── Mots français ───
const WORDS = [
  'AGENT', 'AIGLE', 'AMOUR', 'ARBRE', 'ARGENT', 'ARMÉE', 'AVION', 'BALLON',
  'BANQUE', 'BATEAU', 'BOMBE', 'BOUGIE', 'CAFÉ', 'CARTE', 'CHAÎNE', 'CHAPEAU',
  'CHAT', 'CHÂTEAU', 'CHEMIN', 'CHEVAL', 'CIEL', 'CINÉMA', 'CLÉ', 'COEUR',
  'COUTEAU', 'CRÈME', 'DANGER', 'DANSE', 'DIAMANT', 'DRAPEAU', 'EAU', 'ÉCOLE',
  'ÉTOILE', 'FER', 'FEU', 'FLEUR', 'FORÊT', 'FUSÉE', 'GLACE', 'GUERRE',
  'HÔPITAL', 'ÎLE', 'JARDIN', 'LION', 'LOUP', 'LUMIÈRE', 'LUNE', 'MACHINE',
  'MAISON', 'MER', 'MIROIR', 'MONTAGNE', 'MOTO', 'MUSIQUE', 'NEIGE', 'NOIR',
  'NUAGE', 'OISEAU', 'OMBRE', 'OR', 'ORANGE', 'PALAIS', 'PAPIER', 'PIÈGE',
  'PIERRE', 'PIRATE', 'PLAGE', 'PLANÈTE', 'PLANTE', 'POISON', 'POMME', 'PONT',
  'PORTE', 'PRINCE', 'PRISON', 'RADAR', 'REINE', 'ROBOT', 'ROCHER', 'ROSE',
  'ROUTE', 'SABLE', 'SECRET', 'SERPENT', 'SOLDAT', 'SOLEIL', 'SOURIS', 'TEMPS',
  'TERRE', 'TIGRE', 'TOUR', 'TRAIN', 'TRÉSOR', 'VAMPIRE', 'VENT', 'VERRE',
  'VIRUS', 'VOITURE', 'VOLCAN', 'VOYAGE', 'DRAGON', 'ESPION', 'FANTÔME', 'GÉANT',
  'HERBE', 'JOURNAL', 'LASER', 'MARCHÉ', 'NUIT', 'OPÉRA', 'PARC', 'RADIO',
  'RIVIÈRE', 'SCIENCE', 'STATUE', 'TEMPLE', 'TOILE', 'UNIVERS', 'VILLE', 'ZÉRO',
  'ANCRE', 'BAGUE', 'CANON', 'DÉSERT', 'ÉPÉE', 'FAUCON', 'GUITARE', 'HÉLICE',
  'ICÔNE', 'JUNGLE', 'KAYAK', 'LAMPE', 'MÉDAILLE', 'NAVIRE', 'OLYMPE', 'PANDA',
  'RÊVE', 'SIRÈNE', 'TRÔNE', 'UNIFORME', 'VALISE', 'WESTERN', 'YACHT', 'ZOMBIE',
  'ATLAS', 'BRONZE', 'CRISTAL', 'DUEL', 'ÉCHO', 'FLAMME', 'GRIFFE', 'HORIZON',
  'IVOIRE', 'JADE', 'MASQUE', 'NECTAR', 'OASIS', 'PHARE', 'QUARTZ', 'SABRE'
];

const rooms = {};

// ─── Sessions : sessionId → { roomId, playerId, playerName, team, role } ───
// Permet la reconnexion après rechargement de page
const sessions = {};

// Durée avant suppression d'un joueur déconnecté (5 min)
const DISCONNECT_TIMEOUT = 5 * 60 * 1000;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateBoard() {
  const words = shuffle(WORDS).slice(0, 25);
  const startingTeam = Math.random() < 0.5 ? 'red' : 'blue';
  const types = [];
  const first = startingTeam === 'red' ? 9 : 8;
  const second = startingTeam === 'red' ? 8 : 9;
  for (let i = 0; i < first; i++) types.push('red');
  for (let i = 0; i < second; i++) types.push('blue');
  for (let i = 0; i < 7; i++) types.push('neutral');
  types.push('assassin');
  const shuffledTypes = shuffle(types);
  return {
    cards: words.map((word, i) => ({ word, type: shuffledTypes[i], revealed: false })),
    startingTeam,
  };
}

function createRoom(roomId) {
  const { cards, startingTeam } = generateBoard();
  return {
    id: roomId,
    cards,
    startingTeam,
    currentTeam: startingTeam,
    phase: 'lobby',
    players: {},       // playerId → { id, name, team, role, socket, disconnectTimer, online }
    clue: null,
    clueCount: 0,
    guessesUsed: 0,
    guessesMax: 0,
    isUnlimited: false,
    selectedCard: -1,
    redScore: 0,
    blueScore: 0,
    redTotal: startingTeam === 'red' ? 9 : 8,
    blueTotal: startingTeam === 'red' ? 8 : 9,
    winner: null,
    log: [],
  };
}

function isPlayerSolo(room, player) {
  if (!player || !player.team) return false;
  const teammates = Object.values(room.players).filter(p => p.team === player.team);
  return teammates.length === 1;
}

function canPlayerGiveClue(room, player) {
  if (!player || player.team !== room.currentTeam) return false;
  if (player.role === 'spymaster') return true;
  if (isPlayerSolo(room, player)) return true;
  return false;
}

function canPlayerGuess(room, player) {
  if (!player || player.team !== room.currentTeam) return false;
  if (player.role === 'operative') return true;
  if (isPlayerSolo(room, player)) return true;
  return false;
}

function canPlayerSeeBoard(room, player) {
  if (!player) return false;
  if (player.role === 'spymaster') return true;
  if (isPlayerSolo(room, player)) return true;
  return false;
}

function getRoomState(room, playerId) {
  const player = room.players[playerId];
  const seeAll = canPlayerSeeBoard(room, player);

  return {
    id: room.id,
    cards: room.cards.map(c => ({
      word: c.word,
      type: c.revealed || seeAll ? c.type : 'hidden',
      revealed: c.revealed,
    })),
    currentTeam: room.currentTeam,
    phase: room.phase,
    players: Object.values(room.players).map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      role: p.role,
      online: p.online,
    })),
    clue: room.clue,
    clueCount: room.clueCount,
    guessesUsed: room.guessesUsed,
    guessesMax: room.guessesMax,
    isUnlimited: room.isUnlimited,
    selectedCard: room.selectedCard,
    redScore: room.redScore,
    blueScore: room.blueScore,
    redTotal: room.redTotal,
    blueTotal: room.blueTotal,
    startingTeam: room.startingTeam,
    winner: room.winner,
    log: room.log,
    you: player ? { id: player.id, name: player.name, team: player.team, role: player.role, solo: isPlayerSolo(room, player) } : null,
  };
}

function broadcastRoom(room) {
  for (const pid of Object.keys(room.players)) {
    const p = room.players[pid];
    if (p.socket && p.online) {
      p.socket.emit('gameState', getRoomState(room, pid));
    }
  }
}

function addLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 60) room.log.shift();
}

function checkWin(room) {
  if (room.redScore >= room.redTotal) {
    room.phase = 'gameover';
    room.winner = 'red';
    addLog(room, '🏆 L\'équipe ROUGE a gagné !');
    return true;
  }
  if (room.blueScore >= room.blueTotal) {
    room.phase = 'gameover';
    room.winner = 'blue';
    addLog(room, '🏆 L\'équipe BLEUE a gagné !');
    return true;
  }
  return false;
}

function endTurn(room) {
  room.currentTeam = room.currentTeam === 'red' ? 'blue' : 'red';
  room.phase = 'clue';
  room.clue = null;
  room.clueCount = 0;
  room.guessesUsed = 0;
  room.guessesMax = 0;
  room.isUnlimited = false;
  room.selectedCard = -1;
  addLog(room, `───── Tour ${room.currentTeam === 'red' ? 'ROUGE' : 'BLEU'} ─────`);
}

function cleanupRoom(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const hasOnline = Object.values(room.players).some(p => p.online);
  if (!hasOnline && Object.values(room.players).every(p => !p.disconnectTimer)) {
    delete rooms[roomId];
  }
}

// ─── Socket.IO ───
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerId = null;

  // ── Rejoindre une salle (nouveau joueur ou reconnexion) ──
  socket.on('joinRoom', ({ roomId, playerName, sessionId }) => {
    roomId = roomId.toUpperCase().trim();
    playerName = (playerName || 'Joueur').trim().substring(0, 20);

    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId);
    }
    const room = rooms[roomId];

    // Vérifier si c'est une reconnexion via sessionId
    let reconnected = false;
    if (sessionId && sessions[sessionId]) {
      const sess = sessions[sessionId];
      if (sess.roomId === roomId && room.players[sess.playerId]) {
        // Reconnexion !
        playerId = sess.playerId;
        const player = room.players[playerId];
        if (player.disconnectTimer) {
          clearTimeout(player.disconnectTimer);
          player.disconnectTimer = null;
        }
        player.socket = socket;
        player.online = true;
        currentRoom = roomId;
        socket.join(roomId);
        addLog(room, `🔄 ${player.name} s'est reconnecté.`);
        socket.emit('session', { sessionId });
        broadcastRoom(room);
        reconnected = true;
      }
    }

    if (!reconnected) {
      // Nouveau joueur
      const newSessionId = crypto.randomUUID();
      playerId = newSessionId; // use session as player id for stability
      currentRoom = roomId;

      room.players[playerId] = {
        id: playerId,
        name: playerName,
        team: null,
        role: null,
        socket,
        online: true,
        disconnectTimer: null,
      };

      sessions[newSessionId] = {
        roomId,
        playerId,
        playerName,
      };

      socket.join(roomId);
      socket.emit('session', { sessionId: newSessionId });
      addLog(room, `👤 ${playerName} a rejoint la salle.`);
      broadcastRoom(room);
    }
  });

  socket.on('chooseTeam', ({ team, role }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players[playerId];
    if (!player) return;
    if (room.phase !== 'lobby') return;
    if (!['red', 'blue'].includes(team)) return;
    if (!['spymaster', 'operative'].includes(role)) return;

    if (role === 'spymaster') {
      const existing = Object.values(room.players).find(
        p => p.team === team && p.role === 'spymaster' && p.id !== playerId
      );
      if (existing) {
        socket.emit('error', `Il y a déjà un Maître-Espion ${team === 'red' ? 'rouge' : 'bleu'}.`);
        return;
      }
    }

    player.team = team;
    player.role = role;

    // Update session
    for (const [sid, sess] of Object.entries(sessions)) {
      if (sess.playerId === playerId) {
        sess.team = team;
        sess.role = role;
        break;
      }
    }

    addLog(room, `👤 ${player.name} → ${team === 'red' ? 'ROUGE' : 'BLEU'} ${role === 'spymaster' ? '🕵️ Maître-Espion' : '🔍 Agent'}`);
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'lobby') return;

    const players = Object.values(room.players);
    const redPlayers = players.filter(p => p.team === 'red');
    const bluePlayers = players.filter(p => p.team === 'blue');

    if (redPlayers.length === 0 || bluePlayers.length === 0) {
      socket.emit('error', 'Chaque équipe doit avoir au moins 1 joueur.');
      return;
    }

    // En mode classique (2+ par équipe), il faut un spymaster et un operative
    if (redPlayers.length > 1) {
      const redSpy = redPlayers.find(p => p.role === 'spymaster');
      const redOp = redPlayers.find(p => p.role === 'operative');
      if (!redSpy || !redOp) {
        socket.emit('error', 'L\'équipe Rouge a besoin d\'un Maître-Espion et d\'un Agent (ou 1 seul joueur en mode solo).');
        return;
      }
    }
    if (bluePlayers.length > 1) {
      const blueSpy = bluePlayers.find(p => p.role === 'spymaster');
      const blueOp = bluePlayers.find(p => p.role === 'operative');
      if (!blueSpy || !blueOp) {
        socket.emit('error', 'L\'équipe Bleue a besoin d\'un Maître-Espion et d\'un Agent (ou 1 seul joueur en mode solo).');
        return;
      }
    }

    room.phase = 'clue';
    addLog(room, `🎮 Partie lancée !`);
    addLog(room, `───── Tour ${room.currentTeam === 'red' ? 'ROUGE' : 'BLEU'} ─────`);
    broadcastRoom(room);
  });

  socket.on('giveClue', ({ word, count }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'clue') return;

    const player = room.players[playerId];
    if (!player || !canPlayerGiveClue(room, player)) return;

    word = (word || '').trim().toUpperCase();
    const isInfinity = count === '∞' || count === 'infinity' || count === '*';
    const numCount = isInfinity ? 0 : parseInt(count);

    if (!word) { socket.emit('error', 'Donne un mot indice !'); return; }
    if (!isInfinity && (isNaN(numCount) || numCount < 0 || numCount > 9)) {
      socket.emit('error', 'Nombre invalide (0-9 ou ∞).'); return;
    }

    const unlimited = isInfinity || numCount === 0;
    room.clue = word;
    room.clueCount = isInfinity ? '∞' : numCount;
    room.guessesUsed = 0;
    room.isUnlimited = unlimited;
    // EXACTEMENT le nombre donné par le maître-espion (pas +1)
    room.guessesMax = unlimited ? 25 : numCount;
    room.selectedCard = -1;
    room.phase = 'guess';

    addLog(room, `🕵️ ${player.name} : « ${word} » → ${room.clueCount}`);
    broadcastRoom(room);
  });

  socket.on('selectCard', ({ index }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'guess') return;

    const player = room.players[playerId];
    if (!player || !canPlayerGuess(room, player)) return;
    if (index < 0 || index >= 25) return;
    if (room.cards[index].revealed) return;

    room.selectedCard = index;
    broadcastRoom(room);
  });

  socket.on('confirmGuess', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'guess') return;

    const player = room.players[playerId];
    if (!player || !canPlayerGuess(room, player)) return;
    if (room.selectedCard < 0 || room.selectedCard >= 25) {
      socket.emit('error', 'Sélectionne d\'abord une carte !'); return;
    }

    const index = room.selectedCard;
    const card = room.cards[index];
    if (card.revealed) return;

    card.revealed = true;
    room.selectedCard = -1;

    const typeLabel = card.type === 'red' ? '🟥 ROUGE' :
                      card.type === 'blue' ? '🟦 BLEU' :
                      card.type === 'assassin' ? '💀 ASSASSIN' : '⬜ NEUTRE';

    addLog(room, `🔍 ${player.name} : « ${card.word} » → ${typeLabel}`);

    if (card.type === 'red') room.redScore++;
    if (card.type === 'blue') room.blueScore++;

    // ASSASSIN → perte immédiate
    if (card.type === 'assassin') {
      room.phase = 'gameover';
      room.winner = room.currentTeam === 'red' ? 'blue' : 'red';
      addLog(room, `💀 ASSASSIN ! L'équipe ${room.currentTeam === 'red' ? 'ROUGE' : 'BLEUE'} perd !`);
      broadcastRoom(room);
      return;
    }

    if (checkWin(room)) { broadcastRoom(room); return; }

    // Bonne réponse
    if (card.type === room.currentTeam) {
      room.guessesUsed++;
      if (!room.isUnlimited && room.guessesUsed >= room.guessesMax) {
        addLog(room, `⏰ ${room.guessesMax} essai(s) utilisés. Fin du tour.`);
        endTurn(room);
      } else {
        const remaining = room.isUnlimited ? '∞' : (room.guessesMax - room.guessesUsed);
        addLog(room, `✅ Correct ! Encore ${remaining} essai(s).`);
      }
    }
    // Carte adversaire
    else if (card.type === 'red' || card.type === 'blue') {
      addLog(room, `❌ Mot ${card.type === 'red' ? 'ROUGE' : 'BLEU'} ! Fin du tour.`);
      endTurn(room);
    }
    // Neutre
    else {
      addLog(room, `⬜ Neutre. Fin du tour.`);
      endTurn(room);
    }

    broadcastRoom(room);
  });

  socket.on('endGuessing', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'guess') return;

    const player = room.players[playerId];
    if (!player || !canPlayerGuess(room, player)) return;

    addLog(room, `⏭️ ${player.name} passe. Fin du tour.`);
    endTurn(room);
    broadcastRoom(room);
  });

  socket.on('newGame', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const { cards, startingTeam } = generateBoard();
    room.cards = cards;
    room.startingTeam = startingTeam;
    room.currentTeam = startingTeam;
    room.phase = 'lobby';
    room.clue = null;
    room.clueCount = 0;
    room.guessesUsed = 0;
    room.guessesMax = 0;
    room.isUnlimited = false;
    room.selectedCard = -1;
    room.redScore = 0;
    room.blueScore = 0;
    room.redTotal = startingTeam === 'red' ? 9 : 8;
    room.blueTotal = startingTeam === 'red' ? 8 : 9;
    room.winner = null;
    room.log = [];

    for (const p of Object.values(room.players)) {
      p.team = null;
      p.role = null;
    }

    addLog(room, '🔄 Nouvelle partie !');
    broadcastRoom(room);
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      const room = rooms[currentRoom];
      const player = room.players[playerId];
      if (player) {
        player.online = false;
        player.socket = null;
        addLog(room, `⚠️ ${player.name} s'est déconnecté (reconnexion possible).`);
        broadcastRoom(room);

        // Timer : supprimer après 5 min si pas reconnecté
        player.disconnectTimer = setTimeout(() => {
          if (room.players[playerId] && !room.players[playerId].online) {
            addLog(room, `👤 ${player.name} a quitté définitivement.`);
            delete room.players[playerId];
            broadcastRoom(room);
            cleanupRoom(currentRoom);
          }
          // Nettoyer la session
          for (const [sid, sess] of Object.entries(sessions)) {
            if (sess.playerId === playerId) {
              delete sessions[sid];
              break;
            }
          }
        }, DISCONNECT_TIMEOUT);
      }
    }
  });
});

const PORT = process.env.PORT || 2228;
server.listen(PORT, () => {
  console.log(`🎮 Codenames server running on http://localhost:${PORT}`);
});
