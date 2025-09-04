# Dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && pnpm i --frozen-lockfile
COPY . .
EXPOSE 8787
CMD ["pnpm","tsx","server/server.ts"]
