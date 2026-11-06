FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm install
CMD ["npx", "tsx", "services/coordinator/src/index.ts"]
