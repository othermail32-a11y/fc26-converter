# Use Node.js with FFmpeg pre-installed
FROM node:20-bullseye-slim

# Install FFmpeg natively — this is what makes it 10-50x faster than browser FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy server code
COPY server.js ./

# Create temp directories
RUN mkdir -p /tmp/uploads /tmp/outputs

# Expose port
EXPOSE 3000

# Start server
CMD ["node", "server.js"]
