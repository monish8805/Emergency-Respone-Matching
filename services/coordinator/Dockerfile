FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
# Runs as the unprivileged "node" user (uid 1000). Nothing here needs to write to /app.
USER node
CMD ["npx", "tsx", "services/coordinator/src/index.ts"]
