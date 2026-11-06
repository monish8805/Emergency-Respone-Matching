FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["npx", "tsx", "services/request-service/src/index.ts"]
