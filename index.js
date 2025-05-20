require('dotenv').config();
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const path = require('path');
const { Vec3 } = require('vec3'); // <-- Add this line

// --- Config ---
const config = {
  host: process.env.MC_HOST,
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME,
  password: process.env.MC_PASSWORD || '',
  version: process.env.MC_VERSION || '1.20.1',
  webPort: Number(process.env.PORT || 3000),
  reconnectDelay: Number(process.env.RECONNECT_DELAY || 5000),
  chatProbability: Number(process.env.CHAT_PROBABILITY || 0.08),
  actionInterval: [5000, 15000], // 5-15 seconds between actions
  movementRadius: Number(process.env.MOVEMENT_RADIUS || 20)
};

const chatMessages = [
  "Hello world!",
  "Nice day here!",
  "Just vibing...",
  "Anyone around?",
  "Exploring the area",
  "This place looks cool",
  "AFK but still here",
  "Wandering around",
  "The view here is nice",
  "Peaceful here"
];

// --- Express & Socket.io Setup ---
const app = express();
const server = http.createServer(app);
const io = socketio(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/api/status', (_, res) => {
  res.json({ 
    status: botInstance ? 'connected' : 'disconnected',
    username: botInstance?.username || null,
    timestamp: new Date().toISOString()
  });
});

server.listen(config.webPort, '0.0.0.0', () => {
  log('Server', `Dashboard running on port ${config.webPort}`);
});

// --- Bot State ---
let botInstance = null;
let reconnectAttempts = 0;
let spawnPoint = null;
let isMoving = false;
let lastActionTime = 0;
let lastChatTime = 0;

// --- Utilities ---
function log(module, message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${module}] ${message}`;
  console.log(logMessage);
  io.emit('log', { module, message, timestamp });
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function getNextActionDelay() {
  return randomInt(...config.actionInterval);
}

// --- Bot Actions ---
function performJump() {
  if (!botInstance) return;
  const duration = randomInt(200, 800);
  botInstance.setControlState('jump', true);
  setTimeout(() => {
    if (botInstance) botInstance.setControlState('jump', false);
  }, duration);
  log('Action', `Jumped for ${duration}ms`);
}

function performSneak() {
  if (!botInstance) return;
  const duration = randomInt(1000, 4000);
  botInstance.setControlState('sneak', true);
  setTimeout(() => {
    if (botInstance) botInstance.setControlState('sneak', false);
  }, duration);
  log('Action', `Sneaking for ${duration}ms`);
}

function performChat() {
  if (!botInstance) return;
  const now = Date.now();
  if (now - lastChatTime < 10000) return; // 10 second chat cooldown
  
  if (Math.random() < config.chatProbability) {
    const message = chatMessages[Math.floor(Math.random() * chatMessages.length)];
    botInstance.chat(message);
    lastChatTime = now;
    log('Action', `Sent chat: "${message}"`);
  }
}

async function performMovement() {
  if (!botInstance || !spawnPoint || isMoving) return;
  
  isMoving = true;
  try {
    // Calculate random position within radius
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.random() * config.movementRadius;
    const targetX = spawnPoint.x + Math.cos(angle) * distance;
    const targetZ = spawnPoint.z + Math.sin(angle) * distance;
    
    // Find safe Y level
    let targetY = spawnPoint.y;
    for (let dy = 3; dy >= -5; dy--) {
      // Use Vec3 for blockAt
      const block = botInstance.blockAt(new Vec3(targetX, spawnPoint.y + dy, targetZ));
      if (block && block.name !== 'air' && block.name !== 'water' && block.name !== 'lava') {
        targetY = spawnPoint.y + dy + 1;
        break;
      }
    }
    
    const goal = new GoalNear(targetX, targetY, targetZ, 1);
    await botInstance.pathfinder.goto(goal);
    
    // Random look around after movement
    if (Math.random() < 0.4) {
      const yaw = Math.random() * Math.PI * 2;
      const pitch = (Math.random() - 0.5) * Math.PI * 0.3;
      botInstance.look(yaw, pitch, false);
    }
    
    log('Action', `Moved to (${Math.round(targetX)}, ${Math.round(targetY)}, ${Math.round(targetZ)})`);
  } catch (error) {
    log('Error', `Movement failed: ${error.message}`);
  } finally {
    isMoving = false;
  }
}

// --- Random Action Controller ---
function performRandomAction() {
  if (!botInstance || !spawnPoint) return;
  
  const now = Date.now();
  if (now - lastActionTime < getNextActionDelay()) return;
  
  lastActionTime = now;
  
  const action = Math.random();
  if (action < 0.5) {
    performMovement();
  } else if (action < 0.7) {
    performJump();
  } else if (action < 0.85) {
    performSneak();
  } else {
    performChat();
  }
}

// --- Bot Creation ---
function createBot() {
  if (botInstance) return;
  
  log('Bot', 'Creating new bot instance...');
  
  botInstance = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password,
    version: config.version
  });

  botInstance.loadPlugin(pathfinder);

  botInstance.once('login', () => {
    log('Bot', `Logged in as ${botInstance.username}`);
    reconnectAttempts = 0;
    io.emit('status', { connected: true, username: botInstance.username });
  });

  botInstance.once('spawn', () => {
    log('Bot', 'Bot spawned successfully');
    spawnPoint = botInstance.entity.position.clone();
    
    // Setup pathfinding
    const mcData = require('minecraft-data')(botInstance.version);
    const movements = new Movements(botInstance, mcData);
    movements.allowFreeMotion = false;
    movements.allowParkour = true;
    movements.allowSprinting = true;
    movements.scaffoldingBlocks = [];
    botInstance.pathfinder.setMovements(movements);
    
    log('Bot', `Spawn point set: (${Math.round(spawnPoint.x)}, ${Math.round(spawnPoint.y)}, ${Math.round(spawnPoint.z)})`);
  });

  botInstance.on('death', () => {
    log('Bot', 'Bot died, will respawn');
    setTimeout(() => {
      if (botInstance?.entity?.position) {
        spawnPoint = botInstance.entity.position.clone();
        log('Bot', 'Spawn point updated after respawn');
      }
    }, 3000);
  });

  botInstance.on('physicsTick', () => {
    performRandomAction();
  });

  // Error handling
  botInstance.on('error', (error) => {
    log('Error', `Bot error: ${error.message}`);
    handleDisconnection();
  });

  botInstance.on('end', () => {
    log('Bot', 'Connection ended');
    handleDisconnection();
  });

  botInstance.on('kicked', (reason) => {
    log('Bot', `Kicked from server: ${reason}`);
    handleDisconnection();
  });
}

// --- Reconnection Logic ---
function handleDisconnection() {
  if (botInstance) {
    try { botInstance.quit(); } catch {}
    botInstance = null;
    spawnPoint = null;
    isMoving = false;
  }
  
  io.emit('status', { connected: false, reconnecting: true });
  
  reconnectAttempts++;
  const delay = Math.min(config.reconnectDelay * reconnectAttempts, 60000); // Max 1 minute delay
  
  log('Bot', `Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts})`);
  setTimeout(createBot, delay);
}

// --- Socket.io Events ---
io.on('connection', (socket) => {
  socket.emit('status', { 
    connected: !!botInstance, 
    username: botInstance?.username || null 
  });
  
  socket.on('ping', () => {
    socket.emit('pong', { 
      connected: !!botInstance,
      username: botInstance?.username || null,
      timestamp: new Date().toISOString()
    });
  });
});

// --- Graceful Shutdown ---
function shutdown() {
  log('Server', 'Shutting down...');
  if (botInstance) {
    try { botInstance.quit(); } catch {}
  }
  server.close(() => {
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (err) => {
  log('Error', `Unhandled rejection: ${err.message}`);
});

// --- Start ---
createBot();
