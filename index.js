const mineflayer = require('mineflayer')
const express = require('express')
const http = require('http')
const socketio = require('socket.io')

// --- WEB SERVER SETUP ---
const app = express()
const server = http.createServer(app)
const io = socketio(server)
const PORT = process.env.PORT || 3000 // Use environment variable for hosting

// Serve the 'public' folder for the front-end files
app.use(express.static('public'))

server.listen(PORT, () => {
    console.log(`Web interface running on http://localhost:${PORT}`)
})

// --- MINEFLAYER BOT SETUP ---

function createBot () {
    const bot = mineflayer.createBot({
        host: 'arisxzesmp.aternos.me', // SERVER IP
        username: 'WaguriiBot', // BOT NAME
        port: 31729,  // SERVER PORT
        version: '1.16.5',
    })

    let antiIdleInterval = null; 
    let movementTimeouts = []; 
    let isAntiIdleActive = false; // Master flag for anti-idle status

    // Helper function to clear all movement-related timers
    function clearMovementTimeouts() {
        movementTimeouts.forEach(timer => clearTimeout(timer));
        movementTimeouts = []; 
    }

    // Function to perform a complex movement sequence
    function performAntiIdleMovement() {
        // Crucially, check flag before running a sequence
        if (!bot.setControlState || !bot.look || !isAntiIdleActive) {
            // If the flag got cleared while a sequence was waiting, stop immediately
            clearMovementTimeouts(); 
            return;
        }
        
        // Ensure controls are clear before starting a new sequence
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        
        const scheduleTimeout = (callback, delay) => {
            const timerId = setTimeout(() => {
                // Also check the flag inside the timeout before executing the action
                if (isAntiIdleActive) {
                    callback();
                }
                movementTimeouts = movementTimeouts.filter(id => id !== timerId);
            }, delay);
            movementTimeouts.push(timerId);
            return timerId;
        };

        // Sequence 1: Walk forward and jump (3 seconds)
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        scheduleTimeout(() => {
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
        }, 3000);

        // Sequence 2: Turn 90-180 degrees randomly (3.5 seconds)
        scheduleTimeout(() => {
            const randomYaw = bot.entity.yaw + (Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1)) + (Math.random() * Math.PI / 4 - Math.PI / 8);
            bot.look(randomYaw, 0, true); 
        }, 3500);

        // Sequence 3: Walk forward again (6 seconds)
        scheduleTimeout(() => {
            bot.setControlState('forward', true);
            // Quick jump to keep momentum
            bot.setControlState('jump', true);
            scheduleTimeout(() => bot.setControlState('jump', false), 200); 
        }, 6000);

        // Sequence 4: Stop all movement (9 seconds)
        scheduleTimeout(() => {
            bot.setControlState('forward', false);
            bot.setControlState('back', false);
            bot.setControlState('left', false);
            bot.setControlState('right', false);
            io.emit('bot_log', 'Anti-Idle: Full sequence complete, waiting for next cycle.');
        }, 9000);
    }
    
    // Function to start the anti-idle loop
    function startAntiIdle() {
        if (antiIdleInterval) return; 
        
        isAntiIdleActive = true; // SET MASTER FLAG
        
        // Initial movement immediately
        performAntiIdleMovement();
        
        // Anti-Idle: Repeat the movement every 15 seconds (15000ms) 
        antiIdleInterval = setInterval(performAntiIdleMovement, 15000);
        
        io.emit('bot_log', 'Anti-Idle feature STARTED. Performing complex movement every 15s.');
        console.log('Anti-Idle feature STARTED.');
    }

    // Function to stop the movement loop
    function stopAntiIdle() {
        if (antiIdleInterval) {
            clearInterval(antiIdleInterval);
            antiIdleInterval = null;
            
            clearMovementTimeouts(); 
            
            // Stop all bot controls immediately
            if (bot.setControlState) {
                bot.setControlState('forward', false);
                bot.setControlState('back', false);
                bot.setControlState('left', false);
                bot.setControlState('right', false);
                bot.setControlState('jump', false);
            }
            
            isAntiIdleActive = false; // CLEAR MASTER FLAG
            
            io.emit('bot_log', 'Anti-Idle feature STOPPED. All controls cleared.');
            console.log('Anti-Idle feature STOPPED.');
        }
    }


    bot.on('spawn', () => {
        const message = 'Kaoruko Waguri Desu!!'
        bot.chat(message)
        io.emit('bot_log', `Bot spawned and chatted: "${message}"`)
    });

    // Handle incoming chat messages and forward them to the web client
    bot.on('chat', (username, message) => {
        const chatLog = `[${username}]: ${message}`
        console.log(chatLog)
        io.emit('bot_log', chatLog)
    })

    // --- SOCKET.IO FOR BOT CONTROL ---
    io.on('connection', (socket) => {
        console.log('A web client connected.')
        io.emit('bot_log', 'Web client connected. You can now send commands.')

        // LISTENER 1: CHAT COMMANDS
        // This listener is NOT affected by the anti-idle state, so chat always works.
        socket.on('send_chat_command', (message) => {
            console.log(`Received command from web: CHAT - ${message}`)
            if (bot.chat) {
                bot.chat(message)
                io.emit('bot_log', `Web command executed: CHAT "${message}"`)
            } else {
                io.emit('bot_log', 'ERROR: Bot object not ready to chat.')
            }
        })
        
        // LISTENER 2: MOVEMENT CONTROL COMMANDS
        socket.on('send_control_command', ({ control, state }) => {
            console.log(`Received command from web: CONTROL - ${control}: ${state}`)
            if (bot.setControlState) {
                
                // CRITICAL FIX: Block manual movement if Anti-Idle is ON.
                if (isAntiIdleActive && control !== 'all') {
                    io.emit('bot_log', `Manual control rejected: ${control}. Anti-Idle is currently running.`);
                    return; // Ignore manual movement commands
                }

                // If the "STOP ALL" command is received, it will stop Anti-Idle first
                if (control === 'all' && state === false) {
                    stopAntiIdle();
                }
                
                bot.setControlState(control, state)
                io.emit('bot_log', `Control executed: ${control} set to ${state}`)
            } else {
                io.emit('bot_log', 'ERROR: Bot object not ready for control commands.')
            }
        })
        
        // LISTENER 3: ANTI-IDLE TOGGLE COMMAND
        socket.on('anti_idle_command', (state) => {
            if (state === 'start') {
                stopAntiIdle(); // Clean slate before starting
                startAntiIdle();
            } else if (state === 'stop') {
                stopAntiIdle();
            }
        })

        socket.on('disconnect', () => {
            console.log('A web client disconnected.')
            io.emit('bot_log', 'Web client disconnected.')
        })
    })

    bot.on('kicked', console.log)
    bot.on('error', console.log)
    bot.on('end', () => {
        stopAntiIdle(); 
        createBot();
    })
}

createBot()
