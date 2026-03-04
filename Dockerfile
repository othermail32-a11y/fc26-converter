FROM node:20-bullseye-slim

# Install FFmpeg, Python, pip, twitch-dl and yt-dlp
RUN apt-get update && \
    apt-get install -y ffmpeg python3 python3-pip curl && \
    pip3 install twitch-dl yt-dlp --break-system-packages && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY server.js ./

RUN mkdir -p /tmp/uploads /tmp/outputs

EXPOSE 3000

CMD ["node", "server.js"]
