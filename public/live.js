// Live Feed WebSocket Handler
let ws = null;
let socket = null; // Socket.IO connection
let isConnected = false;
let frameCount = 0;
let lastFrameTime = Date.now();
let fps = 0;

// DOM Elements - will be initialized after DOM loads
let connectPhoneBtn, disconnectPhoneBtn, connectionStatus;
let liveCanvas, noStreamMessage, ctx;
let livePetsCount, liveHumansCount, liveFPS, detectionLog;

// Initialize when DOM is ready
function initLiveFeed() {
    // Get DOM Elements
    connectPhoneBtn = document.getElementById('connectPhoneBtn');
    disconnectPhoneBtn = document.getElementById('disconnectPhoneBtn');
    const testConnectionBtn = document.getElementById('testConnectionBtn');
    connectionStatus = document.getElementById('connectionStatus');
    liveCanvas = document.getElementById('liveCanvas');
    noStreamMessage = document.getElementById('noStreamMessage');
    livePetsCount = document.getElementById('livePetsCount');
    liveHumansCount = document.getElementById('liveHumansCount');
    liveFPS = document.getElementById('liveFPS');
    detectionLog = document.getElementById('detectionLog');

    // Check if elements exist
    if (!connectPhoneBtn || !liveCanvas) {
        console.error('❌ Live feed elements not found in DOM');
        return;
    }

    ctx = liveCanvas.getContext('2d');

    // Event Listeners
    connectPhoneBtn.addEventListener('click', connectToPhone);
    disconnectPhoneBtn.addEventListener('click', disconnectFromPhone);
    testConnectionBtn.addEventListener('click', testConnection);

    // Fetch and display local IP
    fetchLocalIP();
    
    // Initialize Socket.IO for receiving predictions
    initSocketIO();

    console.log('✅ Live feed initialized');
}

function initSocketIO() {
    // Connect Socket.IO to receive processed frames
    socket = io();
    
    socket.on('connect', () => {
        console.log('✅ Socket.IO connected:', socket.id);
        addLogEntry('Connected to server', 'info');
    });
    
    socket.on('phone_connected', (data) => {
        console.log('📱 Phone stream connected');
        isConnected = true;
        updateConnectionStatus('streaming');
        noStreamMessage.style.display = 'none';
        addLogEntry('📱 Phone stream connected', 'info');
        document.getElementById('phoneStreamStatus').textContent = '✅ Connected';
        document.getElementById('phoneStreamStatus').style.color = 'var(--success-color)';
    });
    
    socket.on('phone_disconnected', (data) => {
        console.log('📴 Phone stream disconnected');
        isConnected = false;
        updateConnectionStatus('disconnected');
        addLogEntry('📴 Phone stream disconnected', 'warning');
        document.getElementById('phoneStreamStatus').textContent = '❌ Disconnected';
        document.getElementById('phoneStreamStatus').style.color = 'var(--danger-color)';
    });
    
    // Receive processed frames from server
    socket.on('frame', (data) => {
        console.log('📩 Frame received via Socket.IO', data ? 'with data' : 'NO DATA');
        
        if (data && data.image) {
            console.log(`   Converting base64 image (${data.image.length} chars)`);
            try {
                // Convert base64 to blob and display
                const imageData = Uint8Array.from(atob(data.image), c => c.charCodeAt(0));
                console.log(`   Converted to ${imageData.length} bytes`);
                const blob = new Blob([imageData], { type: 'image/jpeg' });
                console.log(`   Created blob, calling displayFrame...`);
                displayFrame(blob);
            } catch (err) {
                console.error('   ❌ Error converting frame:', err);
            }
        } else {
            console.warn('   ⚠️ Frame data is missing or invalid');
        }
    });
    
    socket.on('prediction', (data) => {
        console.log('📩 Prediction received via Socket.IO:', data);
        
        // Update stats
        if (data.pets !== undefined && data.humans !== undefined) {
            livePetsCount.textContent = data.pets;
            liveHumansCount.textContent = data.humans;
            
            if (data.detections && data.detections.length > 0) {
                data.detections.forEach(det => {
                    const emoji = det.type === 'pet' ? '🐾' : '👤';
                    const message = `${emoji} ${det.label} detected (${(det.confidence * 100).toFixed(1)}%)`;
                    addLogEntry(message, det.type);
                });
            }
        }
    });
    
    socket.on('error', (data) => {
        console.error('❌ Server error:', data.message);
        addLogEntry(`❌ Error: ${data.message}`, 'error');
    });
    
    socket.on('disconnect', () => {
        console.log('❌ Socket.IO disconnected');
        isConnected = false;
        updateConnectionStatus('disconnected');
    });
}

async function fetchLocalIP() {
    try {
        const response = await fetch('/api/local-ip');
        const data = await response.json();
        
        if (data.websocketUrl) {
            console.log('🌐 Local IP addresses:', data.addresses);
            console.log('📱 Phone should connect to:', data.websocketUrl);
            
            // Update UI with the connection URL
            const directUrlEl = document.getElementById('directConnectionUrl');
            if (directUrlEl) {
                directUrlEl.textContent = data.websocketUrl;
                directUrlEl.style.cursor = 'pointer';
                directUrlEl.onclick = () => {
                    navigator.clipboard.writeText(data.websocketUrl)
                        .then(() => {
                            directUrlEl.textContent = '✅ Copied!';
                            setTimeout(() => {
                                directUrlEl.textContent = data.websocketUrl;
                            }, 2000);
                        });
                };
            }
        }
    } catch (err) {
        console.error('Failed to fetch local IP:', err);
    }
}

function testConnection() {
    console.log('🧪 Testing WebSocket connection...');
    
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const testWs = new WebSocket(`${protocol}//${location.host}?type=browser`);
    
    testWs.onopen = () => {
        console.log('✅ Test: WebSocket connection successful!');
        addLogEntry('✅ WebSocket test: Connection successful', 'info');
        testWs.close();
    };
    
    testWs.onerror = (error) => {
        console.error('❌ Test: WebSocket connection failed', error);
        addLogEntry('❌ WebSocket test: Connection failed', 'error');
        alert('WebSocket test failed! Make sure:\n1. Server is running\n2. No firewall blocking connections\n3. Check browser console for errors');
    };
    
    testWs.onclose = () => {
        console.log('🔚 Test connection closed');
    };
}

// Wait for DOM to be fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLiveFeed);
} else {
    initLiveFeed();
}

function connectToPhone() {
    if (isConnected) {
        console.log('⚠️ Already connected');
        return;
    }

    console.log('🔌 Requesting connection to phone stream...');

    try {
        // Send request via WebSocket to connect to phone stream server
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}?type=browser`);
        
        console.log('📡 WebSocket object created');

        ws.onopen = () => {
            console.log('✅ Connected to detection server');
            updateConnectionStatus('connected');
            
            // Request connection to phone stream
            const message = JSON.stringify({ type: 'connect_phone' });
            console.log('📤 Sending:', message);
            ws.send(message);
        };

        ws.onmessage = (event) => {
            if (typeof event.data === 'string') {
                // Text message (status updates)
                try {
                    const message = JSON.parse(event.data);
                    console.log('📩 WebSocket message:', message);
                    handleMessage(message);
                } catch (err) {
                    console.log('Server message:', event.data);
                }
            } else {
                // Binary data (processed video frame)
                console.log('📩 Binary frame received');
                displayFrame(event.data);
            }
        };

        ws.onerror = (error) => {
            console.error('❌ WebSocket error:', error);
            updateConnectionStatus('error');
            alert('Failed to connect to detection server. Make sure the server is running.');
        };

        ws.onclose = (event) => {
            console.log('📴 Disconnected from server. Code:', event.code, 'Reason:', event.reason);
            updateConnectionStatus('disconnected');
            isConnected = false;
            ws = null;
        };
    } catch (error) {
        console.error('❌ Failed to create WebSocket:', error);
        alert('Failed to create WebSocket connection: ' + error.message);
    }
}

function disconnectFromPhone() {
    if (ws) {
        ws.send(JSON.stringify({ type: 'disconnect_phone' }));
        ws.close();
        ws = null;
    }
    
    isConnected = false;
    updateConnectionStatus('disconnected');
    
    // Clear canvas
    ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
    noStreamMessage.style.display = 'block';
}

function handleMessage(message) {
    console.log('📨 Handling message:', message);
    
    switch (message.type) {
        case 'connected':
            console.log(message.message);
            break;
            
        case 'phone_connected':
            isConnected = true;
            updateConnectionStatus('streaming');
            noStreamMessage.style.display = 'none';
            addLogEntry('📱 Phone stream connected', 'info');
            document.getElementById('phoneStreamStatus').textContent = '✅ Connected';
            document.getElementById('phoneStreamStatus').style.color = 'var(--success-color)';
            break;
            
        case 'phone_disconnected':
            isConnected = false;
            updateConnectionStatus('disconnected');
            addLogEntry('📴 Phone stream disconnected', 'warning');
            document.getElementById('phoneStreamStatus').textContent = '❌ Disconnected';
            document.getElementById('phoneStreamStatus').style.color = 'var(--danger-color)';
            break;
            
        case 'detections':
            updateDetectionStats(message.data);
            break;
            
        case 'error':
            console.error('Server error:', message.message);
            addLogEntry(`❌ Error: ${message.message}`, 'error');
            alert(`Connection Error: ${message.message}\n\nCheck if your phone is streaming to https://phone-stream.onrender.com`);
            break;
            
        case 'phone_message':
            console.log('📱 Phone message:', message.message);
            addLogEntry(`📱 ${message.message}`, 'info');
            break;
    }
}

function displayFrame(imageData) {
    console.log(`🖼️ Displaying frame: ${imageData.size} bytes`);
    
    // Verify canvas and context exist
    if (!liveCanvas || !ctx) {
        console.error('❌ Canvas or context is null! Reinitializing...');
        liveCanvas = document.getElementById('liveCanvas');
        if (liveCanvas) {
            ctx = liveCanvas.getContext('2d');
            console.log('✅ Canvas reinitialized');
        } else {
            console.error('❌ Cannot find canvas element!');
            return;
        }
    }
    
    // Check if Live Feed tab is visible
    const liveTab = document.getElementById('live-tab');
    if (liveTab && window.getComputedStyle(liveTab).display === 'none') {
        console.warn('⚠️ Live Feed tab is not active! Please switch to Live Feed tab.');
    }
    
    // FORCE show canvas and hide "no stream" message
    if (noStreamMessage) {
        noStreamMessage.style.display = 'none';
        console.log('   ✓ Hidden "no stream" message');
    }
    
    liveCanvas.style.display = 'block';
    liveCanvas.style.visibility = 'visible';
    liveCanvas.style.opacity = '1';
    liveCanvas.style.maxWidth = '100%';
    liveCanvas.style.height = 'auto';
    console.log('   ✓ Canvas visibility forced to visible');
    
    // Convert blob to image and display on canvas
    const blob = new Blob([imageData], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    
    const img = new Image();
    img.onload = () => {
        // Resize canvas to match image
        liveCanvas.width = img.width;
        liveCanvas.height = img.height;
        
        console.log(`✅ Frame loaded: ${img.width}x${img.height}`);
        console.log(`   Canvas dimensions: ${liveCanvas.width}x${liveCanvas.height}`);
        console.log(`   Canvas display size: ${liveCanvas.clientWidth}x${liveCanvas.clientHeight}`);
        
        // Clear canvas first
        ctx.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
        
        // Draw image on canvas
        ctx.drawImage(img, 0, 0);
        console.log('   ✓ Image drawn on canvas successfully');
        
        // Verify the drawing
        const imageData = ctx.getImageData(0, 0, 10, 10);
        console.log(`   ✓ Canvas has data: ${imageData.data[0] !== undefined}`);
        
        // Clean up
        URL.revokeObjectURL(url);
        
        // Update FPS
        frameCount++;
        const now = Date.now();
        const elapsed = now - lastFrameTime;
        
        if (elapsed >= 1000) {
            fps = Math.round((frameCount * 1000) / elapsed);
            if (liveFPS) liveFPS.textContent = fps;
            console.log(`📊 FPS: ${fps}`);
            frameCount = 0;
            lastFrameTime = now;
        }
    };
    
    img.onerror = (err) => {
        console.error('❌ Error loading image:', err);
    };
    
    img.src = url;
}

function updateDetectionStats(data) {
    if (data.pets !== undefined) {
        livePetsCount.textContent = data.pets;
    }
    
    if (data.humans !== undefined) {
        liveHumansCount.textContent = data.humans;
    }
    
    // Log detections
    if (data.detections && data.detections.length > 0) {
        data.detections.forEach(det => {
            const emoji = det.type === 'pet' ? '🐾' : '👤';
            const message = `${emoji} ${det.label} detected (${(det.confidence * 100).toFixed(1)}%)`;
            addLogEntry(message, det.type);
        });
    }
}

function updateConnectionStatus(status) {
    connectPhoneBtn.style.display = status === 'disconnected' ? 'inline-block' : 'none';
    disconnectPhoneBtn.style.display = status !== 'disconnected' ? 'inline-block' : 'none';
    
    switch (status) {
        case 'connected':
            connectionStatus.textContent = '🟡 Connecting to phone...';
            connectionStatus.classList.remove('connected');
            break;
        case 'streaming':
            connectionStatus.textContent = '🟢 Live Streaming';
            connectionStatus.classList.add('connected');
            break;
        case 'disconnected':
            connectionStatus.textContent = '⚪ Not Connected';
            connectionStatus.classList.remove('connected');
            break;
        case 'error':
            connectionStatus.textContent = '🔴 Connection Error';
            connectionStatus.classList.remove('connected');
            break;
    }
}

function addLogEntry(message, type = 'info') {
    // Remove empty message if exists
    const emptyMsg = detectionLog.querySelector('.log-empty');
    if (emptyMsg) {
        emptyMsg.remove();
    }
    
    // Create new log entry
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    
    // Add to top of log
    detectionLog.insertBefore(entry, detectionLog.firstChild);
    
    // Keep only last 50 entries
    while (detectionLog.children.length > 50) {
        detectionLog.removeChild(detectionLog.lastChild);
    }
}

// Initialize
console.log('🚀 Live feed module loaded');
