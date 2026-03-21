FROM node:20-alpine

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (this also runs npm run build via postinstall)
RUN npm ci

# Copy source files
COPY src/ ./src/
COPY auth.ts ./

# Build TypeScript
RUN npm run build

# Create data directory for SQLite
RUN mkdir -p /data && chmod 777 /data

# Set data directory to /data for persistence (Railway volume mount)
ENV DB_PATH=/data/rose.db

EXPOSE 3000

CMD ["node", "dist/src/bot.js"]
