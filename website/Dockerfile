# Production Dockerfile for PiCloud Digital Twin Dashboard
FROM node:20-alpine

# Install curl for container health check
RUN apk add --no-cache curl

WORKDIR /app

ENV NODE_ENV=production

# Copy package descriptors first to take advantage of Docker layer caching
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source files
COPY . .

# Run as non-root user
USER node

# Expose default HTTP port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fs http://localhost:3000/auth/me || exit 1

CMD ["node", "server.js"]

