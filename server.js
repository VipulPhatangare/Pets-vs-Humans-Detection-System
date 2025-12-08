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

const app = express();
const server = http.createServer(app);

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

const PORT = 1000;

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
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
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

    console.log('[SERVER] Processing file:', inputPath);

    // Call Python script
    const pythonProcess = spawn('python', ['detect.py', inputPath, outputPath]);

    let outputData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        const message = data.toString();
        console.log('[PYTHON]', message);
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

        console.log('[SERVER] Processing completed successfully');
        
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
        console.log('⚠️ Already connected to external phone stream');
        return;
    }

    console.log('\n🔌 Connecting to external phone stream: wss://phone-stream.onrender.com');
    
    try {
        externalPhoneStream = new WebSocket('wss://phone-stream.onrender.com');
        externalPhoneStream.binaryType = 'arraybuffer';

        externalPhoneStream.on('open', () => {
            console.log('✅ Connected to external phone stream server!');
            io.emit('phone_connected', { message: 'External phone stream connected' });
            broadcastToBrowsers({ type: 'phone_connected', message: 'Phone connected' });
        });

        externalPhoneStream.on('message', (data, isBinary) => {
            if (isBinary) {
                console.log(`\n📸 FRAME RECEIVED from external phone: ${data.byteLength || data.length} bytes`);
                const buffer = Buffer.from(data);
                processLiveFrame(buffer);
            } else {
                const message = data.toString();
                console.log('📱 External phone text message:', message);
            }
        });

        externalPhoneStream.on('error', (error) => {
            console.error('❌ External phone stream error:', error.message);
        });

        externalPhoneStream.on('close', () => {
            console.log('\n📴 External phone stream DISCONNECTED');
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

    console.log(`\n📡 NEW CONNECTION - Type: ${clientType || 'browser'}`);

    if (clientType === 'phone') {
        // Phone connecting directly to this server
        phoneConnection = ws;
        console.log('✅ PHONE CONNECTED!');
        console.log(`📱 Phone IP: ${req.socket.remoteAddress}`);
        
        // Notify all browser clients that phone is connected
        io.emit('phone_connected', { message: 'Phone stream connected' });
        broadcastToBrowsers({ type: 'phone_connected', message: 'Phone connected' });
        
        ws.on('message', (data, isBinary) => {
            if (isBinary) {
                console.log(`\n� FRAME RECEIVED from phone: ${data.length} bytes`);
                processLiveFrame(data);
            } else {
                const message = data.toString();
                console.log('� Phone text message:', message);
            }
        });
        
        ws.on('close', () => {
            console.log('\n� PHONE DISCONNECTED');
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
        console.log(`✅ Browser client connected. Total: ${browserClients.size}`);
        
        // Send current phone connection status
        const phoneConnected = phoneConnection !== null && phoneConnection.readyState === WebSocket.OPEN;
        ws.send(JSON.stringify({ 
            type: 'status', 
            phoneConnected: phoneConnected 
        }));

        ws.on('close', () => {
            browserClients.delete(ws);
            console.log(`� Browser disconnected. Remaining: ${browserClients.size}`);
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                console.log(`📩 Browser message:`, message);
                
                // Handle connect/disconnect requests
                if (message.type === 'connect_phone') {
                    console.log('🔌 Browser requested external phone connection');
                    connectToExternalPhoneStream();
                } else if (message.type === 'disconnect_phone') {
                    console.log('⏹️ Browser requested phone disconnection');
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
const MAX_QUEUE = 3; // Only process 3 frames at a time

function processLiveFrame(frameData) {
    // Skip if too many frames are being processed
    if (processingQueue >= MAX_QUEUE) {
        console.log(`⏭️ Skipping frame (queue full: ${processingQueue})`);
        return;
    }
    
    processingQueue++;
    console.log(`\n🔄 PROCESSING FRAME START (Queue: ${processingQueue})`);
    console.log(`   Frame size: ${frameData.length} bytes`);
    
    // Save frame temporarily with unique name
    const timestamp = Date.now();
    const tempFramePath = path.join(__dirname, `temp_frame_${timestamp}.jpg`);
    
    try {
        fs.writeFileSync(tempFramePath, frameData);
        console.log(`   ✅ Frame saved to temp file`);
    } catch (err) {
        console.error('   ❌ Error saving frame:', err);
        return;
    }

    // Spawn Python process to detect objects in this frame
    console.log(`   🐍 Launching Python detection...`);
    const pythonProcess = spawn('python', ['detect_live.py', tempFramePath]);

    let resultData = '';
    let errorData = '';

    pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
    });

    pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        console.error('   ⚠️ Python stderr:', data.toString());
    });

    pythonProcess.on('close', (code) => {
        console.log(`   🐍 Python finished (exit code: ${code})`);
        
        if (code === 0 && fs.existsSync(tempFramePath)) {
            // Read processed frame and send to all connected clients
            const processedFrame = fs.readFileSync(tempFramePath);
            console.log(`   📤 Broadcasting to ${browserClients.size} browser clients + Socket.IO`);
            
            // Send via WebSocket to browser clients
            let sentCount = 0;
            browserClients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(processedFrame, { binary: true });
                    sentCount++;
                }
            });
            console.log(`   ✅ Sent to ${sentCount} WebSocket clients`);

            // Also emit via Socket.IO (as base64 for JSON compatibility)
            const base64Frame = processedFrame.toString('base64');
            const socketCount = io.engine.clientsCount;
            console.log(`   📡 Emitting 'frame' to ${socketCount} Socket.IO clients (${base64Frame.length} chars base64)`);
            io.emit('frame', { image: base64Frame });

            // Parse and broadcast detection info
            try {
                const detections = JSON.parse(resultData);
                console.log(`   🎯 DETECTIONS: Pets=${detections.pets}, Humans=${detections.humans}`);
                if (detections.detections && detections.detections.length > 0) {
                    console.log(`      Objects found:`, detections.detections.map(d => `${d.label}(${(d.confidence*100).toFixed(0)}%)`).join(', '));
                }
                
                // Broadcast detection results
                broadcastToBrowsers({ type: 'detections', data: detections });
                io.emit('prediction', detections);
            } catch (err) {
                console.log('   ⚠️ Could not parse detection JSON:', resultData);
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
                console.log(`   🧹 Temp file cleaned up`);
            }
        } catch (err) {
            console.error('   ⚠️ Could not delete temp file:', err);
        }
        
        processingQueue--;
        console.log(`🔄 PROCESSING COMPLETE (Queue: ${processingQueue})\n`);
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
    console.log('🌐 Socket.IO client connected:', socket.id);
    
    // Send current phone connection status
    const phoneConnected = phoneConnection !== null && phoneConnection.readyState === WebSocket.OPEN;
    socket.emit('status', { phoneConnected });
    
    socket.on('disconnect', () => {
        console.log('📴 Socket.IO client disconnected:', socket.id);
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
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`🌐 WebSocket server ready for live streaming`);
    console.log(`📁 Upload folder: ${path.join(__dirname, 'uploads')}`);
    console.log(`📁 Output folder: ${path.join(__dirname, 'output')}`);
    
    // Display local IP addresses for phone connection
    const interfaces = os.networkInterfaces();
    console.log('\n📱 For direct phone connection, use:');
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                console.log(`   ws://${iface.address}:${PORT}?type=phone`);
            }
        }
    }
    console.log('');
    
    // Auto-connect to external phone stream
    console.log('🔄 Auto-connecting to external phone stream...');
    setTimeout(() => {
        connectToExternalPhoneStream();
    }, 2000);
});
