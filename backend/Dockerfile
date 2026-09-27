# Use a Python base image
FROM python:3.12-slim

# Install system dependencies, including curl for Node.js installation
RUN apt-get update && \
    apt-get install -y curl build-essential libpq-dev && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy python dependencies and install
COPY python_ml/requirements.txt ./python_ml/
RUN pip install --no-cache-dir -r python_ml/requirements.txt

# Copy node dependencies and install
COPY node_gateway/package*.json ./node_gateway/
RUN cd node_gateway && npm install

# Copy the rest of the application
COPY . .

# Ensure start script is executable and has Unix line endings
RUN sed -i 's/\r$//' /app/start.sh && chmod +x /app/start.sh

# Set environment variables for Render and internal routing
ENV PORT=3000
ENV PYTHON_PORT=8001
ENV PYTHON_SERVICE_URL=http://localhost:8001
ENV DISABLE_REDIS=true

# Expose the Render default port for the web service
EXPOSE 3000

# Start both services using the start script
CMD ["/app/start.sh"]
