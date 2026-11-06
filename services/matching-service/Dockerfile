FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["npx", "tsx", "services/matching-service/src/index.ts"]
