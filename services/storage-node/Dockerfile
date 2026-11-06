FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["npx", "tsx", "services/storage-node/src/index.ts"]
