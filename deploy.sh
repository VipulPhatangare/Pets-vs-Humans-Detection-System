#!/bin/bash

# EAI Detection System - VPS Deployment Script
# For deployment on Hostinger VPS with domain: eai.synthomind.cloud

echo "🚀 EAI Detection System - VPS Deployment"
echo "=========================================="

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored messages
print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
    print_info "Running as root - this is acceptable for VPS deployment"
    USER="root"
else
    USER=$(whoami)
fi

# Variables
DOMAIN="eai.synthomind.cloud"
APP_DIR="/var/www/eai"

print_info "Deployment for domain: $DOMAIN"
print_info "Application directory: $APP_DIR"
print_info "User: $USER"
echo ""

# Step 1: Update system packages
print_info "Step 1: Updating system packages..."
sudo apt update && sudo apt upgrade -y
print_success "System updated"
echo ""

# Step 2: Install Node.js (using NodeSource)
print_info "Step 2: Installing Node.js 20.x..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs
    print_success "Node.js installed: $(node -v)"
else
    print_success "Node.js already installed: $(node -v)"
fi
echo ""

# Step 3: Install Python and pip
print_info "Step 3: Installing Python and pip..."
sudo apt install -y python3 python3-pip python3-venv
print_success "Python installed: $(python3 --version)"
echo ""

# Step 4: Install PM2 globally
print_info "Step 4: Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
    print_success "PM2 installed"
else
    print_success "PM2 already installed"
fi
echo ""

# Step 5: Install Nginx
print_info "Step 5: Installing Nginx..."
if ! command -v nginx &> /dev/null; then
    sudo apt install -y nginx
    print_success "Nginx installed"
else
    print_success "Nginx already installed"
fi
echo ""

# Step 6: Install Certbot for SSL
print_info "Step 6: Installing Certbot for SSL..."
sudo apt install -y certbot python3-certbot-nginx
print_success "Certbot installed"
echo ""

# Step 7: Create application directory
print_info "Step 7: Creating application directory..."
sudo mkdir -p $APP_DIR
sudo chown -R $USER:$USER $APP_DIR
print_success "Directory created: $APP_DIR"
echo ""

# Step 8: Copy files (assuming script is run from project directory)
print_info "Step 8: Copying application files..."
if [ -f "server.js" ]; then
    cp -r . $APP_DIR/
    print_success "Files copied to $APP_DIR"
else
    print_error "Please run this script from your project directory"
    exit 1
fi
cd $APP_DIR
echo ""

# Step 9: Install Node.js dependencies
print_info "Step 9: Installing Node.js dependencies..."
npm install --production
print_success "Node.js dependencies installed"
echo ""

# Step 10: Create Python virtual environment and install dependencies
print_info "Step 10: Setting up Python environment..."
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
deactivate
print_success "Python dependencies installed in virtual environment"
echo ""

# Step 11: Create necessary directories
print_info "Step 11: Creating necessary directories..."
mkdir -p uploads output logs
chmod 755 uploads output logs
print_success "Directories created"
echo ""

# Step 12: Create .env file if it doesn't exist
print_info "Step 12: Creating .env file..."
if [ ! -f ".env" ]; then
    cat > .env << EOF
PORT=5010
NODE_ENV=production
DOMAIN=$DOMAIN
MAX_FILE_SIZE=100000000
SHOW_LOGS=false
EOF
    print_success ".env file created"
else
    print_info ".env file already exists"
fi
echo ""

# Step 13: Update Python scripts to use virtual environment
print_info "Step 13: Creating wrapper scripts for Python..."
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
print_success "Python wrapper scripts created"
echo ""

# Step 14: Configure Nginx
print_info "Step 14: Configuring Nginx..."
sudo cp nginx.conf /etc/nginx/sites-available/$DOMAIN
sudo ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
print_success "Nginx configured"
echo ""

# Step 15: Obtain SSL certificate
print_info "Step 15: Obtaining SSL certificate..."
print_info "Make sure your domain $DOMAIN points to this server's IP address"
read -p "Press Enter to continue with SSL setup (or Ctrl+C to cancel)..."
sudo certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN || print_info "SSL setup can be completed manually later"
echo ""

# Step 16: Start application with PM2
print_info "Step 16: Starting application with PM2..."
pm2 delete eai-detection 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -n 1 | sudo bash
print_success "Application started with PM2"
echo ""

# Step 17: Configure firewall
print_info "Step 17: Configuring firewall..."
sudo ufw allow 'Nginx Full'
sudo ufw allow OpenSSH
sudo ufw --force enable
print_success "Firewall configured"
echo ""

# Final status check
echo ""
echo "=========================================="
print_success "Deployment completed successfully!"
echo "=========================================="
echo ""
print_info "Application URL: https://$DOMAIN"
print_info "PM2 Status: pm2 status"
print_info "View logs: pm2 logs eai-detection"
print_info "Nginx status: sudo systemctl status nginx"
echo ""
print_info "To restart the application:"
echo "  pm2 restart eai-detection"
echo ""
print_info "To update the application:"
echo "  cd $APP_DIR"
echo "  git pull (or copy new files)"
echo "  npm install --production"
echo "  source venv/bin/activate && pip install -r requirements.txt && deactivate"
echo "  pm2 restart eai-detection"
echo ""
