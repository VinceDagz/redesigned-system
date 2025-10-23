const mineflayer = require('mineflayer')
const express = require('express')
const http = require('http')
const socketio = require('socket.io')

// --- CONFIGURATION ---
const BOT_BASE_NAME = 'WaguriKaoruko';
const STARTING_BOT_COUNT = 1; 
const BOT_SERVER_CONFIG = {
    host: '185.107.192.98', 
    port: 31729, 
    version: '1.16.5', 
    protocolVersion: 754, 
    // *** CRITICAL NEW ADDITION FOR ATERNOS/CLOUDS ***
    // This forces the bot to announce the full hostname in the handshake packet, 
    // which is essential for proxy systems like ViaVersion/Aternos.
    serverHost: 'arisxze.aternos.me' 
};
const INITIAL_STARTUP_DELAY_MS = 3000; 
const PORT = process.env.PORT || 3000;
// --- END CONFIGURATION ---


// --- GLOBAL STATE ---
let globalBotCounter = 1; 
let bannedBotCount = 0; 
const activeBots = [];
// --- END GLOBAL STATE ---


// --- WEB SERVER SETUP ---
const app = express()
const server = http.createServer(app)
const io = socketio(server)

app.use(express.static('public'))

server.listen(PORT, () => {
    console.log(`Web interface running on http://localhost:${PORT}`)
})


// Helper to find a bot by its username
const getBot = (username) => activeBots.find(b => b.username === username);

// Function to update the bot list AND the counter on the client
function sendBotListUpdate() {
    const botUsernames = activeBots.map(b => b.username);
    io.emit('bot_list', {
        usernames: botUsernames,
        bannedCount: bannedBotCount 
    });
}

// --- BOT LOGIC FUNCTIONS (Encapsulated) ---
function createBot(config) {
    
    const fullConfig = {
        ...config,
        auth: 'offline', 
        keepAlive: true, 
    }
    
    const bot = mineflayer.createBot(fullConfig);

    let antiIdleInterval = null; 
    let movementTimeouts = []; 
    let isAntiIdleActive = false;
    
    function clearMovementTimeouts() {
        movementTimeouts.forEach(timer => clearTimeout(timer));
        movementTimeouts = []; 
    }

    function performAntiIdleMovement() {
        if (!bot.setControlState || !bot.look || !isAntiIdleActive) {
            clearMovementTimeouts(); 
            return;
        }
        
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        
        const scheduleTimeout = (callback, delay) => {
            const timerId = setTimeout(() => {
                if (isAntiIdleActive) {
                    callback();
                }
                movementTimeouts = movementTimeouts.filter(id => id !== timerId);
            }, delay);
            movementTimeouts.push(timerId);
            return timerId;
        };

        // Anti-Idle movement sequence
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        scheduleTimeout(() => {
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
        }, 3000);

        scheduleTimeout(() => {
            const randomYaw = bot.entity.yaw + (Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)) + (Math.random() * Math.PI / 4 - Math.PI / 8);
            bot.look(randomYaw, 0, true); 
        }, 3500);

        scheduleTimeout(() => {
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            scheduleTimeout(() => bot.setControlState('jump', false), 200); 
        }, 6000);

        scheduleTimeout(() => {
            bot.setControlState('forward', false);
            bot.setControlState('back', false);
            bot.setControlState('left', false);
            bot.setControlState('right', false);
            io.emit('bot_log', `[${bot.username}]: Anti-Idle: Sequence complete.`);
        }, 9000);
    }
    
    function startAntiIdle() {
        if (antiIdleInterval) return; 
        isAntiIdleActive = true; 
        performAntiIdleMovement();
        antiIdleInterval = setInterval(performAntiIdleMovement, 15000);
        io.emit('bot_log', `[${bot.username}]: Anti-Idle feature STARTED.`);
    }

    function stopAntiIdle() {
        if (antiIdleInterval) {
            clearInterval(antiIdleInterval);
            antiIdleInterval = null;
            clearMovementTimeouts(); 
            if (bot.setControlState) {
                bot.setControlState('forward', false);
                bot.setControlState('back', false);
                bot.setControlState('left', false);
                bot.setControlState('right', false);
                bot.setControlState('jump', false);
            }
            isAntiIdleActive = false; 
            io.emit('bot_log', `[${bot.username}]: Anti-Idle feature STOPPED.`);
        }
    }
    
    // --- BOT EVENT HANDLERS ---
    
    bot.on('spawn', () => {
        const message = `${bot.username} connected!`
        bot.chat(message)
        io.emit('bot_log', `[${bot.username}]: ✅ Bot spawned and chatted: "${message}"`)
        sendBotListUpdate();
    });

    bot.on('chat', (username, message) => {
        const chatLog = `[${bot.username} <== ${username}]: ${message}`
        console.log(chatLog)
        io.emit('bot_log', chatLog)
    });
    
    bot.on('kicked', (reason) => {
        const reasonString = typeof reason === 'object' ? JSON.stringify(reason) : reason.toString();
        io.emit('bot_log', `[${bot.username}]: ❌ KICKED - ${reasonString}. Initiating name re-roll.`);
        console.log(`[${bot.username}]: KICKED - ${reasonString}. Initiating name re-roll.`);
        
        bannedBotCount++; 
    });
    
    // This logs the ECONNRESET error!
    bot.on('error', (err) => {
        io.emit('bot_log', `[${bot.username}]: ❌ ERROR - ${err.message}`);
        console.error(`[${bot.username}]: ERROR - ${err.message}`);
    });
    
    bot.on('end', (reason) => {
        const oldUsername = bot.username;
        stopAntiIdle(); 
        
        const index = activeBots.findIndex(b => b.username === oldUsername);
        if (index > -1) {
            activeBots.splice(index, 1);
        }
        
        io.emit('bot_log', `[${oldUsername}]: Ended (${reason}). Creating replacement bot...`);

        recreateBot(oldUsername);

        sendBotListUpdate();
    });
    // --- END BOT EVENT HANDLERS ---

    bot.antiIdle = {
        start: startAntiIdle,
        stop: stopAntiIdle,
        isActive: () => isAntiIdleActive
    };
    
    return bot;
}
// --- END BOT LOGIC FUNCTIONS ---


// --- RE-CREATION LOGIC ---
function recreateBot(oldUsername) {
    const newUsername = `${BOT_BASE_NAME}_${globalBotCounter++}`; 
    
    io.emit('bot_log', `[RE-ROLL]: ${oldUsername} is replaced by ${newUsername}. Attempting join in 5s.`);
    
    const newBotConfig = {
        username: newUsername, 
        ...BOT_SERVER_CONFIG
    };

    setTimeout(() => {
        const newBotInstance = createBot(newBotConfig);
        activeBots.push(newBotInstance);
    }, 5000); 
}
// --- END RE-CREATION LOGIC ---


// --- INITIAL STARTUP ---
for (let i = 1; i <= STARTING_BOT_COUNT; i++) {
    const username = `${BOT_BASE_NAME}_${globalBotCounter++}`;
    const botConfig = {
        username: username, 
        ...BOT_SERVER_CONFIG
    };
    
    setTimeout(() => {
        const botInstance = createBot(botConfig);
        activeBots.push(botInstance);
    }, INITIAL_STARTUP_DELAY_MS * i); 
}
// --- END INITIAL STARTUP ---


// --- SOCKET.IO FOR BOT CONTROL ---
io.on('connection', (socket) => {
    // ... (rest of the socket control logic is unchanged)
    console.log('A web client connected.')
    
    sendBotListUpdate(); 
    io.emit('bot_log', 'Web client connected. Bot list and ban count sent.');

    // LISTENER 1: CHAT COMMANDS
    socket.on('send_chat_command', ({ username, message }) => {
        const bot = getBot(username);
        if (bot && bot.chat) {
            bot.chat(message)
            io.emit('bot_log', `[${bot.username}]: Web command executed: CHAT "${message}"`)
        } else {
            io.emit('bot_log', `ERROR: Bot ${username} not found or ready to chat.`)
        }
    })
    
    // LISTENER 2: MOVEMENT CONTROL COMMANDS
    socket.on('send_control_command', ({ username, control, state }) => {
        const bot = getBot(username);
        if (!bot || !bot.setControlState) {
             io.emit('bot_log', `ERROR: Bot ${username} not found or ready for control commands.`)
             return;
        }
        
        if (bot.antiIdle.isActive() && control !== 'all') {
            io.emit('bot_log', `[${bot.username}]: Manual control rejected: ${control}. Anti-Idle is running.`);
            return; 
        }

        if (control === 'all' && state === false) {
            bot.antiIdle.stop();
            bot.clearControlStates(); 
        } else {
            bot.setControlState(control, state)
        }
        
        io.emit('bot_log', `[${bot.username}]: Control executed: ${control} set to ${state}`)
    })
    
    // LISTENER 3: ANTI-IDLE TOGGLE COMMAND
    socket.on('anti_idle_command', ({ username, state }) => {
        const bot = getBot(username);
        if (!bot) {
            io.emit('bot_log', `ERROR: Bot ${username} not found.`);
            return;
        }

        if (state === 'start') {
            bot.antiIdle.stop();
            bot.antiIdle.start();
        } else if (state === 'stop') {
            bot.antiIdle.stop();
        }
    })

    socket.on('disconnect', () => {
        console.log('A web client disconnected.')
        io.emit('bot_log', 'Web client disconnected.')
    })
})
