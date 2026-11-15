FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
RUN mkdir -p /data && chown node:node /data
# Runs as the unprivileged "node" user (uid 1000). Nothing here needs to write to /app.
USER node
CMD ["npx", "tsx", "services/storage-node/src/index.ts"]
