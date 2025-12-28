#!/bin/bash

# Quick script to update dependencies on VPS
# Run this script on your VPS after uploading new files

echo "🔄 Updating EAI Detection System Dependencies"
echo "=============================================="

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Navigate to app directory
if [ -d "/var/www/eai" ]; then
    cd /var/www/eai
elif [ -d "/root/eai" ]; then
    cd /root/eai
else
    print_error "Cannot find application directory"
    exit 1
fi

print_info "Working directory: $(pwd)"
echo ""

# Step 1: Update Node.js dependencies
print_info "Step 1: Updating Node.js dependencies..."
npm install --production
if [ $? -eq 0 ]; then
    print_success "Node.js dependencies updated"
else
    print_error "Failed to update Node.js dependencies"
fi
echo ""

# Step 2: Update Python dependencies in virtual environment
print_info "Step 2: Updating Python dependencies..."
if [ -d "venv" ]; then
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt --upgrade
    deactivate
    print_success "Python dependencies updated in virtual environment"
else
    print_error "Virtual environment not found! Creating one..."
    python3 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    deactivate
    print_success "Virtual environment created and dependencies installed"
fi
echo ""

# Step 3: Recreate wrapper scripts to ensure they use venv
print_info "Step 3: Updating Python wrapper scripts..."
cat > detect_wrapper.sh << 'EOF'
#!/bin/bash
# Navigate to application directory
cd /var/www/eai

# Activate virtual environment
source venv/bin/activate

# Run Python script with all arguments
python3 detect.py "$@"
EOF

cat > detect_live_wrapper.sh << 'EOF'
#!/bin/bash
# Navigate to application directory
cd /var/www/eai

# Activate virtual environment
source venv/bin/activate

# Run Python script with all arguments
python3 detect_live.py "$@"
EOF

chmod +x detect_wrapper.sh detect_live_wrapper.sh
print_success "Python wrapper scripts updated"
echo ""

# Step 4: Restart application
print_info "Step 4: Restarting application..."
if command -v pm2 &> /dev/null; then
    pm2 restart eai-detection
    if [ $? -eq 0 ]; then
        print_success "Application restarted"
    else
        print_error "Failed to restart application"
    fi
else
    print_error "PM2 not found. Please restart manually."
fi
echo ""

echo "=============================================="
print_success "Dependencies update completed!"
echo "=============================================="
echo ""
print_info "Check application status: pm2 status"
print_info "View logs: pm2 logs eai-detection"
print_info "Monitor errors: pm2 logs eai-detection --err"
echo ""
