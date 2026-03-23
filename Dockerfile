# Multi-stage build for production optimization
FROM node:18-alpine AS builder

# Set working directory
WORKDIR /app

# Copy package files (root + Vite admin app)
COPY package*.json ./
COPY apps/admin-dashboard/package*.json ./apps/admin-dashboard/

# Install dependencies (admin UI + Nest)
RUN npm ci && npm cache clean --force
RUN cd apps/admin-dashboard && npm ci && npm cache clean --force

# Copy source code
COPY . .

# Build admin SPA into src/public/dashboard, then Nest (copies public to dist)
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nestjs -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder --chown=nestjs:nodejs /app/dist ./dist

# Switch to non-root user
USER nestjs

# Expose port
EXPOSE 3000

# Health check (copy script from source since it's plain JS)
COPY --from=builder --chown=nestjs:nodejs /app/src/health-check.js ./dist/health-check.js
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node dist/health-check.js || exit 1

# Start the application
ENTRYPOINT ["dumb-init", "--"]
# Note: TS builds emit into dist/src when multiple TS roots are compiled.
# Run the compiled entry file accordingly.
CMD ["node", "dist/main"]
