#!/bin/bash

# This script starts the Email Automation tool.
# Just double-click this file to run it.

cd "$(dirname "$0")"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo ""
    echo "============================================"
    echo "  Node.js is not installed!"
    echo "  Please download and install it from:"
    echo "  https://nodejs.org"
    echo "  (Click the big green LTS button)"
    echo "  Then double-click this file again."
    echo "============================================"
    echo ""
    read -p "Press Enter to close..."
    exit 1
fi

echo "Installing dependencies (first time only)..."
npm install --silent 2>/dev/null

echo ""
echo "Starting Email Automation..."
echo "Opening your browser..."
echo ""

# Open browser after a short delay
(sleep 2 && open "http://localhost:3000") &

npx tsx server.ts
