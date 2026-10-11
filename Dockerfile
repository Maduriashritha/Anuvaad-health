FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3002
CMD ["node", "server.js"]
