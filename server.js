const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const socketIO = require('socket.io');
const multer = require('multer');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const cors = require('cors');
const os = require('os');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Logging control - set to false to only show errors
const SHOW_LOGS = process.env.SHOW_LOGS === 'true' || process.env.NODE_ENV !== 'production';
const log = (...args) => SHOW_LOGS && console.log(...args);

// Socket.IO for receiving processed frames in browser
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    path: '/socket.io/',
    transports: ['websocket', 'polling']
});

// WebSocket Server for browser client connections (separate from Socket.IO)
const wss = new WebSocket.Server({ 
    noServer: true  // We'll handle upgrade manually
});

const PORT = process.env.PORT || 5010;
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE) || 100 * 1024 * 1024; // 100MB default

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Custom video streaming handler for uploads
app.get('/uploads/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    streamVideo(filePath, req, res);
});

// Custom video streaming handler for output
app.get('/output/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'output', req.params.filename);
    streamVideo(filePath, req, res);
});

// Video streaming function with Range support
function streamVideo(filePath, req, res) {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;

    // Set content type based on extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.mp4' ? 'video/mp4' : 
                       ext === '.avi' ? 'video/x-msvideo' :
                       ext === '.mov' ? 'video/quicktime' : 
                       'application/octet-stream';

    if (range) {
        // Handle range request for video seeking
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(filePath, { start, end });
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
        };
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        // No range requested, send entire file
        const head = {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
        };
        res.writeHead(200, head);
        fs.createReadStream(filePath).pipe(res);
    }
}

// Create necessary directories
['uploads', 'output'].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir);
    }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|mp4|avi|mov|mkv/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and videos are allowed!'));
        }
    }
});

// Performance optimization - reduce CPU usage
if (process.env.NODE_ENV === 'production') {
    process.env.OMP_NUM_THREADS = '2'; // Limit OpenMP threads
    process.env.MKL_NUM_THREADS = '2'; // Limit MKL threads
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get local IP address for phone connection
app.get('/api/local-ip', (req, res) => {
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        }
    }
    
    res.json({ 
        addresses,
        websocketUrl: addresses.length > 0 ? `ws://${addresses[0]}:5000?type=phone` : null
    });
});

app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const inputPath = req.file.path;
    const outputFilename = 'processed_' + req.file.filename;
    const outputPath = path.join('output', outputFilename);

    log('[SERVER] Processing file:', inputPath);

    // Determine Python command based on environment
    const pythonCmd = process.env.NODE_ENV === 'production' 
        ? path.join(__dirname, 'detect_wrapper.sh')
        : 'python';
    const pythonArgs = process.env.NODE_ENV === 'production'
        ? [inputPath, outputPath]
        : ['detect.py', inputPath, outputPath];

    // Call Python script
    const pythonProcess = spawn(pythonCmd, pythonArgs);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        const message = data.toString();
        log('[PYTHON]', message);
        outputData += message;
    });

    pythonProcess.stderr.on('data', (data) => {
        const message = data.toString();
        console.error('[PYTHON ERROR]', message);
        errorData += message;
    });

    pythonProcess.on('close', (code) => {
        if (code !== 0) {
            console.error('[SERVER] Python process exited with code', code);
            return res.status(500).json({
                error: 'Processing failed',
                details: errorData || 'Unknown error occurred'
            });
        }

        // Check if output file exists
        if (!fs.existsSync(outputPath)) {
            return res.status(500).json({
                error: 'Output file not generated',
                details: outputData
            });
        }

        log('[SERVER] Processing completed successfully');
        
        // Parse detection results from output
        const lines = outputData.split('\n');
        let stats = {
            totalFrames: 0,
            petAlerts: 0,
            humansDetected: 0
        };

        lines.forEach(line => {
            if (line.includes('Total frames:')) {
                stats.totalFrames = parseInt(line.match(/\d+/)[0]);
            }
            if (line.includes('Pet alerts:')) {
                stats.petAlerts = parseInt(line.match(/\d+/)[0]);
            }
            if (line.includes('Humans detected:')) {
                stats.humansDetected = parseInt(line.match(/\d+/)[0]);
            }
        });

        res.json({
            success: true,
            originalFile: req.file.filename,
            outputFile: outputFilename,
            outputUrl: `/output/${outputFilename}`,
            fileType: req.file.mimetype.startsWith('image') ? 'image' : 'video',
            stats: stats
        });
    });
});

// Get list of processed files
app.get('/files', (req, res) => {
    const outputDir = 'output';
    fs.readdir(outputDir, (err, files) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to read output directory' });
        }
        
        const fileList = files.map(file => ({
            name: file,
            url: `/output/${file}`,
            type: /\.(jpg|jpeg|png|gif)$/i.test(file) ? 'image' : 'video'
        }));
        
        res.json(fileList);
    });
});

// Delete file
app.delete('/delete/:filename', (req, res) => {
    const filename = req.params.filename;
    const outputPath = path.join('output', filename);
    
    fs.unlink(outputPath, (err) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to delete file' });
        }
        res.json({ success: true, message: 'File deleted successfully' });
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err.stack);
    res.status(500).json({ error: err.message });
});

// WebSocket connection for live video streaming
let phoneConnection = null; // Direct phone connection
let externalPhoneStream = null; // Connection to external phone stream server
let browserClients = new Set(); // Connected browser clients

// Connect to external phone stream server
function connectToExternalPhoneStream() {
    if (externalPhoneStream && externalPhoneStream.readyState === WebSocket.OPEN) {
        log('⚠️ Already connected to external phone stream');
        return;
    }

    log('\n🔌 Connecting to external phone stream: wss://phone-stream.onrender.com');
    
    try {
        externalPhoneStream = new WebSocket('wss://phone-stream.onrender.com');
        externalPhoneStream.binaryType = 'arraybuffer';

        externalPhoneStream.on('open', () => {
            log('✅ Connected to external phone stream server!');
            io.emit('phone_connected', { message: 'External phone stream connected' });
            broadcastToBrowsers({ type: 'phone_connected', message: 'Phone connected' });
        });

        externalPhoneStream.on('message', (data, isBinary) => {
            if (isBinary) {
                log(`\n📸 FRAME RECEIVED from external phone: ${data.byteLength || data.length} bytes`);
                const buffer = Buffer.from(data);
                processLiveFrame(buffer);
            } else {
                const message = data.toString();
                log('📱 External phone text message:', message);
            }
        });

        externalPhoneStream.on('error', (error) => {
            console.error('❌ External phone stream error:', error.message);
        });

        externalPhoneStream.on('close', () => {
            log('\n📴 External phone stream DISCONNECTED');
            externalPhoneStream = null;
            io.emit('phone_disconnected', { message: 'Phone stream disconnected' });
            broadcastToBrowsers({ type: 'phone_disconnected', message: 'Phone disconnected' });
        });
    } catch (error) {
        console.error('❌ Failed to connect to external phone stream:', error);
    }
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const clientType = url.searchParams.get('type');

    log(`\n📡 NEW CONNECTION - Type: ${clientType || 'browser'}`);

    if (clientType === 'phone') {
        // Phone connecting directly to this server
        phoneConnection = ws;
        log('✅ PHONE CONNECTED!');
        log(`📱 Phone IP: ${req.socket.remoteAddress}`);
        
        // Notify all browser clients that phone is connected
        io.emit('phone_connected', { message: 'Phone stream connected' });
        broadcastToBrowsers({ type: 'phone_connected', message: 'Phone connected' });
        
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                log(`\n� FRAME RECEIVED from phone: ${data.length} bytes`);
                processLiveFrame(data);
            } else {
                const message = data.toString();
                log('� Phone text message:', message);
            }
        });
        
        ws.on('close', () => {
            log('\n� PHONE DISCONNECTED');
            phoneConnection = null;
            io.emit('phone_disconnected', { message: 'Phone disconnected' });
            broadcastToBrowsers({ type: 'phone_disconnected', message: 'Phone disconnected' });
        });
        
        ws.on('error', (error) => {
            console.error('❌ Phone connection error:', error);
        });
    } else {
        // Browser client connecting to view processed stream
        browserClients.add(ws);
        log(`✅ Browser client connected. Total: ${browserClients.size}`);
        
        // Send current phone connection status
        const phoneConnected = phoneConnection !== null && phoneConnection.readyState === WebSocket.OPEN;
        ws.send(JSON.stringify({ 
            type: 'status', 
            phoneConnected: phoneConnected 
        }));

        ws.on('close', () => {
            browserClients.delete(ws);
            log(`� Browser disconnected. Remaining: ${browserClients.size}`);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                log(`📩 Browser message:`, message);
                
                // Handle connect/disconnect requests
                if (message.type === 'connect_phone') {
                    log('🔌 Browser requested external phone connection');
                    connectToExternalPhoneStream();
                } else if (message.type === 'disconnect_phone') {
                    log('⏹️ Browser requested phone disconnection');
                    if (externalPhoneStream) {
                        externalPhoneStream.close();
                        externalPhoneStream = null;
                    }
                }
            } catch (err) {
                console.error('❌ Error parsing browser message:', err);
            }
        });
    }

    ws.on('error', (error) => {
        console.error('❌ WebSocket error:', error);
    });
});

// Process live video frame with YOLO detection
let processingQueue = 0;
const MAX_QUEUE = 3; // Allow up to 3 concurrent frames - balanced performance
let lastProcessedTime = 0;
const MIN_FRAME_INTERVAL = 200; // Process max 5 frames per second (200ms interval)
let activeProcesses = new Set(); // Track active Python processes

function processLiveFrame(frameData) {
    const now = Date.now();
    
    // Skip if processing or too soon since last frame
    if (processingQueue >= MAX_QUEUE) {
        log(`⏭️ Skipping frame (queue full: ${processingQueue})`);
        return;
    }
    
    // Emergency check: if way too many active processes, skip
    if (activeProcesses.size >= 10) {
        log(`🚨 EMERGENCY: Too many active processes (${activeProcesses.size}), skipping frame`);
        return;
    }
    
    if (now - lastProcessedTime < MIN_FRAME_INTERVAL) {
        log(`⏭️ Skipping frame (too soon: ${now - lastProcessedTime}ms)`);
        return;
    }
    
    lastProcessedTime = now;
    processingQueue++;
    log(`\n🔄 PROCESSING FRAME START (Queue: ${processingQueue})`);
    log(`   Frame size: ${frameData.length} bytes`);
    
    // Save frame temporarily with unique name
    const timestamp = Date.now();
    const tempFramePath = path.join(__dirname, `temp_frame_${timestamp}.jpg`);
    
    try {
        fs.writeFileSync(tempFramePath, frameData);
        log(`   ✅ Frame saved to temp file`);
    } catch (err) {
        console.error('   ❌ Error saving frame:', err);
        return;
    }

    // Spawn Python process to detect objects in this frame
    log(`   🐍 Launching Python detection...`);
    
    // Determine Python command based on environment
    let pythonCmd, pythonArgs;
    if (process.env.NODE_ENV === 'production') {
        pythonCmd = path.join(__dirname, 'detect_live_wrapper.sh');
        pythonArgs = [tempFramePath];
    } else {
        // Use system Python (has all packages installed)
        pythonCmd = 'python';
        pythonArgs = ['detect_live.py', tempFramePath];
        log(`   🐍 Using Python: ${pythonCmd}`);
    }
    
    const pythonProcess = spawn(pythonCmd, pythonArgs);
    activeProcesses.add(pythonProcess.pid); // Track this process

    let resultData = '';
    let errorData = '';
    
    // Set timeout to kill process if it takes too long
    const processTimeout = setTimeout(() => {
        if (pythonProcess && !pythonProcess.killed) {
            log(`   ⏱️ Process timeout, killing...`);
            pythonProcess.kill('SIGTERM');
            activeProcesses.delete(pythonProcess.pid);
            // Don't decrement queue here - let close handler do it
        }
    }, 10000); // 10 second timeout

    pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        errorData += msg;
        // Only log actual errors, not warnings
        if (!msg.includes('UserWarning')) {
            console.error('   ⚠️ Python stderr:', msg);
        }
    });
    
    pythonProcess.on('error', (err) => {
        console.error('   ❌ Failed to spawn Python process:', err.message);
        clearTimeout(processTimeout);
        activeProcesses.delete(pythonProcess.pid);
        processingQueue--;
        // Cleanup temp file
        try {
            if (fs.existsSync(tempFramePath)) fs.unlinkSync(tempFramePath);
        } catch (e) {}
    });

    pythonProcess.on('close', (code) => {
        clearTimeout(processTimeout); // Clear timeout
        activeProcesses.delete(pythonProcess.pid); // Remove from tracking
        log(`   🐍 Python finished (exit code: ${code})`);
        
        if (code === 0 && fs.existsSync(tempFramePath)) {
            // Read processed frame and send to all connected clients
            const processedFrame = fs.readFileSync(tempFramePath);
            log(`   📤 Broadcasting to ${browserClients.size} browser clients + Socket.IO`);
            
            // Send via WebSocket to browser clients
            let sentCount = 0;
            browserClients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(processedFrame, { binary: true });
                    sentCount++;
                }
            });
            log(`   ✅ Sent to ${sentCount} WebSocket clients`);

            // Also emit via Socket.IO (as base64 for JSON compatibility)
            const base64Frame = processedFrame.toString('base64');
            const socketCount = io.engine.clientsCount;
            log(`   📡 Emitting 'frame' to ${socketCount} Socket.IO clients (${base64Frame.length} chars base64)`);
            io.emit('frame', { image: base64Frame });

            // Parse and broadcast detection info
            try {
                const detections = JSON.parse(resultData);
                log(`   🎯 DETECTIONS: Pets=${detections.pets}, Humans=${detections.humans}`);
                if (detections.detections && detections.detections.length > 0) {
                    log(`      Objects found:`, detections.detections.map(d => `${d.label}(${(d.confidence*100).toFixed(0)}%)`).join(', '));
                }
                
                // Broadcast detection results
                broadcastToBrowsers({ type: 'detections', data: detections });
                io.emit('prediction', detections);
            } catch (err) {
                log('   ⚠️ Could not parse detection JSON:', resultData);
            }
        } else {
            console.error(`   ❌ Processing failed!`);
            if (code !== 0) {
                console.error(`      Exit code: ${code}`);
                console.error(`      Python stdout: ${resultData || '(empty)'}`);
                console.error(`      Python stderr: ${errorData || '(empty)'}`);
            }
            if (!fs.existsSync(tempFramePath)) console.error(`      Temp file missing`);
        }

        // Cleanup
        try {
            if (fs.existsSync(tempFramePath)) {
                fs.unlinkSync(tempFramePath);
                log(`   🧹 Temp file cleaned up`);
            }
        } catch (err) {
            console.error('   ⚠️ Could not delete temp file:', err);
        }
        
        processingQueue--;
        log(`🔄 PROCESSING COMPLETE (Queue: ${processingQueue})\n`);
    });
}

// Broadcast message to all connected browser WebSocket clients
function broadcastToBrowsers(message) {
    const data = JSON.stringify(message);
    browserClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

// Socket.IO for live phone streaming
io.on('connection', (socket) => {
    log('🌐 Socket.IO client connected:', socket.id);
    
    // Send current phone connection status
    const phoneConnected = phoneConnection !== null && phoneConnection.readyState === WebSocket.OPEN;
    socket.emit('status', { phoneConnected });
    
    socket.on('disconnect', () => {
        log('📴 Socket.IO client disconnected:', socket.id);
        
        // Emergency cleanup: Kill any stuck processes
        if (activeProcesses.size > 0) {
            log(`   ⚠️ Cleaning up ${activeProcesses.size} active processes...`);
            activeProcesses.forEach(pid => {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch (err) {
                    // Process might already be dead
                }
            });
            activeProcesses.clear();
            processingQueue = 0;
        }
    });
});

// Handle WebSocket upgrade separately from Socket.IO
server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    
    // Socket.IO handles its own upgrades, so only handle non-Socket.IO WebSocket connections
    if (pathname !== '/socket.io/') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    }
});

server.listen(PORT, () => {
    log(`🚀 Server running at http://localhost:${PORT}`);
    log(`🌐 WebSocket server ready for live streaming`);
    log(`📁 Upload folder: ${path.join(__dirname, 'uploads')}`);
    log(`📁 Output folder: ${path.join(__dirname, 'output')}`);
    
    // Display local IP addresses for phone connection
    const interfaces = os.networkInterfaces();
    log('\n📱 For direct phone connection, use:');
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                log(`   ws://${iface.address}:${PORT}?type=phone`);
            }
        }
    }
    log('');
    
    // Auto-connect to external phone stream
    log('🔄 Auto-connecting to external phone stream...');
    setTimeout(() => {
        connectToExternalPhoneStream();
    }, 2000);
});
