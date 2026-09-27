#!/bin/bash
# Exit on error
set -e

# Start the Python ML microservice in the background
echo "Starting Python ML service on port ${PYTHON_PORT}..."
cd /app/python_ml
uvicorn main:app --host 0.0.0.0 --port ${PYTHON_PORT} &

# Wait for a few seconds to let Python service start
sleep 3

# Start the Node API Gateway in the foreground
echo "Starting Node API Gateway on port ${PORT}..."
cd /app/node_gateway
node server.js
