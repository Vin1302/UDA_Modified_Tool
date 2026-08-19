FROM node:20-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY . .
RUN mkdir -p output uploads
EXPOSE 5000
CMD ["node", "server.js"]
