const mineflayer = require('mineflayer')
const express = require('express')
const http = require('http')
const socketio = require('socket.io')

// --- CONFIGURATION ---
const BOT_BASE_NAME = 'WaguriKaoruko';
const STARTING_BOT_COUNT = 3; // The number of bots to start with, but not a limit.
const BOT_SERVER_CONFIG = {
    host: 'arisxze.aternos.me', 
    port: 31729, 
    version: '1.16.5'
};
const PORT = process.env.PORT || 3000;
// --- END CONFIGURATION ---


// --- GLOBAL STATE ---
// This counter tracks the next sequential number for bot names (e.g., _4, _5, _6...)
let globalBotCounter = 1; 
// NEW: Tracks how many bots have been replaced (banned/kicked)
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
        bannedCount: bannedBotCount // Send the updated ban count
    });
}

// --- BOT LOGIC FUNCTIONS (Encapsulated) ---

// Function to handle bot creation and manage its state
function createBot(config) {
    const bot = mineflayer.createBot(config);

    // State variables for THIS specific bot instance
    let antiIdleInterval = null; 
    let movementTimeouts = []; 
    let isAntiIdleActive = false;
    
    // Helper function to clear all movement-related timers
    function clearMovementTimeouts() {
        movementTimeouts.forEach(timer => clearTimeout(timer));
        movementTimeouts = []; 
    }

    // Function to perform anti-idle movement (same as before)
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
        io.emit('bot_log', `[${bot.username}]: Bot spawned and chatted: "${message}"`)
        sendBotListUpdate();
    });

    bot.on('chat', (username, message) => {
        const chatLog = `[${bot.username} <== ${username}]: ${message}`
        console.log(chatLog)
        io.emit('bot_log', chatLog)
    });
    
    bot.on('kicked', (reason) => {
        io.emit('bot_log', `[${bot.username}]: KICKED - ${reason}. Initiating name re-roll.`);
        console.log(`[${bot.username}]: KICKED - ${reason}. Initiating name re-roll.`);
        
        // When a bot is kicked, we assume it needs replacing
        bannedBotCount++; // Increment the global counter
    });
    
    bot.on('error', (err) => {
        io.emit('bot_log', `[${bot.username}]: ERROR - ${err.message}`);
        console.log(`[${bot.username}]: ERROR - ${err.message}`);
    });
    
    bot.on('end', () => {
        const oldUsername = bot.username;
        stopAntiIdle(); 
        
        // 1. Remove the old bot from the active list
        const index = activeBots.findIndex(b => b.username === oldUsername);
        if (index > -1) {
            activeBots.splice(index, 1);
        }
        
        io.emit('bot_log', `[${oldUsername}]: Ended. Creating replacement bot...`);

        // 2. Immediately create a new bot with the next available number
        recreateBot(oldUsername);

        // 3. Update the client UI
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

// --- RE-CREATION LOGIC ---
function recreateBot(oldUsername) {
    // There is no limit here; it will always increment and create a new bot.
    const newUsername = `${BOT_BASE_NAME}_${globalBotCounter++}`; 
    
    io.emit('bot_log', `[RE-ROLL]: ${oldUsername} is replaced by ${newUsername}. Attempting join in 5s.`);
    
    const newBotConfig = {
        username: newUsername, 
        ...BOT_SERVER_CONFIG
    };

    // Wait 5 seconds before attempting to join to avoid immediate connection throttling
    setTimeout(() => {
        const newBotInstance = createBot(newBotConfig);
        activeBots.push(newBotInstance);
    }, 5000); 
}
// --- END RE-CREATION LOGIC ---


// --- INITIAL STARTUP ---
// Start creating the initial set of bots
for (let i = 1; i <= STARTING_BOT_COUNT; i++) {
    const username = `${BOT_BASE_NAME}_${globalBotCounter++}`;
    const botConfig = {
        username: username, 
        ...BOT_SERVER_CONFIG
    };
    const botInstance = createBot(botConfig);
    activeBots.push(botInstance);
}


// --- SOCKET.IO FOR BOT CONTROL ---
io.on('connection', (socket) => {
    console.log('A web client connected.')
    
    sendBotListUpdate(); // Send the initial list and counter immediately upon client connection
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
        }
        
        bot.setControlState(control, state)
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
