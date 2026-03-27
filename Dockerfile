FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3002

CMD ["npm", "start"]
